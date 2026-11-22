import dns from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/**
 * Fetch for model-chosen URLs (research web_fetch / web_fetch_pdf): only
 * public internet addresses. A fetched page can steer the researcher, so
 * without this it could read loopback services, the LAN, or cloud metadata
 * (169.254.169.254) and hand the response back to the model.
 *
 * The check runs on the address each connection actually reaches, after DNS
 * and before any request bytes are sent, so redirects, IP-literal URLs and
 * DNS rebinding all go through it.
 */

const NON_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // carrier-grade NAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, cloud metadata
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // 6to4 relay anycast
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, broadcast
] as const) NON_PUBLIC_V4.addSubnet(network, prefix, "ipv4");

// Keep IPv6 in its own BlockList: in Node.js, adding ::ffff:0:0/96 to the same
// BlockList causes ipv4 checks (e.g. 8.8.8.8) to match as IPv4-mapped IPv6.
const NON_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
	["::", 96], // unspecified, loopback, IPv4-compatible (::a.b.c.d)
	["::ffff:0:0", 96], // IPv4-mapped IPv6 (after unwrapping below)
	["::ffff:0:0:0", 96], // IPv4-translated (SIIT)
	["64:ff9b::", 96], // NAT64
	["64:ff9b:1::", 48], // local-use NAT64
	["100::", 64], // discard-only
	["2001::", 32], // Teredo tunneling
	["2001:2::", 48], // benchmarking
	["2001:10::", 28], // ORCHID
	["2001:20::", 28], // ORCHIDv2
	["2001:db8::", 32], // documentation
	["2002::", 16], // 6to4
	["fc00::", 7], // unique local
	["fe80::", 10], // link-local
	["fec0::", 10], // deprecated site-local
	["ff00::", 8], // multicast
] as const) NON_PUBLIC_V6.addSubnet(network, prefix, "ipv6");

function unwrapMappedIpv4(ipv6: string): string | null {
	const dotted = ipv6.match(/^(?:::|(?:0+:){1,5}:?)ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
	if (dotted && isIP(dotted) === 4) return dotted;
	const parts = ipv6.split("::");
	if (parts.length > 2 || ipv6.includes(".")) return null;
	const left = parts[0] ? parts[0].split(":") : [];
	const right = parts[1] ? parts[1].split(":") : [];
	const missing = 8 - left.length - right.length;
	if ((parts.length === 1 && left.length !== 8) || (parts.length === 2 && missing < 1)) return null;
	const groups = [...left, ...Array<string>(parts.length === 2 ? missing : 0).fill("0"), ...right].map((g) => parseInt(g, 16));
	if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
	if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
		return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
	}
	return null;
}

/** True when an IP address is on the public internet. IPv4-mapped IPv6
 *  (::ffff:a.b.c.d / ::ffff:xxxx:xxxx) is judged as the IPv4 address it carries. */
export function isPublicAddress(address: string): boolean {
	const unbracketed = address.replace(/^\[|\]$/g, "");
	const family = isIP(unbracketed);
	if (family === 4) return !NON_PUBLIC_V4.check(unbracketed, "ipv4");
	if (family === 6) {
		const mapped = unwrapMappedIpv4(unbracketed);
		if (mapped) return !NON_PUBLIC_V4.check(mapped, "ipv4");
		return !NON_PUBLIC_V6.check(unbracketed, "ipv6");
	}
	return false;
}

export class BlockedAddressError extends Error {}

/** An undici Agent whose connections may only reach addresses `allowed`
 *  accepts (exported with the check injectable, for tests). */
export function createAddressCheckedAgent(
	allowed: (address: string) => boolean = isPublicAddress,
	connectorOptions: Parameters<typeof buildConnector>[0] = {},
): Agent {
	const baseLookup = (connectorOptions as { lookup?: LookupFunction }).lookup ?? (dns.lookup as unknown as LookupFunction);
	const checkedLookup: LookupFunction = (hostname, lookupOptions, callback) => {
		process.nextTick(() => {
			baseLookup(hostname, lookupOptions, (error, address, family) => {
				if (error) {
					callback(error, address, family);
					return;
				}
				if (Array.isArray(address)) {
					if (address.length === 0 || address.some((entry) => !allowed(entry.address))) {
						callback(new BlockedAddressError(`refusing to connect to a private or local address (${hostname})`) as NodeJS.ErrnoException, []);
						return;
					}
					callback(null, address);
					return;
				}
				if (typeof address !== "string" || !allowed(address)) {
					callback(new BlockedAddressError(`refusing to connect to a private or local address (${hostname})`) as NodeJS.ErrnoException, "", family ?? 0);
					return;
				}
				callback(null, address, family);
			});
		});
	};
	// Pre-connect lookup blocks disallowed IPs before opening a socket (closing
	// port-scan oracles); keep post-connect peer check as defense-in-depth.
	const connect = buildConnector({ ...connectorOptions, lookup: checkedLookup });
	return new Agent({
		connect: (options, callback) => {
			const bareHost = options.hostname.replace(/^\[|\]$/g, "");
			if (isIP(bareHost) !== 0 && !allowed(bareHost)) {
				callback(new BlockedAddressError(`refusing to connect to a private or local address (${options.hostname})`), null);
				return;
			}
			connect(options, (error, socket) => {
				if (error || !socket) {
					callback(error ?? new Error("connection failed"), null);
					return;
				}
				const peer = socket.remoteAddress ?? "";
				if (!peer || !allowed(peer)) {
					socket.destroy();
					callback(new BlockedAddressError(`refusing to connect to a private or local address (${options.hostname})`), null);
					return;
				}
				callback(null, socket);
			});
		},
	});
}

const publicOnly = createAddressCheckedAgent();

/** Test seam — undefined in production. Tests that drive the research tools
 *  offline set a canned responder here (stubbing globalThis.fetch no longer
 *  reaches these tools, which use undici's own fetch). */
export const safeFetchOverride: { current?: (url: string, init: RequestInit) => Promise<Response> } = {};

/** fetch() limited to public addresses. A refusal surfaces as its own
 *  message instead of undici's generic "fetch failed". */
export async function safeFetch(url: string, init: RequestInit = {}, dispatcher: Agent = publicOnly): Promise<Response> {
	if (safeFetchOverride.current) return safeFetchOverride.current(url, init);
	try {
		return (await undiciFetch(url, { ...(init as object), dispatcher })) as unknown as Response;
	} catch (err) {
		const cause = (err as { cause?: unknown }).cause;
		if (cause instanceof BlockedAddressError) throw new Error(cause.message);
		throw err;
	}
}
