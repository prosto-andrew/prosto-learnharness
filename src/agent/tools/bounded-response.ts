/** Read an HTTP response body into memory while enforcing a hard streaming byte ceiling. */
export async function readBoundedBytes(
	response: Response,
	maxBytes: number,
	limitMessage = "Response too large",
): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new Error(limitMessage);
	}
	const body = response.body;
	if (!body) {
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (bytes.byteLength > maxBytes) throw new Error(limitMessage);
		return bytes;
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.byteLength === 0) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new Error(limitMessage);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}
