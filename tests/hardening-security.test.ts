import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { NextRequest } from "next/server";

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lh-hardening-sec-")));
const homeDir = path.join(scratch, "home");
const dataDir = path.join(scratch, "app-data");
const authFile = path.join(scratch, "private", "auth.json");
const sourceDir = path.join(scratch, "sources");
fs.mkdirSync(homeDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(authFile), { recursive: true });
fs.mkdirSync(sourceDir, { recursive: true });
fs.writeFileSync(authFile, "{}");

const prevEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	LH_DATA_DIR: process.env.LH_DATA_DIR,
	LH_AUTH_FILE: process.env.LH_AUTH_FILE,
	LH_DESKTOP_SERVER: process.env.LH_DESKTOP_SERVER,
	LH_DESKTOP_API_SECRET: process.env.LH_DESKTOP_API_SECRET,
	LH_ENABLE_JINA_READER: process.env.LH_ENABLE_JINA_READER,
	DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
};
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
process.env.LH_DATA_DIR = dataDir;
process.env.LH_AUTH_FILE = authFile;
delete process.env.LH_DESKTOP_SERVER;
delete process.env.LH_DESKTOP_API_SECRET;
delete process.env.LH_ENABLE_JINA_READER;

const { externalCliEnv } = await import("../src/core/auth-env.ts");
const { browserServiceSpawnEnv } = await import("../src/agent/subagents/headless.ts");
const {
	buildDemoSrcDoc,
	DEMO_CSP_META,
	INITIAL_DEMO_BRIDGE_STATE,
	reduceDemoBridgeState,
} = await import("../components/artifacts/demo-card.tsx");
const { expandBraces, isSensitivePath } = await import("../src/agent/tools/fs-shared.ts");
const { setFileAccessPolicy } = await import("../src/agent/tools/file-access.ts");
const { readTool } = await import("../src/agent/tools/read.ts");
const { readBoundedBytes } = await import("../src/agent/tools/bounded-response.ts");
const { isPublicAddress, safeFetchOverride } = await import("../src/agent/tools/safe-fetch.ts");
const { createWebTools } = await import("../src/agent/tools/web.ts");
const { staticSvgProblem } = await import("../src/agent/subagents/annotation-svg.ts");
const { createPluginTransport } = await import("../src/server/plugin-transport.ts");
const sttTokenRoute = await import("../app/api/stt/token/route.ts");
const nextConfig = (await import("../next.config.ts")).default;
const { proxy } = await import("../proxy.ts");

after(() => {
	setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
	safeFetchOverride.current = undefined;
	for (const [key, value] of Object.entries(prevEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("hardening security regressions", () => {
	it("externalCliEnv strips internal LH_* secrets and ELECTRON_RUN_AS_NODE", () => {
		const sanitized = externalCliEnv({
			PATH: "/usr/bin",
			NODE_ENV: "production",
			LH_DESKTOP_API_SECRET: "secret-123",
			LH_DESKTOP_SERVER: "1",
			LH_AUTH_FILE: "/tmp/auth.json",
			LH_DATA_DIR: "/tmp/data",
			LH_DEV_URL: "http://localhost:3000",
			ELECTRON_RUN_AS_NODE: "1",
			KEEP_VAR: "ok",
		});
		assert.equal(sanitized.PATH, "/usr/bin");
		assert.equal(sanitized.KEEP_VAR, "ok");
		for (const stripped of [
			"LH_DESKTOP_API_SECRET",
			"LH_DESKTOP_SERVER",
			"LH_AUTH_FILE",
			"LH_DATA_DIR",
			"LH_DEV_URL",
			"ELECTRON_RUN_AS_NODE",
		]) {
			assert.equal(stripped in sanitized, false, stripped);
		}
	});

	it("browserServiceSpawnEnv allowlists only safe OS vars and drops keys/LH_*/ELECTRON_RUN_AS_NODE", () => {
		const sanitized = browserServiceSpawnEnv({
			PATH: "/bin",
			HOME: "/home/user",
			NODE_ENV: "production",
			ELECTRON_RUN_AS_NODE: "1",
			OPENAI_API_KEY: "sk-secret",
			LH_DESKTOP_API_SECRET: "desk-secret",
			LH_AUTH_FILE: "/home/user/auth.json",
		});
		assert.deepEqual(sanitized, {
			PATH: "/bin",
			HOME: "/home/user",
			NODE_ENV: "production",
		});
	});

	it("demo-card injects strict offline CSP and normalizes/bounds demo-error", () => {
		const doc = buildDemoSrcDoc("<html><head><title>x</title></head><body><p>hi</p></body></html>");
		assert.ok(doc.includes(DEMO_CSP_META));
		assert.ok(doc.includes("default-src 'none'"));
		assert.ok(doc.includes("connect-src 'none'"));

		const longMsg = "err:\n\t   " + "a".repeat(500);
		const next = reduceDemoBridgeState(INITIAL_DEMO_BRIDGE_STATE, { type: "demo-error", message: longMsg });
		assert.ok(next.error !== null);
		assert.ok(!/[\r\n\t]/.test(next.error));
		assert.equal(next.error.length, 401);
		assert.ok(next.error.endsWith("…"));
	});

	it("isSensitivePath blocks expanded SENSITIVE_HOME_PATHS and PATHS.data", () => {
		for (const rel of [
			".kube/config",
			".docker/config.json",
			".gnupg/secring.gpg",
			".npmrc",
			".netrc",
			".git-credentials",
			".config/gh/hosts.yml",
			".config/gcloud/credentials.db",
			"Library/Keychains/login.keychain-db",
		]) {
			assert.equal(isSensitivePath(path.join(homeDir, rel), homeDir, authFile, dataDir), true, rel);
		}
		assert.equal(isSensitivePath(path.join(dataDir, "chats", "c1.json"), homeDir, authFile, dataDir), true);
		assert.equal(isSensitivePath(path.join(sourceDir, "notes.md"), homeDir, authFile, dataDir), false);
	});

	it("expandBraces bounds combinatorial explosions at 256 without OOM", () => {
		const boom = "{a,b}".repeat(9); // 512 combinations > 256
		const result = expandBraces(boom);
		assert.deepEqual(result, [boom]);
		assert.equal(expandBraces("*.{ts,tsx}").length, 2);
	});

	it("readBoundedBytes enforces streaming byte limit regardless of Content-Length", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(60));
				controller.enqueue(new Uint8Array(60));
				controller.close();
			},
		});
		const noHeader = new Response(stream);
		await assert.rejects(() => readBoundedBytes(noHeader, 100, "Too large"), /Too large/);

		const lyingHeader = new Response(new Uint8Array(200), { headers: { "content-length": "10" } });
		await assert.rejects(() => readBoundedBytes(lyingHeader, 100, "Too large"), /Too large/);

		const exact = new Response(new Uint8Array(100));
		assert.equal((await readBoundedBytes(exact, 100, "Too large")).byteLength, 100);
	});

	it("web_fetch keeps Jina disabled by default and refuses query strings / credentials when opted in", async () => {
		const requestedUrls: string[] = [];
		safeFetchOverride.current = async (url) => {
			requestedUrls.push(url);
			if (url.startsWith("https://r.jina.ai/")) {
				return new Response("Title: X\n\nMarkdown Content:\n" + "Useful extracted article body ".repeat(12), {
					headers: { "content-type": "text/markdown" },
				});
			}
			return new Response("<html><body><script>bad()</script></body></html>", {
				headers: { "content-type": "text/html" },
			});
		};
		try {
			const tools = createWebTools(() => null);
			const resDefault = await tools.web_fetch!.execute!("w1", { url: "https://example.com/app" });
			assert.match((resDefault.content[0] as { text: string }).text, /Could not extract readable content/);
			assert.ok(!requestedUrls.some((u) => u.startsWith("https://r.jina.ai/")));

			process.env.LH_ENABLE_JINA_READER = "1";
			requestedUrls.length = 0;
			const resQuery = await tools.web_fetch!.execute!("w2", { url: "https://example.com/app?token=secret" });
			assert.match((resQuery.content[0] as { text: string }).text, /Could not extract readable content/);
			assert.ok(!requestedUrls.some((u) => u.startsWith("https://r.jina.ai/")));

			requestedUrls.length = 0;
			const resCreds = await tools.web_fetch!.execute!("w3", { url: "https://user:pass@example.com/app" });
			assert.match((resCreds.content[0] as { text: string }).text, /Could not extract readable content/);
			assert.ok(!requestedUrls.some((u) => u.startsWith("https://r.jina.ai/")));

			requestedUrls.length = 0;
			const resAllowed = await tools.web_fetch!.execute!("w4", { url: "https://example.com/app" });
			assert.match((resAllowed.content[0] as { text: string }).text, /Useful extracted article body/);
			assert.ok(requestedUrls.includes("https://r.jina.ai/https://example.com/app"));
		} finally {
			delete process.env.LH_ENABLE_JINA_READER;
			safeFetchOverride.current = undefined;
		}
	});

	it("readTool refuses directories and oversized text/image files", async () => {
		setFileAccessPolicy(() => ({ restricted: false, folders: [] }));
		await assert.rejects(readTool.execute!("r1", { path: sourceDir }), /Not a regular file/);

		const bigText = path.join(sourceDir, "huge.txt");
		const bigImg = path.join(sourceDir, "huge.png");
		fs.writeFileSync(bigText, "a");
		fs.truncateSync(bigText, 10 * 1024 * 1024 + 1);
		fs.writeFileSync(bigImg, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		fs.truncateSync(bigImg, 25 * 1024 * 1024 + 1);

		await assert.rejects(readTool.execute!("r2", { path: bigText }), /File too large/);
		await assert.rejects(readTool.execute!("r3", { path: bigImg }), /File too large/);
	});

	it("isPublicAddress rejects RFC 6890 special IPv6 ranges while permitting public IPs", () => {
		for (const blocked of [
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"::ffff:0:127.0.0.1",
			"2001::1",
			"2001:2::1",
			"2001:10::1",
			"2001:20::1",
			"fec0::1",
			"100.64.0.1",
			"192.0.2.1",
		]) {
			assert.equal(isPublicAddress(blocked), false, blocked);
		}
		assert.equal(isPublicAddress("2001:4860:4860::8888"), true);
		assert.equal(isPublicAddress("8.8.8.8"), true);
		assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
		assert.equal(isPublicAddress("::ffff:808:808"), true);
	});

	it("staticSvgProblem rejects active SVG elements/attributes and accepts static vectors", () => {
		assert.equal(staticSvgProblem('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>'), null);
		for (const bad of [
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>hi</div></foreignObject></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><rect onload="alert(1)"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.example/#g)"/></svg>',
		]) {
			assert.notEqual(staticSvgProblem(bad), null, bad);
		}
	});

	it("plugin-transport serves SVG plugin assets with Content-Security-Policy: sandbox", async () => {
		const transport = createPluginTransport({
			directory: "/tmp/plugins",
			getHost: async () => ({
				list: () => [],
				conflicts: () => [],
				refresh: async () => {},
				setEnabled: async () => {},
				call: async () => null,
				convertDocument: async () => ({ name: "a", markdown: "b", notices: [] }),
				asset: () => ({ bytes: new TextEncoder().encode("<svg/>"), contentType: "image/svg+xml" }),
			}),
		});
		const res = await transport.asset("demo", ["icon.svg"]);
		assert.equal(res.headers.get("content-security-policy"), "sandbox");
		assert.equal(res.headers.get("x-content-type-options"), "nosniff");
	});

	it("/api/stt/token exports POST only (no GET) and sets Cache-Control: no-store", async () => {
		assert.equal("GET" in sttTokenRoute, false);
		assert.equal(typeof sttTokenRoute.POST, "function");
		delete process.env.DEEPGRAM_API_KEY;
		const res = await sttTokenRoute.POST();
		assert.equal(res.status, 503);
		assert.equal(res.headers.get("cache-control"), "no-store");
	});

	it("next.config.ts defines required security headers without upgrade-insecure-requests", async () => {
		assert.equal(typeof nextConfig.headers, "function");
		const entries = await nextConfig.headers!();
		assert.ok(entries.length >= 1);
		const map = new Map(entries[0]!.headers.map((h) => [h.key.toLowerCase(), h.value]));
		assert.equal(map.get("x-frame-options"), "DENY");
		assert.equal(map.get("x-content-type-options"), "nosniff");
		assert.equal(map.get("referrer-policy"), "no-referrer");
		const csp = map.get("content-security-policy") ?? "";
		assert.ok(csp.includes("frame-ancestors 'none'"), csp);
		assert.ok(!csp.includes("upgrade-insecure-requests"), csp);
	});

	it("proxy.ts blocks disallowed Host and cross-site SSR page loads", () => {
		for (const route of ["/", "/chat/abc", "/settings", "/plugins/x"]) {
			const rebinding = proxy(new NextRequest(`http://127.0.0.1:3000${route}`, {
				headers: { host: "evil.example:3000" },
			}));
			assert.equal(rebinding.status, 403, `Host check ${route}`);

			const local = proxy(new NextRequest(`http://localhost:3000${route}`, {
				headers: { host: "localhost:3000", "sec-fetch-site": "same-origin" },
			}));
			assert.equal(local.headers.get("x-middleware-next"), "1", `same-origin ${route}`);
		}
		for (const route of ["/chat/abc", "/settings", "/plugins/x"]) {
			const crossSite = proxy(new NextRequest(`http://localhost:3000${route}`, {
				headers: { host: "localhost:3000", "sec-fetch-site": "cross-site" },
			}));
			assert.equal(crossSite.status, 403, `cross-site ${route}`);
		}
	});

	it("app/chat/[id]/page.tsx does not read ?prompt= from URL searchParams", () => {
		const src = fs.readFileSync(new URL("../app/chat/[id]/page.tsx", import.meta.url), "utf8");
		assert.doesNotMatch(src, /searchParams|\bprompt\b/);
	});
});
