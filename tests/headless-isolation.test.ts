/**
 * Demo pages run model-written markup. They must load in
 * memory (opaque origin), never as a file:// document that can read local
 * files, and requests for schemes other than web/data ones are aborted while
 * they run. The helper's page is reused, so the filter must come off again.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEMO_CSP_META, injectDemoCsp, isIsolatedPageRequestAllowed, loadIsolatedPage } from "../src/agent/subagents/headless.ts";

type RequestHandler = (request: unknown) => void;

function fakePage(opts: { url?: string; setContentError?: Error; resetError?: Error } = {}) {
	const calls: string[] = [];
	const handlers = new Set<RequestHandler>();
	let current = opts.url ?? "about:blank";
	const page = {
		url: () => current,
		goto: async (url: string) => {
			calls.push(`goto ${url}`);
			if (opts.resetError) throw opts.resetError;
			current = url;
			return null;
		},
		setContent: async (html: string, options: { waitUntil?: string }) => {
			calls.push(`setContent ${html} ${options.waitUntil}`);
			if (opts.setContentError) throw opts.setContentError;
		},
		setRequestInterception: async (on: boolean) => {
			calls.push(`interception ${on}`);
		},
		on: (event: string, handler: RequestHandler) => {
			calls.push(`on ${event}`);
			if (event === "request") handlers.add(handler);
			return page;
		},
		off: (event: string, handler: RequestHandler) => {
			calls.push(`off ${event}`);
			if (event === "request") handlers.delete(handler);
			return page;
		},
	};
	/** Send one request through every registered handler; returns what they decided. */
	const request = (url: string, navigation = false) => {
		const decisions: string[] = [];
		const req = {
			url: () => url,
			isNavigationRequest: () => navigation,
			continue: async () => void decisions.push("continue"),
			abort: async (reason: string) => void decisions.push(`abort ${reason}`),
		};
		for (const handler of handlers) handler(req);
		return decisions;
	};
	return { page: page as unknown as Parameters<typeof loadIsolatedPage>[0], calls, handlers, request };
}

describe("isolated page request filter", () => {
	it("allows strictly offline data, blob and about URLs, blocking remote http/https", () => {
		for (const url of [
			"data:image/png;base64,AAAA",
			"blob:null/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
			"about:blank",
		]) {
			assert.equal(isIsolatedPageRequestAllowed(url), true, url);
		}
		for (const url of [
			"https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js",
			"http://example.com/x.js",
		]) {
			assert.equal(isIsolatedPageRequestAllowed(url), false, url);
		}
	});

	it("rejects file, network, javascript and browser-internal URLs, whatever their case", () => {
		for (const url of [
			"file:///etc/passwd",
			"FILE:///Users/someone/.ssh/id_ed25519",
			"file://localhost/C:/Users/someone/auth.json",
			"ws://127.0.0.1:3000/ws",
			"ftp://example.com/file",
			"javascript:alert(1)",
			"chrome://settings",
			"devtools://devtools/bundled/inspector.html",
			"chrome-extension://abc/x.js",
			"not a url",
		]) {
			assert.equal(isIsolatedPageRequestAllowed(url), false, url);
		}
	});
});

describe("loadIsolatedPage", () => {
	it("writes CSP-hardened markup into about:blank with the offline/navigation filter on", async () => {
		const fake = fakePage();
		const cleanup = await loadIsolatedPage(fake.page, "<p>demo</p>");
		assert.deepEqual(fake.calls, ["on request", "interception true", `setContent ${injectDemoCsp("<p>demo</p>")} load`]);
		assert.ok(fake.calls[2]!.includes(DEMO_CSP_META));
		assert.ok(!fake.calls.some((call) => call.includes("file:")));
		assert.deepEqual(fake.request("data:image/png;base64,AAAA"), ["continue"]);
		assert.deepEqual(fake.request("https://cdn.example/lib.js"), ["abort accessdenied"]);
		assert.deepEqual(fake.request("file:///etc/passwd"), ["abort accessdenied"]);
		assert.deepEqual(fake.request("data:text/html,<script>1</script>", true), ["abort accessdenied"]);
		assert.deepEqual(fake.request("about:blank", true), ["abort accessdenied"]);
		await cleanup();
	});

	it("cleanup removes the filter so the reused helper page is left as it was", async () => {
		const fake = fakePage();
		const cleanup = await loadIsolatedPage(fake.page, "<p>demo</p>");
		fake.calls.length = 0;
		await cleanup();
		assert.deepEqual(fake.calls, ["goto about:blank", "interception false", "off request"]);
		await cleanup();
		assert.equal(fake.calls.length, 3, "retirement is idempotent");
		assert.equal(fake.handlers.size, 0);
	});

	it("moves off any other document first, since setContent keeps the current origin", async () => {
		const fake = fakePage({ url: "file:///tmp/previous.html" });
		const cleanup = await loadIsolatedPage(fake.page, "<p>demo</p>");
		assert.deepEqual(fake.calls.slice(0, 3), ["on request", "interception true", "goto about:blank"]);
		assert.ok(fake.calls.indexOf("goto about:blank") < fake.calls.findIndex((call) => call.startsWith("setContent")));
		await cleanup();
	});

	it("cleans up and rethrows when the page fails to load", async () => {
		const fake = fakePage({ setContentError: new Error("Navigation timeout of 30000 ms exceeded") });
		await assert.rejects(loadIsolatedPage(fake.page, "<p>demo</p>"), /Navigation timeout/);
		assert.deepEqual(fake.calls.slice(-3), ["goto about:blank", "interception false", "off request"]);
		assert.equal(fake.handlers.size, 0);
	});

	it("keeps guarding if retirement fails rather than releasing a live document", async () => {
		const fake = fakePage({ resetError: new Error("reset failed") });
		const cleanup = await loadIsolatedPage(fake.page, "<p>demo</p>");
		await assert.rejects(cleanup(), /Could not retire/);
		assert.equal(fake.handlers.size, 1);
		assert.deepEqual(fake.request("file:///canary"), ["abort accessdenied"]);
		assert.ok(!fake.calls.includes("interception false"));
	});
});
