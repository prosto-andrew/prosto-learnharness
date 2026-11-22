import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { documentToMarkdown, type PdfPage } from "./pdf-markdown.ts";

/**
 * PDF plumbing for the pdf-reader sub-agent — sources v0 (2026-09): Node
 * ports of the four pdf-reader skill scripts (pdf_info / pdf_extract /
 * pdf_search / pdf_render), on the user-chosen hybrid stack:
 *
 * - TEXT (info / extract / search): pdfjs-dist — pure JS, no native deps.
 *   extract and search read pdf-markdown's Markdown, so words and lines
 *   survive (the raw text items glued "lecture" + "Plants").
 * - RENDER: subagents/headless.ts uses the same pdfjs engine with
 *   @napi-rs/canvas (Skia), in-process — no browser needed.
 *
 * Doctrine (the skill's reading strategy, mirrored in the sub-agent's system
 * prompt): triage with pdf_info FIRST, then size-based strategy — short PDFs
 * render all pages, medium render flagged (math/image-heavy) pages, long
 * ones search for targeted lookups before reading anything at length.
 *
 * These are pure library functions — no model in sight. The pdf-reader
 * agent (pdf-reader.ts) drives them through its own tool loop.
 */

export interface PdfPageInfo {
	page: number;
	text_length: number;
	image_count: number;
	/** Fraction of math-flavored chars — the render-this-page signal (port
	 *  of the skill's unicode-range density heuristic). */
	math_density: number;
}

export interface PdfInfo {
	path: string;
	page_count: number;
	/** Mean chars/page — the size class the strategy branches on. */
	mean_text_length: number;
	pages: PdfPageInfo[];
}

/** Load the legacy pdfjs build (runs headless in plain node, no worker). */
async function loadPdfjs() {
	const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
	return pdfjs;
}

/** Standard-font data dir (live-smoke finding 2026-09-19: without it pdfjs
 *  warns and falls back on non-embedded standard fonts — Helvetica, Times…).
 *  The node side takes a plain filesystem path, shared by text and rendering.
 *  pdfjs checks endsWith("/") even on Windows: use a literal trailing slash,
 *  NOT path.sep ("\\" on Windows). Node fs accepts this path on every OS. */
export function standardFontsDir(): string {
	return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + "/";
}

export const MAX_PDF_BYTES = 64 * 1024 * 1024;
export const PDF_SIZE_ERROR = "PDF exceeds 64 MiB; provide a smaller PDF";

function checkPdfFile(stat: Stats): void {
	if (!stat.isFile()) throw new Error("it is not a regular file");
	if (stat.size === 0) throw new Error("the file is empty");
	if (stat.size > MAX_PDF_BYTES) throw new Error(PDF_SIZE_ERROR);
}

/** Read a local regular PDF file with a hard 64 MiB cap and TOCTOU growth guard.
 *  Owned Uint8Array storage can be handed directly to pdfjs. */
export async function readBoundedPdfFile(filePath: string, signal?: AbortSignal): Promise<Uint8Array> {
	checkPdfFile(await fs.stat(filePath));
	signal?.throwIfAborted();
	const handle = await fs.open(filePath, "r");
	try {
		const before = await handle.stat();
		checkPdfFile(before);
		signal?.throwIfAborted();
		const bytes = new Uint8Array(before.size);
		for (let offset = 0; offset < bytes.length;) {
			const { bytesRead } = await handle.read(bytes, offset, Math.min(64 * 1024, bytes.length - offset), null);
			signal?.throwIfAborted();
			if (!bytesRead) throw new Error("the file changed while being read; try again");
			offset += bytesRead;
		}
		const { bytesRead: extra } = await handle.read(new Uint8Array(1), 0, 1, null);
		signal?.throwIfAborted();
		const after = await handle.stat();
		signal?.throwIfAborted();
		if (after.size > MAX_PDF_BYTES || (extra && bytes.length === MAX_PDF_BYTES)) {
			throw new Error(PDF_SIZE_ERROR);
		}
		if (extra || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
			throw new Error("the file changed while being read; try again");
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function openDocument(filePath: string) {
	return openPdfBytes(await readBoundedPdfFile(filePath));
}

type PdfLoadingTask = Pick<import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentLoadingTask, "promise" | "destroy">;
type PdfTaskLoader = (data: Uint8Array, signal?: AbortSignal) => PdfLoadingTask | Promise<PdfLoadingTask>;

async function loadBytes(data: Uint8Array, signal?: AbortSignal): Promise<PdfLoadingTask> {
	signal?.throwIfAborted();
	const pdfjs = await loadPdfjs();
	signal?.throwIfAborted();
	// The legacy build in plain node runs on a main-thread fake worker (no
	// workerSrc needed); teardown is the loading task's destroy().
	// verbosity 0 = errors only — scanned PDFs (JBIG2 XObjects) otherwise
	// flood the log with per-page warnings (live-smoke finding 2026-09-19).
	return pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0, enableXfa: false, useWorkerFetch: false });
}

/** Open caller-owned bytes (pdfjs may transfer them). The caller owns task destruction. */
export async function openPdfBytes(data: Uint8Array, signal?: AbortSignal, loadTask: PdfTaskLoader = loadBytes) {
	signal?.throwIfAborted();
	const loadingTask = await loadTask(data, signal);
	let destruction: Promise<void> | undefined;
	const destroy = () => destruction ??= Promise.resolve().then(() => loadingTask.destroy()).finally(() => {
		signal?.removeEventListener("abort", onAbort);
	});
	const onAbort = () => { void destroy().catch(() => {}); };
	try {
		// Opening bytes is a cooperative checkpoint. pdfjs's Node fake worker
		// can leave the loading promise pending and reject internally without
		// a handler if destroyed between setup and readiness. Let it settle
		// before destroying, and never expose the opened doc after cancellation.
		const doc = await loadingTask.promise;
		signal?.throwIfAborted();
		signal?.addEventListener("abort", onAbort, { once: true });
		return { doc, task: { destroy } };
	} catch (error) {
		// Failed opens own a loading task too. Cleanup is best effort, without
		// replacing the parse error (or the caller's cancellation reason).
		await destroy().catch(() => {});
		signal?.throwIfAborted();
		throw error;
	}
}

/** Concatenate a page's text items into a body string. */
function itemsToText(items: unknown[]): string {
	let out = "";
	for (const it of items) {
		if (it && typeof it === "object" && "str" in (it as Record<string, unknown>)) {
			const str = (it as { str?: unknown }).str;
			if (typeof str === "string") out += str;
		}
	}
	return out;
}

/** Math-flavored char fraction — the skill's heuristic, verbatim ranges. */
function mathDensity(text: string): number {
	let mathChars = 0;
	for (const c of text) {
		const code = c.codePointAt(0)!;
		if (
			(code >= 0x2200 && code <= 0x22ff) || // Mathematical Operators
			(code >= 0x2100 && code <= 0x214f) || // Letterlike Symbols
			(code >= 0x2190 && code <= 0x21ff) || // Arrows
			(code >= 0x27c0 && code <= 0x27ef) || // Misc Mathematical Symbols-A
			(code >= 0x2980 && code <= 0x29ff) || // Misc Mathematical Symbols-B
			(code >= 0x2a00 && code <= 0x2aff) || // Supplemental Mathematical Operators
			(code >= 0x0370 && code <= 0x03ff) || // Greek
			(code >= 0x1d400 && code <= 0x1d7ff) || // Mathematical Alphanumeric Symbols
			"∫∑∏√∂∇∞≈≠≤≥±×÷∈∉⊂⊃∪∩∧∨¬∀∃∅".includes(c)
		) {
			mathChars++;
		}
	}
	return mathChars / Math.max(text.length, 1);
}

/** Cheap validity probe: getDocument resolves only for parseable PDFs —
 *  no page walk, no text extraction (unlike pdfInfo). The reader's upfront
 *  unreadable-source gate; garbage files throw pdfjs's precise error. */
export async function pdfProbe(filePath: string): Promise<void> {
	const { task } = await openDocument(filePath);
	await task.destroy();
}

/** pdf_info: page count + per-page triage signals. ALWAYS run first. */
export async function pdfInfo(filePath: string): Promise<PdfInfo> {
	const pdfjs = await loadPdfjs(); // OPS constant for the operator-list scan
	const { doc, task } = await openDocument(filePath);
	try {
		const pages: PdfPageInfo[] = [];
		let totalText = 0;
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const content = await page.getTextContent();
			const text = itemsToText(content.items as unknown[]);
			// count page images: paintImageXObject ops in the operator list
			const ops = await page.getOperatorList();
			let imageCount = 0;
			for (const fn of ops.fnArray) {
				if (fn === pdfjs.OPS.paintImageXObject) imageCount++;
			}
			totalText += text.length;
			pages.push({
				page: i,
				text_length: text.length,
				image_count: imageCount,
				math_density: Math.round(mathDensity(text) * 10000) / 10000,
			});
		}
		return {
			path: filePath,
			page_count: doc.numPages,
			mean_text_length: Math.round(totalText / Math.max(doc.numPages, 1)),
			pages,
		};
	} finally {
		await task.destroy().catch(() => {});
	}
}

/** Parse 'all' | '1-5' | '1,3,7' | '3' into a sorted 1-indexed page list. */
export function parsePageSpec(spec: string, total: number): number[] {
	const trimmed = spec.trim().toLowerCase();
	if (trimmed === "all") return Array.from({ length: total }, (_, i) => i + 1);
	const pages = new Set<number>();
	for (const part of spec.split(",")) {
		const p = part.trim();
		if (!p) continue;
		if (p.includes("-")) {
			const [startRaw, endRaw] = p.split("-", 2) as [string, string];
			const start = Math.max(1, parseInt(startRaw, 10));
			const end = Math.min(total, parseInt(endRaw, 10));
			for (let pg = start; pg <= end; pg++) pages.add(pg);
		} else {
			const pg = parseInt(p, 10);
			if (pg >= 1 && pg <= total) pages.add(pg);
		}
	}
	return [...pages].sort((a, b) => a - b);
}

export type PdfConversion =
	| { kind: "converted"; pages: PdfPage[] }
	| { kind: "too-long"; pageCount: number }
	/** Broken, encrypted, or not a PDF at all: pdfjs could not read it. */
	| { kind: "unreadable" };

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

/** Server-internal loading-task seam for lifecycle tests, not a plugin capability.
 * Both injected and default loaders use the same conversion and cleanup path. */
export function createPdfConverter(loadTask: PdfTaskLoader = loadBytes) {
	return async (data: Uint8Array, maxPages: number, options?: { signal?: AbortSignal }): Promise<PdfConversion> => {
		const signal = options?.signal;
		let opened: Awaited<ReturnType<typeof openPdfBytes>> | undefined;
		let result: PdfConversion | undefined;
		let failure: unknown;
		try {
			opened = await openPdfBytes(data, signal, loadTask);
			signal?.throwIfAborted();
			result = opened.doc.numPages > maxPages
				? { kind: "too-long", pageCount: opened.doc.numPages }
				: { kind: "converted", pages: await documentToMarkdown(opened.doc, undefined, signal) };
		} catch (error) {
			failure = error;
		} finally {
			try {
				await opened?.task.destroy();
			} catch (error) {
				if (!signal?.aborted && !isAbortError(failure)) throw error;
			}
		}
		// Also observe aborts arriving during final teardown. Never disguise
		// cancellation as a corrupt PDF, even when destroy rejects on abort.
		signal?.throwIfAborted();
		if (isAbortError(failure)) throw failure;
		return result ?? { kind: "unreadable" };
	};
}

const defaultPdfConverter = createPdfConverter();

/** An uploaded PDF's pages as Markdown (the notes import's door). The page
 * cap is checked before any page is read. Cancellation is cooperative: pdfjs's
 * Node fake worker cannot interrupt synchronous parsing/formatting. The promise
 * waits for opening/conversion and best-effort destruction, not a hard deadline. */
export async function convertPdf(data: Uint8Array, maxPages: number, options?: { signal?: AbortSignal }): Promise<PdfConversion> {
	return defaultPdfConverter(data, maxPages, options);
}

/** A page's Markdown, or "" for a page with no text (the agent renders those). */
function pageMarkdown(page: PdfPage): string {
	return page.kind === "text" ? page.markdown : "";
}

/** pdf_extract: Markdown of the requested pages, `--- Page N ---` headed. */
export async function pdfExtract(filePath: string, pageSpec: string): Promise<string> {
	const { doc, task } = await openDocument(filePath);
	try {
		const pages = parsePageSpec(pageSpec, doc.numPages);
		if (pages.length === 0) return "No pages selected — page spec matched nothing.";
		const converted = await documentToMarkdown(doc, pages);
		return converted.map((page) => `--- Page ${page.number} ---\n${pageMarkdown(page)}`).join("\n");
	} finally {
		await task.destroy().catch(() => {});
	}
}

export interface PdfSearchHit {
	page: number;
	line: number;
	/** contextLines around the hit, `>>>` marking the hit line. */
	context: string;
}

/** pdf_search: keyword/regex across all pages with context lines.
 *  pageTexts rides along so the agent can extract a hit's full page without
 *  a second pass (the skill pipelines `search → extract` the same way). */
export async function pdfSearch(
	filePath: string,
	query: string,
	opts?: { contextLines?: number; literal?: boolean },
): Promise<{ hits: PdfSearchHit[]; pageTexts: Map<number, string> }> {
	const contextLines = opts?.contextLines ?? 3;
	let pattern: RegExp;
	if (opts?.literal) {
		pattern = new RegExp(escapeRegex(query), "i");
	} else {
		try {
			pattern = new RegExp(query, "i");
		} catch (err) {
			throw new Error(`Invalid regex: ${(err as Error).message}`);
		}
	}
	const { doc, task } = await openDocument(filePath);
	try {
		const hits: PdfSearchHit[] = [];
		const pageTexts = new Map<number, string>();
		for (const page of await documentToMarkdown(doc)) {
			const i = page.number;
			const text = pageMarkdown(page);
			pageTexts.set(i, text);
			const lines = text.split("\n");
			for (let ln = 0; ln < lines.length; ln++) {
				if (!pattern.test(lines[ln]!)) continue;
				const start = Math.max(0, ln - contextLines);
				const end = Math.min(lines.length, ln + contextLines + 1);
				const context = lines
					.slice(start, end)
					.map((l, j) => `${start + j === ln ? ">>>" : "   "} ${l}`)
					.join("\n");
				hits.push({ page: i, line: ln + 1, context });
			}
		}
		return { hits, pageTexts };
	} finally {
		await task.destroy().catch(() => {});
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where rendered pages land (mirrors the skill's /tmp convention). */
export function renderDir(filePath: string): string {
	// FNV-1a short hash of the absolute path — stable per file, no deps.
	const abs = path.resolve(filePath);
	let h = 0x811c9dc5;
	for (let i = 0; i < abs.length; i++) {
		h ^= abs.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return path.join("/tmp", `lh-pdf-${h.toString(16).padStart(8, "0")}`);
}