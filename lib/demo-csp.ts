/**
 * The one strict offline CSP for untrusted demo HTML, shared by the chat card
 * (iframe srcdoc) and the headless test runner (setContent).
 */
export const DEMO_CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:; connect-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\';">';

const LEADING_DOCTYPE = /^﻿?\s*<!doctype[^>]*>/i;

/** Put the CSP before any document content: right after a leading doctype
 *  (with optional BOM/whitespace), otherwise at position 0. No <head>/<html>
 *  search, so markup inside comments or scripts cannot move it later. */
export function injectDemoCsp(html: string): string {
	const doctype = LEADING_DOCTYPE.exec(html);
	const at = doctype ? doctype[0].length : 0;
	return `${html.slice(0, at)}${DEMO_CSP_META}${html.slice(at)}`;
}
