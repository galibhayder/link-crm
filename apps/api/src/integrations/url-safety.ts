/**
 * OUTBOUND URL SAFETY — server-side request forgery (SSRF) protection.
 *
 * The verification service fetches a URL that a user supplied. Without a guard,
 * that is a request from our server to any address we can reach: `127.0.0.1`,
 * `169.254.169.254` (cloud metadata, which hands out credentials), the
 * `10.0.0.0/8` internal network, or a hostname that resolves to one of those.
 *
 * THE ATTACK THIS BLOCKS
 *
 * A user sets a placement's live URL to `http://169.254.169.254/latest/meta-data/`
 * and presses verify. The API fetches it from inside the private network and
 * returns the body to the user. That is a full credential read with one HTTP
 * request, and it is the standard way SSRF escalates from "the server can reach
 * the internet" to "the server's identity is compromised".
 *
 * WHY CHECKING THE STRING IS NOT ENOUGH
 *
 * `http://127.0.0.1` is easy to reject. `http://2130706433` (decimal),
 * `http://0x7f.1` (hex), `http://[::1]` (IPv6 loopback) and `http://localtest.me`
 * (a public DNS name pointing at loopback) all reach the same place. And DNS can
 * change between the check and the connection — "DNS rebinding". So this module:
 *
 *   1. Parses the URL and rejects non-HTTP(S) schemes outright.
 *   2. Rejects obvious internal names before any DNS lookup (cheap, no I/O).
 *   3. Resolves the hostname and checks EVERY returned address, not just the
 *      first — a round-robin record can mix a public and a private address.
 *   4. Returns the resolved address so the caller can pin it, closing the
 *      rebinding window between our check and the socket connect.
 *
 * WHAT IT DOES NOT DO
 *
 * It cannot stop a legitimate public site that later starts serving a redirect to
 * an internal address, which is why redirects are followed MANUALLY and every hop
 * is re-validated (see `fetchSafely`).
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

export class UnsafeUrlError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Refusing to fetch this URL: ${reason}`);
    this.name = "UnsafeUrlError";
    this.reason = reason;
  }
}

/**
 * IPv4 ranges that must never be reached from a server that fetches user input.
 *
 * Taken from the IANA special-purpose registry plus the ranges that appear on
 * every cloud provider's metadata service.
 */
const BLOCKED_V4: Array<{ cidr: [number, number, number, number]; bits: number; label: string }> = [
  { cidr: [0, 0, 0, 0], bits: 8, label: "this network" },
  { cidr: [10, 0, 0, 0], bits: 8, label: "private (10/8)" },
  { cidr: [100, 64, 0, 0], bits: 10, label: "carrier-grade NAT" },
  { cidr: [127, 0, 0, 0], bits: 8, label: "loopback" },
  { cidr: [169, 254, 0, 0], bits: 16, label: "link-local (cloud metadata)" },
  { cidr: [172, 16, 0, 0], bits: 12, label: "private (172.16/12)" },
  { cidr: [192, 0, 0, 0], bits: 24, label: "IETF protocol assignments" },
  { cidr: [192, 168, 0, 0], bits: 16, label: "private (192.168/16)" },
  { cidr: [198, 18, 0, 0], bits: 15, label: "benchmarking" },
  { cidr: [224, 0, 0, 0], bits: 4, label: "multicast" },
  { cidr: [240, 0, 0, 0], bits: 4, label: "reserved" },
];

/** Hostnames that are internal by definition; rejected without a DNS lookup. */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

function ipv4ToInt(parts: number[]): number {
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function matchesV4(ip: string, base: [number, number, number, number], bits: number): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(parts) & mask) === (ipv4ToInt(base) & mask);
}

/** Expand an IPv6 address to its eight 16-bit groups. */
function expandV6(ip: string): number[] | null {
  const bare = ip.split("%")[0]!; // drop a zone id
  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

  // An embedded IPv4 tail ("::ffff:1.2.3.4") occupies two groups.
  const toGroups = (parts: string[]): number[] => {
    const out: number[] = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const v4 = part.split(".").map(Number);
        out.push((v4[0]! << 8) + v4[1]!, (v4[2]! << 8) + v4[3]!);
      } else {
        out.push(parseInt(part, 16));
      }
    }
    return out;
  };

  const headGroups = toGroups(head);
  const tailGroups = toGroups(tail);
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0) return null;
  return [...headGroups, ...Array(missing).fill(0), ...tailGroups];
}

function isBlockedV6(ip: string): string | null {
  const groups = expandV6(ip);
  if (!groups) return "unparseable IPv6 address";

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];

  // :: and ::1
  if (groups.every((g, i) => (i === 7 ? g === 0 || g === 1 : g === 0))) return "IPv6 loopback/unspecified";
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return "IPv6 unique-local (fc00::/7)";
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return "IPv6 link-local (fe80::/10)";
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return "IPv6 multicast";
  // ::ffff:0:0/96 IPv4-mapped — unwrap and re-check as IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    const blocked = blockedIpReason(v4);
    return blocked ? `IPv4-mapped ${v4} → ${blocked}` : null;
  }

  return null;
}

/** Why an already-resolved IP address is off limits, or null when it is fine. */
export function blockedIpReason(ip: string): string | null {
  const version = isIP(ip);

  if (version === 4) {
    for (const range of BLOCKED_V4) {
      if (matchesV4(ip, range.cidr, range.bits)) return range.label;
    }
    return null;
  }

  if (version === 6) return isBlockedV6(ip);

  return `not an IP address: ${ip}`;
}

/**
 * Validate a URL and resolve it, without connecting.
 *
 * Returns the parsed URL plus the addresses it resolved to, so the caller can pin
 * one. Throws `UnsafeUrlError` for anything the server must not fetch.
 */
export async function assertFetchable(rawUrl: string): Promise<{
  url: URL;
  addresses: string[];
}> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("not a valid absolute URL");
  }

  // Only HTTP(S). `file://` reads the local filesystem and `gopher://` speaks
  // arbitrary protocols to internal services — both are classic SSRF payloads.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`unsupported scheme ${url.protocol}`);
  }

  // Credentials in the URL are almost always an attempt to confuse a naive
  // parser, and we have no reason to send them.
  if (url.username || url.password) {
    throw new UnsafeUrlError("URL contains credentials");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (hostname.length === 0) throw new UnsafeUrlError("no hostname");

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new UnsafeUrlError(`${hostname} is an internal hostname`);
  }
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) throw new UnsafeUrlError(`${hostname} is an internal hostname`);
  }

  // A literal IP needs no DNS, and must be checked directly.
  if (isIP(hostname)) {
    const reason = blockedIpReason(hostname);
    if (reason) throw new UnsafeUrlError(`${hostname} is blocked (${reason})`);
    return { url, addresses: [hostname] };
  }

  // Resolve, then check EVERY address. A host with both a public and a private
  // record would otherwise slip through on whichever the OS picked first.
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError(`could not resolve ${hostname}`);
  }

  if (records.length === 0) throw new UnsafeUrlError(`could not resolve ${hostname}`);

  const addresses: string[] = [];
  for (const record of records) {
    const reason = blockedIpReason(record.address);
    if (reason) {
      throw new UnsafeUrlError(`${hostname} resolves to ${record.address} (${reason})`);
    }
    addresses.push(record.address);
  }

  return { url, addresses };
}

/** Non-resolving check, for validating input at the edge before storing it. */
export function assertStorableUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("not a valid absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`unsupported scheme ${url.protocol}`);
  }
  if (url.username || url.password) throw new UnsafeUrlError("URL contains credentials");

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(hostname)) throw new UnsafeUrlError(`${hostname} is an internal hostname`);
  for (const suffix of BLOCKED_SUFFIXES) {
    if (hostname.endsWith(suffix)) throw new UnsafeUrlError(`${hostname} is an internal hostname`);
  }
  if (isIP(hostname)) {
    const reason = blockedIpReason(hostname);
    if (reason) throw new UnsafeUrlError(`${hostname} is blocked (${reason})`);
  }
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  html: string;
  hops: string[];
}

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2_000_000; // 2 MB is far more than any article page needs.

/**
 * DNS REBINDING — why the guard's resolution alone is not enough.
 *
 * `assertFetchable` resolves a hostname, checks the addresses, and returns. Then
 * `fetch(url)` resolves the SAME hostname AGAIN, and that second answer is the one
 * the socket connects to. An attacker controlling DNS can return a public address
 * for our check and 127.0.0.1 for the connection — a TTL of 0 makes the race
 * trivial, and it is the standard way an SSRF filter that "checks the hostname" is
 * defeated.
 *
 * The mitigation is to PIN the address we validated: resolve once, connect to that
 * literal address, and carry the original Hostname in the Host header so virtual
 * hosting still works. `fetch` cannot express this, so the request is made with
 * `node:https`/`node:http` directly and `lookup` is overridden to return the
 * pinned address, which makes a second resolution impossible.
 */
export async function fetchSafely(
  rawUrl: string,
  init: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<SafeFetchResult> {
  const timeoutMs = init.timeoutMs ?? 15_000;
  const hops: string[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Validate AND capture the addresses, so the connection pins one of them.
    const { url, addresses } = await assertFetchable(current);
    hops.push(url.toString());

    const response = await requestPinned(url, addresses, timeoutMs, init.headers);

    if (response.status >= 300 && response.status < 400) {
      const location = headerValue(response.headers, "location");
      if (!location) {
        return { finalUrl: url.toString(), status: response.status, html: "", hops };
      }
      // A relative Location is legal; resolve it against the current URL.
      current = new URL(location, url).toString();
      continue;
    }

    const html =
      response.status >= 200 && response.status < 300
        ? decodeCapped(response.body, headerValue(response.headers, "content-type"))
        : "";

    return { finalUrl: url.toString(), status: response.status, html, hops };
  }

  throw new UnsafeUrlError(`too many redirects (more than ${MAX_REDIRECTS})`);
}

interface PinnedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Uint8Array;
}

/** Read a single header value, collapsing the array form Node can return. */
function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Perform one request, connecting to a KNOWN-GOOD address.
 *
 * `lookup` is overridden to hand back the address we already validated, so the
 * DNS answer cannot change between the check and the socket. This is the whole
 * point: without it the check is advisory.
 */
function requestPinned(
  url: URL,
  addresses: string[],
  timeoutMs: number,
  extraHeaders: Record<string, string> = {},
): Promise<PinnedResponse> {
  const pinned = addresses[0];
  if (!pinned) throw new UnsafeUrlError("no address to connect to");

  const isHttps = url.protocol === "https:";
  const transport = isHttps ? httpsRequest : httpRequest;

  return new Promise<PinnedResponse>((resolve, reject) => {
    const req = transport(
      {
        // Connects to the IP, but the Host header keeps the virtual host correct —
        // and for HTTPS, `servername` keeps SNI and certificate validation working
        // against the original hostname rather than the bare IP.
        host: pinned,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.hostname,
        headers: {
          host: url.host,
          "user-agent": "Mozilla/5.0 (compatible; TriveroMarketingVerify/1.0)",
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-GB,en;q=0.9",
          "accept-encoding": "identity",
          connection: "close",
          ...extraHeaders,
        },
        // Overriding lookup is what pins the address. Returning the validated IP
        // means no second DNS answer can be substituted.
        lookup: (_hostname, _options, callback) => {
          (callback as unknown as (err: null, address: string, family: number) => void)(
            null,
            pinned,
            isIP(pinned) === 6 ? 6 : 4,
          );
        },
        timeout: timeoutMs,
        // A verification request has no session, so no cookies are sent and no
        // certificate pinning beyond the default validation is relaxed.
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Uint8Array[] = [];
        let total = 0;

        res.on("data", (chunk: Buffer) => {
          if (total >= MAX_BYTES) {
            // Stop reading, but let the response finish so the socket closes
            // cleanly rather than being destroyed mid-stream.
            return;
          }
          const usable = Math.min(chunk.byteLength, MAX_BYTES - total);
          chunks.push(chunk.subarray(0, usable));
          total += usable;
        });

        res.on("end", () => {
          const body = new Uint8Array(total);
          let offset = 0;
          for (const c of chunks) {
            body.set(c, offset);
            offset += c.byteLength;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        });

        res.on("error", reject);
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Decode at most `MAX_BYTES` of HTML, and only for an HTML content type. */
function decodeCapped(body: Uint8Array, contentType: string | undefined): string {
  if (!contentType || !/text\/html|application\/xhtml/i.test(contentType)) return "";
  return new TextDecoder("utf-8", { fatal: false }).decode(body);
}
