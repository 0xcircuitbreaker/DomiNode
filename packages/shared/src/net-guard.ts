/**
 * net-guard — pure SSRF / IP-range guard shared by the proxy gateway and node agents.
 *
 * Floor (non-disableable): private, loopback, link-local, CGNAT, cloud metadata
 * (169.254.169.254, fd00:ec2::254), multicast/reserved, IPv4-mapped and
 * IPv4-compatible IPv6, Teredo/6to4-embedded IPv4, the .localhost/.local/.internal/.arpa
 * names and hex/octal/decimal IP forms. No configuration path alters these checks.
 */
import * as dns from "node:dns";
import * as net from "node:net";
import { createLogger } from "./logger.js";

const log = createLogger("shared:net-guard");

export function isValidHostname(host: string): boolean {
  if (!host || host.length === 0 || host.length > 253) return false;
  // Strip IPv6 zone ID before validation (%25-encoded or raw %)
  const zoneIdx = host.indexOf("%");
  if (zoneIdx !== -1) {
    host = host.substring(0, zoneIdx);
    if (!host || host.length === 0) return false;
  }
  // Raw IPv6 addresses (::1) are valid
  if (net.isIP(host) === 6) return true;
  // Bracketed IPv6 ([::1]) is valid — brackets are stripped by CONNECT parser before calling this
  if (host.startsWith("[") && host.endsWith("]")) {
    const inner = host.slice(1, -1);
    return net.isIP(inner) === 6;
  }
  // Block hex/octal/decimal IP representations that bypass net.isIP()
  if (/^0x[0-9a-f]+$/i.test(host)) return false;           // hex IP (0x7f000001)
  if (/^0[0-7]+(\.[0-7]+){0,3}$/.test(host)) return false;   // octal IP (0177.0.0.1)
  if (/^\d+$/.test(host)) return false;                       // decimal IP (2130706433)
  // inet_aton short/mixed forms (127.1, 0x7f.0.0.1, 1.2.3, 10.0.0.1.) — any dotted
  // all-numeric/hex string that is not a canonical IPv4 is rejected
  if (net.isIP(host) !== 4 && /^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*\.?$/i.test(host)) return false;
  // A numeric final label is never a real TLD (e.g. "foo.127")
  if (net.isIP(host) !== 4 && /\.(0x[0-9a-f]+|\d+)$/i.test(host)) return false;
  // Domain names: must start and end with alnum, no consecutive dots
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host)) return false;
  if (host.includes("..")) return false;
  // Block localhost and dangerous TLDs
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) return false;
  if (lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".arpa")) return false;
  // Each label: 1-63 chars, no leading/trailing hyphen
  const labels = host.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  return true;
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0;
}

function inCidr(ip: number, network: number, prefixLen: number): boolean {
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ip & mask) === (network & mask);
}

const BLOCKED_IPV4_RANGES: Array<[number, number]> = [
  [ipv4ToInt("10.0.0.0")!, 8],
  [ipv4ToInt("172.16.0.0")!, 12],
  [ipv4ToInt("192.168.0.0")!, 16],
  [ipv4ToInt("127.0.0.0")!, 8],
  [ipv4ToInt("169.254.0.0")!, 16],
  [ipv4ToInt("224.0.0.0")!, 4],
  [ipv4ToInt("0.0.0.0")!, 8],
  [ipv4ToInt("255.255.255.255")!, 32],
  [ipv4ToInt("100.64.0.0")!, 10],
  [ipv4ToInt("198.18.0.0")!, 15],
  [ipv4ToInt("192.0.0.0")!, 24],
  [ipv4ToInt("192.0.2.0")!, 24],
  [ipv4ToInt("198.51.100.0")!, 24],
  [ipv4ToInt("203.0.113.0")!, 24],
  [ipv4ToInt("240.0.0.0")!, 4],
];

const CLOUD_METADATA_IPV4 = new Set(["169.254.169.254"]);

export function isBlockedIPv4(ip: string): boolean {
  if (CLOUD_METADATA_IPV4.has(ip)) return true;
  const ipInt = ipv4ToInt(ip);
  if (ipInt === null) return false;
  for (const [network, prefix] of BLOCKED_IPV4_RANGES) {
    if (inCidr(ipInt, network, prefix)) return true;
  }
  return false;
}

/**
 * Extract embedded IPv4 dotted-quad from an IPv6 address if present.
 * Handles formats like ::ffff:192.168.1.1, ::192.168.1.1, 0:0:0:0:0:ffff:10.0.0.1
 * Returns the IPv4 part or null if no dotted-quad is embedded.
 */
function extractEmbeddedIPv4(ip: string): string | null {
  // Match a dotted-quad at the end of the IPv6 address
  const match = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (!match) return null;
  const ipv4 = match[1];
  // Validate it's a real IPv4 address
  if (net.isIP(ipv4) !== 4) return null;
  return ipv4;
}

export function expandIPv6(ip: string): string | null {
  if (net.isIP(ip) !== 6) return null;

  // Handle IPv6 addresses with embedded IPv4 dotted-quad notation
  // (e.g., ::ffff:192.168.1.1, ::10.0.0.1). The dotted-quad replaces
  // the last two 16-bit groups per RFC 4291 Section 2.5.5.
  const embeddedIPv4 = extractEmbeddedIPv4(ip);
  if (embeddedIPv4) {
    // Replace the dotted-quad with two hex groups
    const ipv4Parts = embeddedIPv4.split(".").map(p => parseInt(p, 10));
    const hi = ((ipv4Parts[0] << 8) | ipv4Parts[1]) & 0xffff;
    const lo = ((ipv4Parts[2] << 8) | ipv4Parts[3]) & 0xffff;
    const hexSuffix = `${hi.toString(16)}:${lo.toString(16)}`;
    // Replace the dotted-quad portion with hex groups
    ip = ip.replace(embeddedIPv4, hexSuffix);
  }

  let groups: string[];
  if (ip.includes("::")) {
    const [left, right] = ip.split("::");
    const leftGroups = left ? left.split(":") : [];
    const rightGroups = right ? right.split(":") : [];
    const missing = 8 - leftGroups.length - rightGroups.length;
    groups = [...leftGroups, ...Array(missing).fill("0") as string[], ...rightGroups];
  } else {
    groups = ip.split(":");
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, "0").toLowerCase()).join(":");
}

export function isBlockedIPv6(ip: string): boolean {
  // Strip IPv6 zone ID before blocking check
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) {
    ip = ip.substring(0, zoneIdx);
  }
  const expanded = expandIPv6(ip);
  if (!expanded) return false;
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0001") return true;
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0000") return true;
  const prefix = expanded.replace(/:/g, "");
  if (prefix.startsWith("fe8") || prefix.startsWith("fe9") ||
      prefix.startsWith("fea") || prefix.startsWith("feb")) return true;
  // Site-local fec0::/10 (deprecated by RFC 3879 but still routed internally by some stacks)
  if (prefix.startsWith("fec") || prefix.startsWith("fed") ||
      prefix.startsWith("fee") || prefix.startsWith("fef")) return true;
  if (prefix.startsWith("fc") || prefix.startsWith("fd")) return true;
  if (prefix.startsWith("ff")) return true;
  if (expanded === "fd00:0ec2:0000:0000:0000:0000:0000:0254") return true;
  if (expanded.startsWith("0000:0000:0000:0000:0000:ffff:")) {
    const ipv6Groups = expanded.split(":");
    const hi = parseInt(ipv6Groups[6], 16);
    const lo = parseInt(ipv6Groups[7], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIPv4(ipv4);
  }
  // IPv4-translated ::ffff:0:0/96 (RFC 2765 SIIT): decode embedded IPv4 and check it.
  // Never a legitimate public destination either way, so block unconditionally.
  if (expanded.startsWith("0000:0000:0000:0000:ffff:0000:")) return true;
  // IPv4-compatible IPv6 addresses (::x.x.x.x or 0:0:0:0:0:0:x.x.x.x)
  // These have prefix 0000:0000:0000:0000:0000:0000: with an embedded IPv4 in the last 32 bits.
  // Different from ::ffff: (IPv4-mapped) — these are deprecated but still parsed by many stacks.
  if (expanded.startsWith("0000:0000:0000:0000:0000:0000:")) {
    const ipv6Groups = expanded.split(":");
    const hi = parseInt(ipv6Groups[6], 16);
    const lo = parseInt(ipv6Groups[7], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isBlockedIPv4(ipv4)) return true;
  }

  // Teredo tunnel addresses (2001:0000::/32)
  // Format: 2001:0000:SSSS:SSSS:CCCC:CCCC:XXXX:XXXX
  // The embedded IPv4 (client) is in bytes 13-16 (groups 6-7), but bitwise inverted (XOR 0xFF).
  // An attacker can encode 127.0.0.1 or 10.x.x.x inside a Teredo address to bypass SSRF checks.
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48 embed IPv4
  // that a NAT64 gateway will translate; never a valid public target.
  if (expanded.startsWith("0064:ff9b:0000:0000:0000:0000:")) return true;
  if (expanded.startsWith("0064:ff9b:0001:")) return true;
  // Teredo: the whole 2001:0000::/32 range is blocked (server IPv4 in groups 2-3 and
  // obfuscated client IPv4 in groups 6-7 are both attacker-controlled). Never a valid target.
  if (expanded.startsWith("2001:0000:")) return true;
  // 6to4 tunnel addresses (2002::/16)
  // Format: 2002:XXYY:ZZWW:... where XX.YY.ZZ.WW is the embedded IPv4 in bytes 3-6 (groups 1-2).
  // An attacker can encode private IPs inside a 6to4 address to bypass SSRF checks.
  if (expanded.startsWith("2002:")) {
    const ipv6Groups = expanded.split(":");
    const g1 = parseInt(ipv6Groups[1], 16);
    const g2 = parseInt(ipv6Groups[2], 16);
    const b1 = (g1 >> 8) & 0xff;
    const b2 = g1 & 0xff;
    const b3 = (g2 >> 8) & 0xff;
    const b4 = g2 & 0xff;
    const sixToFourIpv4 = `${b1}.${b2}.${b3}.${b4}`;
    if (isBlockedIPv4(sixToFourIpv4)) return true;
  }

  return false;
}

/**
 * True if the literal IP (v4 or v6, optional zone id) is in any blocked range.
 * Non-IP strings return false — use isPublicAddress for a fail-closed check.
 */
export function isBlockedIp(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return false;
}

/** Ports that are never valid proxy targets (SMTP: spam/abuse floor). */
export function isBlockedPort(port: number): boolean {
  return port === 25;
}

export function isBlockedTarget(host: string, port: number): boolean {
  if (!isValidHostname(host)) return true;
  if (!isValidPort(port)) return true;
  if (isBlockedPort(port)) return true;
  if (net.isIP(host) !== 0) return isBlockedIp(host);
  return false;
}

/**
 * True only for a syntactically valid IP literal that is not in any blocked range.
 * Fail-closed: hostnames and garbage return false.
 */
export function isPublicAddress(ip: string): boolean {
  if (typeof ip !== "string" || ip.length === 0 || ip.length > 64) return false;
  const bare = ip.startsWith("[") && ip.endsWith("]") ? ip.slice(1, -1) : ip;
  const zoneIdx = bare.indexOf("%");
  const noZone = zoneIdx === -1 ? bare : bare.substring(0, zoneIdx);
  if (net.isIP(noZone) === 0) return false;
  return !isBlockedIp(noZone);
}

export interface ResolveCheckResult {
  allowed: boolean;
  reason?: string;
  addresses?: string[];
}

const BLOCKED_REASON = "Blocked: target is a private/internal address";

/**
 * Resolve ALL A and AAAA records for a hostname and reject if ANY address is blocked.
 * Fail-closed: if both lookups fail, or nothing resolves, the target is denied.
 * IP literals are checked directly without DNS.
 */
export async function resolveAndCheck(host: string): Promise<ResolveCheckResult> {
  if (net.isIP(host) !== 0) {
    return isBlockedIp(host)
      ? { allowed: false, reason: BLOCKED_REASON }
      : { allowed: true, addresses: [host] };
  }
  if (!isValidHostname(host)) {
    return { allowed: false, reason: "Invalid hostname characters" };
  }
  const [v4, v6] = await Promise.allSettled([
    dns.promises.resolve4(host),
    dns.promises.resolve6(host),
  ]);
  if (v4.status === "rejected" && v6.status === "rejected") {
    const err: unknown = v4.reason;
    log.warn("DNS resolution failed for target validation — denying by default", {
      host,
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: false, reason: "DNS resolution failed" };
  }
  const addresses: string[] = [];
  for (const r of [v4, v6]) {
    if (r.status === "fulfilled" && Array.isArray(r.value)) addresses.push(...r.value);
  }
  if (addresses.length === 0) {
    return { allowed: false, reason: "DNS resolution returned no addresses" };
  }
  for (const addr of addresses) {
    if (typeof addr !== "string" || !isPublicAddress(addr)) {
      log.warn("DNS resolved to blocked IP", { host, resolvedIp: addr });
      return { allowed: false, reason: BLOCKED_REASON };
    }
  }
  return { allowed: true, addresses };
}
