import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { AUTH_PROVIDER_ENV_VARS } from "../src/core/auth-keys.ts";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lh-gemini-xhigh-"));
process.env.LH_DATA_DIR = scratch;
process.env.LH_AUTH_FILE = path.join(scratch, "auth.json");
fs.writeFileSync(process.env.LH_AUTH_FILE, "{}\n");
for (const key of AUTH_PROVIDER_ENV_VARS) delete process.env[key];
process.env.GEMINI_API_KEY = "synthetic-gemini-key";
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const { piEngineForSpec } = await import("../src/agent/models.ts");

// The Strong slot crash (2026-11-25): google/gemini-4-neon at xhigh. Offline,
// so the stubbed fetch sees the exact body Google would receive.
test("a bundled Gemini xhigh pin reaches Google as thinkingLevel XHIGH", async () => {
	const engine = piEngineForSpec({ provider: "google", id: "gemini-4-neon", thinkingLevel: "xhigh" });
	assert.equal(engine.level, "xhigh");
	const requests: { url: string; body: { generationConfig?: { thinkingConfig?: Record<string, unknown> } } }[] = [];
	const result = await engine.streamFn(engine.model, normalizeContext({
		systemPrompt: "Synthetic review fixture.",
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	}), {
		fetch: async (input, init) => {
			requests.push({ url: input instanceof Request ? input.url : String(input), body: JSON.parse(String(init?.body)) });
			const chunk = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
			return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	}).result();
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(requests.length, 1);
	assert.match(requests[0]!.url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-4-neon:streamGenerateContent\b/);
	assert.deepEqual(requests[0]!.body.generationConfig?.thinkingConfig, { includeThoughts: true, thinkingLevel: "XHIGH" });
});
