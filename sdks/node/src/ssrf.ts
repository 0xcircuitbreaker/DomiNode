/**
 * Client-side SSRF guard for proxy.fetch(). The gateway and the node floor
 * re-check after their own DNS resolution; this layer fails fast and blocks
 * DNS-rebinding by resolving the name and checking EVERY returned address.
 */
import * as net from "node:net";
import * as dns from "node:dns";
import { ProxyError } from "./errors.js";

export type LookupAll = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export const defaultLookup: LookupAll = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".arpa"];

/** Decode decimal/hex/octal/mixed IPv4 forms (2130706433, 0x7f000001, 0177.0.0.1, 127.1). Null if not IPv4-like. */
export function normalizeIpv4(host: string): string | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let v: number;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) v = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(v)) return null;
    nums.push(v);
  }
  // inet_aton semantics: the last part fills the remaining bytes.
  const last = nums.pop()!;
  for (const n of nums) if (n > 255) return null;
  const rem = 4 - nums.length;
  if (last >= 2 ** (8 * rem)) return null;
  const bytes = [...nums];
  for (let i = rem - 1; i >= 0; i--) bytes.push(Math.floor(last / 2 ** (8 * i)) % 256);
  return bytes.join(".");
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0)       // 192.0.0.0/24 IETF + 192.0.2.0/24 docs
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || a >= 224;                    // multicast + reserved + broadcast
}

/** Parse an IPv6 literal into 16 bytes (handles ::, embedded dotted IPv4). */
function ipv6Bytes(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let s = ip;
  let tail: number[] = [];
  const dot = s.lastIndexOf(":");
  const v4 = s.slice(dot + 1);
  if (v4.includes(".")) {
    tail = v4.split(".").map(Number);
    s = s.slice(0, dot + 1) + "0:0";
  }
  const [head, rest] = s.split("::");
  const h = head ? head.split(":") : [];
  const r = rest !== undefined ? (rest ? rest.split(":") : []) : [];
  const groups = rest !== undefined ? [...h, ...Array(8 - h.length - r.length).fill("0"), ...r] : h;
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) { const n = parseInt(g, 16); bytes.push(n >> 8, n & 0xff); }
  if (tail.length === 4) bytes.splice(12, 4, ...tail);
  return bytes;
}

export function isPrivateIp(host: string): boolean {
  let ip = host.replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  const v4 = net.isIPv4(ip) ? ip : normalizeIpv4(ip);
  if (v4) return isPrivateV4(v4);
  const b = ipv6Bytes(ip.toLowerCase());
  if (!b) return false;
  const zero10 = b.slice(0, 10).every((x) => x === 0);
  const v4tail = b.slice(12).join(".");
  if (zero10 && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(v4tail); // ::ffff:a.b.c.d
  if (zero10 && b[10] === 0 && b[11] === 0) {
    // ::, ::1, IPv4-compatible ::a.b.c.d — all blocked if the embedded v4 is private (:: and ::1 included)
    return b.slice(12, 15).every((x) => x === 0) ? true : isPrivateV4(v4tail);
  }
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return isPrivateV4(v4tail); // 64:ff9b::/96 NAT64
  if ((b[0] & 0xfe) === 0xfc) return true;                  // fc00::/7 ULA
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site-local
  if (b[0] === 0xff) return true;                           // multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x02) return true;          // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // docs
  return false;
}

/** Validate a target URL for proxy.fetch(): http(s), no userinfo, port 80/443, no local names or private literals. */
export function validateTargetUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new ProxyError("Invalid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ProxyError("Only http: and https: URLs are supported");
  if (u.username || u.password) throw new ProxyError("URLs with embedded credentials are not allowed");
  if (u.port && u.port !== "80" && u.port !== "443") throw new ProxyError("Only ports 80 and 443 are reachable through the relay network");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) throw new ProxyError("URL has no host");
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new ProxyError("Requests to local/internal hostnames are blocked");
  }
  if (isPrivateIp(host)) throw new ProxyError("Requests to private/internal IP addresses are blocked");
  return u;
}

/** DNS-rebinding guard: resolve and reject if ANY address is private. */
export async function assertPublicResolution(hostname: string, lookup: LookupAll = defaultLookup): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new ProxyError("Requests to private/internal IP addresses are blocked");
    return;
  }
  let addrs: Array<{ address: string; family: number }>;
  try { addrs = await lookup(host); } catch { throw new ProxyError(`DNS resolution failed for ${host}`); }
  if (!addrs || addrs.length === 0) throw new ProxyError(`DNS resolution returned no addresses for ${host}`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new ProxyError("Hostname resolves to a private/internal IP address (blocked)");
  }
}
