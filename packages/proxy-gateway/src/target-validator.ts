import * as dns from "node:dns";
import * as net from "node:net";
import { createLogger } from "@dominusnode/shared";

const log = createLogger("proxy:target-validator");

export function isValidHostname(host: string): boolean {
  if (!host || host.length === 0 || host.length > 253) return false;
  // R31 C-1: Strip IPv6 zone ID before validation (%25-encoded or raw %)
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
  // R26 H-4: Block hex/octal/decimal IP representations that bypass net.isIP()
  if (/^0x[0-9a-fA-F]+$/.test(host)) return false;           // hex IP (0x7f000001)
  if (/^0[0-7]+(\.[0-7]+){0,3}$/.test(host)) return false;   // octal IP (0177.0.0.1)
  if (/^\d+$/.test(host)) return false;                       // decimal IP (2130706433)
  // Domain names: must start and end with alnum, no consecutive dots
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.\-]*[a-zA-Z0-9])?$/.test(host)) return false;
  if (host.includes("..")) return false;
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

function isBlockedIPv4(ip: string): boolean {
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

function expandIPv6(ip: string): string | null {
  if (net.isIP(ip) !== 6) return null;

  // R37 C-1: Handle IPv6 addresses with embedded IPv4 dotted-quad notation
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

function isBlockedIPv6(ip: string): boolean {
  // R31 C-1: Strip IPv6 zone ID before blocking check
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
  // R37 C-1: IPv4-compatible IPv6 addresses (::x.x.x.x or 0:0:0:0:0:0:x.x.x.x)
  // These have prefix 0000:0000:0000:0000:0000:0000: with an embedded IPv4 in the last 32 bits.
  // Different from ::ffff: (IPv4-mapped) — these are deprecated but still parsed by many stacks.
  if (expanded.startsWith("0000:0000:0000:0000:0000:0000:")) {
    const ipv6Groups = expanded.split(":");
    const hi = parseInt(ipv6Groups[6], 16);
    const lo = parseInt(ipv6Groups[7], 16);
    const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    if (isBlockedIPv4(ipv4)) return true;
  }

  // R38 C-8: Teredo tunnel addresses (2001:0000::/32)
  // Format: 2001:0000:SSSS:SSSS:CCCC:CCCC:XXXX:XXXX
  // The embedded IPv4 (client) is in bytes 13-16 (groups 6-7), but bitwise inverted (XOR 0xFF).
  // An attacker can encode 127.0.0.1 or 10.x.x.x inside a Teredo address to bypass SSRF checks.
  if (expanded.startsWith("2001:0000:")) {
    const ipv6Groups = expanded.split(":");
    const g6 = parseInt(ipv6Groups[6], 16);
    const g7 = parseInt(ipv6Groups[7], 16);
    // Invert each byte (XOR 0xFF) to recover the original IPv4
    const b1 = ((g6 >> 8) & 0xff) ^ 0xff;
    const b2 = (g6 & 0xff) ^ 0xff;
    const b3 = ((g7 >> 8) & 0xff) ^ 0xff;
    const b4 = (g7 & 0xff) ^ 0xff;
    const teredoIpv4 = `${b1}.${b2}.${b3}.${b4}`;
    if (isBlockedIPv4(teredoIpv4)) return true;
  }

  // R38 C-8: 6to4 tunnel addresses (2002::/16)
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

function isBlockedIP(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) return isBlockedIPv4(ip);
  if (version === 6) return isBlockedIPv6(ip);
  return false;
}

export function isBlockedTarget(host: string, port: number): boolean {
  if (!isValidHostname(host)) return true;
  if (!isValidPort(port)) return true;
  if (net.isIP(host) !== 0) return isBlockedIP(host);
  return false;
}

/**
 * Resolve a hostname and check all addresses against blocked ranges.
 * Returns the resolved addresses if allowed, or a rejection reason.
 */
async function resolveAndCheck(
  host: string,
): Promise<{ allowed: boolean; reason?: string; addresses?: string[] }> {
  try {
    const addresses = await dns.promises.resolve(host);
    if (addresses.length === 0) {
      return { allowed: false, reason: "DNS resolution returned no addresses" };
    }
    for (const addr of addresses) {
      if (isBlockedIP(addr)) {
        log.warn("DNS resolved to blocked IP", { host, resolvedIp: addr });
        return { allowed: false, reason: "Blocked: target is a private/internal address" };
      }
    }
    return { allowed: true, addresses };
  } catch (err) {
    try {
      const addresses = await dns.promises.resolve6(host);
      for (const addr of addresses) {
        if (isBlockedIP(addr)) {
          log.warn("DNS (AAAA) resolved to blocked IP", { host, resolvedIp: addr });
          return { allowed: false, reason: "Blocked: target is a private/internal address" };
        }
      }
      return { allowed: true, addresses };
    } catch {
      log.warn("DNS resolution failed for target validation — denying by default", {
        host,
        error: err instanceof Error ? err.message : String(err),
      });
      return { allowed: false, reason: "DNS resolution failed" };
    }
  }
}

/**
 * Validate a target host:port for SSRF.
 * Uses double DNS resolution with a short delay to mitigate DNS rebinding attacks.
 * The attacker needs the first resolution to return a public IP and the second
 * to return a private IP — the delay between resolutions makes this significantly harder.
 *
 * Note: Since traffic routes through Webshare (which resolves DNS independently),
 * this is a best-effort defense. Webshare may resolve differently from us.
 */
export async function validateTarget(
  host: string,
  port: number,
): Promise<{ allowed: boolean; reason?: string }> {
  if (!isValidHostname(host)) {
    return { allowed: false, reason: "Invalid hostname characters" };
  }
  if (!isValidPort(port)) {
    return { allowed: false, reason: "Invalid port number" };
  }
  if (net.isIP(host) !== 0) {
    if (isBlockedIP(host)) {
      return { allowed: false, reason: "Blocked: target is a private/internal address" };
    }
    return { allowed: true };
  }

  // First resolution
  const first = await resolveAndCheck(host);
  if (!first.allowed) return first;

  // Brief delay to defeat DNS rebinding (TTL=0 records change between resolutions)
  await new Promise((r) => setTimeout(r, 50));

  // Second resolution — catches rebinding where DNS flips from public→private
  const second = await resolveAndCheck(host);
  if (!second.allowed) return second;

  // Check for discrepancy: if addresses changed between resolutions, warn and block
  if (first.addresses && second.addresses) {
    const firstSet = new Set(first.addresses);
    const changed = second.addresses.some((addr) => !firstSet.has(addr));
    if (changed) {
      log.warn("DNS rebinding suspected: addresses changed between resolutions", {
        host,
        first: first.addresses,
        second: second.addresses,
      });
      return { allowed: false, reason: "DNS rebinding detected: addresses changed between resolutions" };
    }
  }

  return { allowed: true };
}
