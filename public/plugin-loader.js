// Deliberately served as a native browser module, outside the Next bundle.
// Plugins are trusted local code, validated against same-origin /api/plugins/.
window.__lhImportPlugin = (url) => {
	if (typeof url !== "string" || !url.trim()) {
		return Promise.reject(new Error("Invalid plugin module URL"));
	}
	const parsed = new URL(url, window.location.origin);
	if (
		parsed.origin !== window.location.origin ||
		!parsed.pathname.startsWith("/api/plugins/")
	) {
		return Promise.reject(new Error(`Refused untrusted plugin module URL: ${url}`));
	}
	return import(parsed.href);
};
