import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { Api, Model, ResolvedGoogleThinkingLevel } from "@earendil-works/pi-ai";
import { CompatSchemasByApi } from "@earendil-works/pi-ai/providers/compat-schema";
import { compile } from "@earendil-works/pi-schema";
import { z } from "zod";
import { PATHS } from "../../config.ts";
import { setModelCatalogOverlay } from "../agent/models.ts";
import { AUTH_PROVIDER_KEYS } from "../core/auth-keys.ts";
import type { ModelCatalogRefreshOutcome } from "../core/contracts/models.ts";
import { writeFileAtomicSync } from "../store/atomic-write.ts";
import { keyValue } from "./keys.ts";
import { readBoundedJson } from "./custom-provider-body.ts";

const FILE = path.join(/* turbopackIgnore: true */ PATHS.data, "model-catalog.json");
const MAX_SHARD_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SHARD_ROWS = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

// Only the picker’s builtin API-key chat providers. Existing dynamic/connected
// routes (e.g. Radius, OAuth, Claude Code and user endpoints) are not pi.dev shards.
const keyProviders = new Set(AUTH_PROVIDER_KEYS.map(({ id }) => id));
const builtins = new Map(builtinProviders().flatMap((provider) => {
	const models = provider.getModels();
	return keyProviders.has(provider.id) && !provider.refreshModels && models.length > 0
		? [[provider.id, models] as const] : [];
}));

const id = z.string().min(1).max(256).regex(/^[\w.~:@-]+(?:\/[\w.~:@-]+)*$/)
	.refine((value) => !value.split("/").some((part) => part === "." || part === ".."));
const rate = z.number().min(0).max(1_000_000);
const rates = z.object({ input: rate, output: rate, cacheRead: rate, cacheWrite: rate });
const tokens = z.number().int().positive().max(100_000_000);
const thinking = z.string().max(32).regex(/^[\w-]*$/).nullable().optional();
const byteLimit = z.number().int().positive().max(1024 ** 3).optional();
const imageDimension = z.number().int().positive().max(8192).optional();
const imageCount = z.number().int().positive().max(10_000).optional();
const cacheSeconds = z.number().positive().max(30 * 24 * 3600).optional();
const rowSchema = z.object({
	type: z.literal("chat").optional(),
	id,
	name: z.string().trim().min(1).max(256).regex(/^[^\x00-\x1f\x7f]*$/),
	api: z.string(),
	baseUrl: z.string(),
	reasoning: z.boolean(),
	thinkingLevelMap: z.object({ off: thinking, minimal: thinking, low: thinking, medium: thinking, high: thinking, xhigh: thinking, max: thinking }).optional(),
	input: z.array(z.enum(["text", "image"])).min(1).max(2).refine((values) => values.includes("text") && new Set(values).size === values.length),
	inputLimits: z.strictObject({
		maxRequestBytes: byteLimit,
		images: z.strictObject({
			maxPerMessage: imageCount, maxPerRequest: imageCount,
			resize: z.strictObject({ maxWidth: imageDimension, maxHeight: imageDimension, maxBytes: byteLimit, jpegQuality: z.number().int().min(1).max(100).optional() }).optional(),
		}).optional(),
	}).optional(),
	promptCache: z.strictObject({ short: cacheSeconds, long: cacheSeconds }).optional(),
	cost: rates.extend({ tiers: z.array(rates.extend({ inputTokensAbove: tokens })).max(8).optional() }),
	contextWindow: tokens,
	maxTokens: tokens,
});

// Pi 1.6.1's Google transports send a mapped thinking level only as one of
// these (case-insensitively) and throw on anything else at request time, e.g.
// a "max" mapping written for a newer Pi. Such a level is dropped (null), so
// pickers stop offering it and pinned levels clamp to the nearest sendable one.
// Typed against Pi: an upgrade that widens Google's levels fails typecheck here.
const googleThinkingLevels = { minimal: true, low: true, medium: true, high: true, xhigh: true } satisfies Record<Exclude<ResolvedGoogleThinkingLevel, "off">, true>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Pi's own compat schema for each transport decides which settings a feed row
// may carry and their values. A setting Pi does not declare for the route has
// no wire effect, so it is dropped. Of Pi's object and list settings only the
// reviewed ones below are handled; any other fails closed, so the settings
// stay bounded values, never arbitrary request arguments.
const ignoredCompat = new Set(["openRouterRouting", "vercelGatewayRouting", "allowedFallbackModels"]);
const templateCompat = new Set(["chatTemplateArgs", "chatTemplateKwargs"]);
const option = (schema: unknown) => record(schema) && schema.type === "string" && typeof schema.const === "string";
const scalarSetting = (schema: unknown) => record(schema) && (
	schema.type === "boolean" || schema.type === "number" || schema.type === "integer" || option(schema)
	|| (Array.isArray(schema.anyOf) && schema.anyOf.length > 0 && schema.anyOf.every(option)));
const compatRules = new Map(Object.entries(CompatSchemasByApi).map(([api, schema]) => [api, {
	settings: record(schema.properties) ? schema.properties : {},
	validator: compile(schema),
}]));

function catalogRows(body: unknown): unknown[] {
	// Accepted feed shapes: an array, a {models:[]} envelope, or an id map.
	const rows = Array.isArray(body) ? body : record(body) ? ("models" in body ? body.models : Object.values(body)) : null;
	if (!Array.isArray(rows) || rows.length > MAX_SHARD_ROWS || !rows.every((row) => record(row) && typeof row.id === "string")) {
		throw new Error("Invalid pi.dev catalog");
	}
	return rows;
}

function checkedCompat(api: Api, baselines: readonly Model<Api>[], raw: unknown): Model<Api>["compat"] {
	if (raw === undefined) return undefined;
	if (!record(raw)) throw new Error("Invalid pi.dev model compatibility");
	const rule = compatRules.get(api);
	if (!rule) return undefined;
	const claims: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		// Ignore feed-controlled routing/fallback choices and settings Pi does not declare here.
		if (ignoredCompat.has(key) || !Object.hasOwn(rule.settings, key)) continue;
		if (!templateCompat.has(key) && !scalarSetting(rule.settings[key])) throw new Error("Unsupported pi.dev model compatibility");
		claims[key] = value;
	}
	if (rule.validator.errors(claims).length) throw new Error("Invalid pi.dev model compatibility");
	// If a thinking format needs a template, accept only an exact profile
	// shipped for this route and pass the bundled copy, never feed arguments.
	const { chatTemplateArgs, chatTemplateKwargs, ...flags } = claims;
	if (flags.thinkingFormat === "baseten" || flags.thinkingFormat === "chat-template" || chatTemplateArgs !== undefined || chatTemplateKwargs !== undefined) {
		const trusted = baselines.map((model): Record<string, unknown> | undefined => model.compat).find((compat) =>
			compat?.thinkingFormat === flags.thinkingFormat
			&& isDeepStrictEqual(compat?.chatTemplateArgs, chatTemplateArgs)
			&& isDeepStrictEqual(compat?.chatTemplateKwargs, chatTemplateKwargs));
		if (!trusted) throw new Error("Unsupported pi.dev model template");
		return { ...flags, chatTemplateArgs: trusted.chatTemplateArgs, chatTemplateKwargs: trusted.chatTemplateKwargs } as Model<Api>["compat"];
	}
	return Object.keys(flags).length ? flags as Model<Api>["compat"] : undefined;
}

function checkedModels(provider: string, rows: readonly unknown[]): Model<Api>[] {
	const baseline = builtins.get(provider);
	if (!baseline) return [];
	const known = new Set(baseline.map((model) => model.id));
	const models = new Map<string, Model<Api>>();
	for (const row of rows) {
		if (!record(row) || typeof row.id !== "string") throw new Error("Invalid pi.dev model");
		// Deliberate skips: non-chat kinds, bundled IDs and routes the shipped
		// provider cannot use. An eligible but invalid row fails the refresh.
		if (row.type === "image" || row.type === "classifier" || known.has(row.id)) continue;
		if (typeof row.api !== "string" || !row.api || typeof row.baseUrl !== "string" || !row.baseUrl) throw new Error("Invalid pi.dev model route");
		const routes = baseline.filter((model) => model.api === row.api && model.baseUrl === row.baseUrl);
		const route = routes[0];
		if (!route) continue;
		const { id, api: _api, baseUrl: _baseUrl, ...metadata } = rowSchema.parse(row);
		if ((row.provider !== undefined && row.provider !== provider) || models.has(id) || (route.api === "google-generative-ai" && id.includes(":"))) {
			throw new Error("Invalid pi.dev model identity");
		}
		const thinkingLevelMap = metadata.thinkingLevelMap;
		if (thinkingLevelMap && (route.api === "google-generative-ai" || route.api === "google-vertex")) {
			for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
				const mapped = thinkingLevelMap[level];
				if (typeof mapped === "string" && !Object.hasOwn(googleThinkingLevels, mapped.toLowerCase())) thinkingLevelMap[level] = null;
			}
		}
		// Model.samplingParams and its per-level variant allow arbitrary
		// request keys in Pi. Do not silently import models that require them.
		for (const raw of [row.samplingParams, row.samplingParamsByThinkingLevel]) {
			if (raw !== undefined && (!record(raw) || Object.keys(raw).length)) throw new Error("Unsupported pi.dev sampling parameters");
		}
		const compat = checkedCompat(route.api, routes, row.compat);
		models.set(id, {
			...metadata, id, provider, api: route.api, baseUrl: route.baseUrl,
			...(route.headers ? { headers: route.headers } : {}),
			...(compat ? { compat } : {}),
		});
	}
	return [...models.values()];
}

type Catalog = Map<string, readonly Model<Api>[]>;
interface State { snapshot: Catalog; refreshing?: Promise<ModelCatalogRefreshOutcome> }
const STATE_KEY = Symbol.for("lh.remote-model-catalog");
const catalogGlobal = globalThis as typeof globalThis & { [STATE_KEY]?: State };

function restoreSnapshot(): Catalog {
	try {
		const stat = fs.lstatSync(FILE);
		if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return new Map();
		const saved: unknown = JSON.parse(fs.readFileSync(FILE, "utf-8"));
		if (record(saved) && saved.version === 1 && record(saved.providers)) {
			return new Map([...builtins.keys()].flatMap((provider) => {
				const rows = saved.providers as Record<string, unknown>;
				const models = Array.isArray(rows[provider]) ? checkedModels(provider, catalogRows(rows[provider])) : [];
				return models.length ? [[provider, models] as const] : [];
			}));
		}
	} catch { /* Missing/unreadable snapshot: the bundled catalog is still usable. */ }
	return new Map();
}

/** Local file only. Next's server startup restores without checking pi.dev. */
export function initializeModelCatalog(): void {
	if (catalogGlobal[STATE_KEY]) return;
	const snapshot = restoreSnapshot();
	catalogGlobal[STATE_KEY] = { snapshot };
	setModelCatalogOverlay(snapshot);
}

async function fetchShard(provider: string, signal: AbortSignal): Promise<Model<Api>[]> {
	const url = new URL(`https://pi.dev/api/models/providers/${encodeURIComponent(provider)}?types=chat`);
	const response = await fetch(url, {
		cache: "no-store", credentials: "omit", redirect: "error", signal,
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		await response.body?.cancel();
		// These are the SDK's unsupported-shard statuses, not a deletion.
		if (response.status === 404 || response.status === 501) return [];
		throw new Error("pi.dev catalog request failed");
	}
	return checkedModels(provider, catalogRows(await readBoundedJson(response, MAX_SHARD_BYTES)));
}

async function refresh(state: State): Promise<ModelCatalogRefreshOutcome> {
	const configured = AUTH_PROVIDER_KEYS.filter(({ id, envVar }) => builtins.has(id) && keyValue(envVar) !== undefined);
	if (!configured.length) return "no-providers";
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
	try {
		const shards = await Promise.all(configured.map(async ({ id }) => [id, await fetchShard(id, signal)] as const));
		signal.throwIfAborted();
		const snapshot: Catalog = new Map(state.snapshot);
		for (const [provider, models] of shards) {
			if (!models.length) continue;
			// Keep previously imported IDs if a later feed omits them: saved
			// slot, chat and background pins can still refer to them.
			const merged = new Map(snapshot.get(provider)?.map((model) => [model.id, model]));
			for (const model of models) {
				const previous = merged.get(model.id);
				if (!previous || (previous.api === model.api && previous.baseUrl === model.baseUrl)) merged.set(model.id, model);
			}
			if (merged.size > MAX_SHARD_ROWS) throw new Error("Model catalog exceeds the row limit");
			snapshot.set(provider, [...merged.values()]);
		}
		const encode = (value: Catalog) => JSON.stringify({ version: 1, providers: Object.fromEntries(value) });
		const text = encode(snapshot);
		if (text === encode(state.snapshot)) return "unchanged";
		if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) throw new Error("Model catalog exceeds the snapshot limit");
		fs.mkdirSync(PATHS.data, { recursive: true });
		writeFileAtomicSync(FILE, text);
		state.snapshot = snapshot;
		setModelCatalogOverlay(snapshot);
		return "updated";
	} finally { controller.abort(); }
}

/** Called exclusively by the manual POST. Concurrent clicks share one fetch. */
export function refreshModelCatalog(): Promise<ModelCatalogRefreshOutcome> {
	initializeModelCatalog();
	const state = catalogGlobal[STATE_KEY]!;
	return state.refreshing ??= refresh(state).finally(() => { state.refreshing = undefined; });
}
