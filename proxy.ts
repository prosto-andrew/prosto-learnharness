import { NextResponse, type NextRequest } from "next/server";
import { apiRequestRefusal, browserHostAllowed } from "./src/server/desktop-access.ts";

const PROTECTED_SSR_PREFIXES = ["/chat", "/settings", "/plugins"] as const;

/** Protects API methods and guards SSR pages against DNS-rebinding Host headers
 *  and cross-site requests. The streamed document route enforces apiRequestRefusal
 *  inside its handler, avoiding Next's silently truncated Proxy body clone. */
export function proxy(request: NextRequest) {
	const { pathname } = request.nextUrl;
	if (pathname === "/api" || pathname.startsWith("/api/")) {
		const refusal = apiRequestRefusal(request);
		if (refusal) {
			return NextResponse.json(
				{ error: refusal },
				{ status: 403, headers: { "Cache-Control": "no-store" } },
			);
		}
		return NextResponse.next();
	}

	const host = request.headers.get("host") ?? request.nextUrl.host;
	if (!browserHostAllowed(host)) {
		return new NextResponse("This host name is not allowed.", {
			status: 403,
			headers: { "Cache-Control": "no-store" },
		});
	}
	if (
		PROTECTED_SSR_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) &&
		request.headers.get("sec-fetch-site") === "cross-site"
	) {
		return new NextResponse("Cross-site page requests are not allowed.", {
			status: 403,
			headers: { "Cache-Control": "no-store" },
		});
	}
	return NextResponse.next();
}

export const config = {
	// Protect SSR app routes as well as /api/* (keeping the streamed document
	// upload endpoint exempted so Proxy does not truncate multipart uploads).
	matcher: [
		"/",
		"/chat/:path*",
		"/settings",
		"/settings/:path*",
		"/plugins/:path*",
		"/api",
		"/api/((?!plugins/[^/]+/documents/markdown/?$).*)",
	],
};
