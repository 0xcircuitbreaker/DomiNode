/**
 * SSRF prevention utilities for the Dominus Node n8n integration.
 *
 * Blocks private IPs, localhost, internal hostnames, embedded credentials,
 * hex/octal/decimal-encoded IPs, IPv4-mapped IPv6, IPv4-compatible IPv6,
 * Teredo (2001:0000::/32), 6to4 (2002::/16), CGNAT, multicast, .localhost,
 * .local, .internal, .arpa TLDs, and IPv6 zone IDs.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Blocked hostnames
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "0.0.0.0",
  "[::]",
  "metadata.google.internal",
  "169.254.169.254",
]);

// ---------------------------------------------------------------------------
// IPv4 normalization (hex, octal, decimal integer)
// ---------------------------------------------------------------------------

/**
 * Normalize non-standard IPv4 representations to standard dotted-decimal.
 * Handles decimal integers (2130706433), hex (0x7f000001), and octal (0177.0.0.1).
 *
 * @returns Normalized dotted-decimal string or null if not a recognizable IP.
 */
export function normalizeIpv4(hostname: string): string | null {
  // Single decimal integer (e.g., 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }

  // Hex notation (e.g., 0x7f000001)
  if (/^0x[0-9a-fA-F]+$/i.test(hostname)) {
    const n = parseInt(hostname, 16);
    if (n >= 0 && n <= 0xffffffff) {
      return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
    }
  }

  // Octal or mixed-radix octets (e.g., 0177.0.0.1)
  const parts = hostname.split(".");
  if (parts.length === 4) {
    const octets: number[] = [];
    for (const part of parts) {
      let val: number;
      if (/^0x[0-9a-fA-F]+$/i.test(part)) {
        val = parseInt(part, 16);
      } else if (/^0\d+$/.test(part)) {
        val = parseInt(part, 8);
      } else if (/^\d+$/.test(part)) {
        val = parseInt(part, 10);
      } else {
        return null;
      }
      if (isNaN(val) || val < 0 || val > 255) return null;
      octets.push(val);
    }
    return octets.join(".");
  }

  return null;
}

// ---------------------------------------------------------------------------
// Private IP detection
// ---------------------------------------------------------------------------

/**
 * Check whether a hostname/IP is a private, loopback, link-local, CGNAT,
 * multicast, or other reserved address.
 *
 * Handles:
 * - Standard IPv4 private ranges (10/8, 172.16/12, 192.168/16, 127/8, 0/8)
 * - CGNAT (100.64/10)
 * - Multicast (224/4) and reserved (240+)
 * - Link-local (169.254/16)
 * - IPv6 loopback (::1), unspecified (::), ULA (fc00::/7), link-local (fe80::/10)
 * - IPv4-mapped IPv6 (::ffff:x.x.x.x), IPv4-compatible IPv6 (::x.x.x.x)
 * - Teredo tunneling (2001:0000::/32) — embeds IPv4 in last 32 bits
 * - 6to4 (2002::/16) — embeds IPv4 in bits 16-48
 * - Bracketed IPv6 ([::1])
 * - IPv6 zone IDs (%eth0)
 */
export function isPrivateIp(hostname: string): boolean {
  let ip = hostname.replace(/^\[|\]$/g, "");

  // Strip IPv6 zone ID (%25eth0, %eth0)
  const zoneIdx = ip.indexOf("%");
  if (zoneIdx !== -1) {
    ip = ip.substring(0, zoneIdx);
  }

  const normalized = normalizeIpv4(ip);
  const checkIp = normalized ?? ip;

  // IPv4 private ranges
  const ipv4Match = checkIp.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // 127.0.0.0/8
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                         // multicast + reserved
    return false;
  }

  // IPv6 private ranges
  const ipLower = ip.toLowerCase();
  if (ipLower === "::1") return true;
  if (ipLower === "::") return true;
  if (ipLower.startsWith("fc") || ipLower.startsWith("fd")) return true;
  if (ipLower.startsWith("fe80")) return true;

  // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:HHHH:HHHH)
  if (ipLower.startsWith("::ffff:")) {
    const embedded = ipLower.slice(7);
    if (embedded.includes(".")) return isPrivateIp(embedded);
    // Hex form: ::ffff:7f00:0001
    const hexParts = embedded.split(":");
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        const reconstructed = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIp(reconstructed);
      }
    }
    return isPrivateIp(embedded);
  }

  // IPv4-compatible IPv6 (::x.x.x.x or ::HHHH:HHHH without ffff)
  if (ipLower.startsWith("::") && !ipLower.startsWith("::ffff:")) {
    const rest = ipLower.slice(2);
    if (rest && rest.includes(".")) return isPrivateIp(rest);
    // Hex form: ::7f00:0001
    const hexParts = rest.split(":");
    if (hexParts.length === 2 && hexParts[0] && hexParts[1]) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        const reconstructed = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIp(reconstructed);
      }
    }
  }

  // Teredo tunneling (2001:0000::/32) — last 32 bits are inverted client IPv4
  if (ipLower.startsWith("2001:0000:") || ipLower.startsWith("2001:0:")) {
    const segments = ipLower.split(":");
    if (segments.length >= 8) {
      const hi = parseInt(segments[6], 16);
      const lo = parseInt(segments[7], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        // Teredo inverts the IPv4 bits
        const invertedIp = `${((hi >> 8) & 0xff) ^ 0xff}.${(hi & 0xff) ^ 0xff}.${((lo >> 8) & 0xff) ^ 0xff}.${(lo & 0xff) ^ 0xff}`;
        return isPrivateIp(invertedIp);
      }
    }
    // If we can't parse it, block conservatively
    return true;
  }

  // 6to4 (2002::/16) — bits 16-48 contain the embedded IPv4
  if (ipLower.startsWith("2002:")) {
    const segments = ipLower.split(":");
    if (segments.length >= 3) {
      const hi = parseInt(segments[1], 16);
      const lo = parseInt(segments[2], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        const embeddedIp = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIp(embeddedIp);
      }
    }
    return true;
  }

  // IPv6 multicast (ff00::/8)
  if (ipLower.startsWith("ff")) return true;

  return false;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Validate a URL for safety before sending through the proxy.
 * Blocks private IPs, localhost, internal hostnames, non-HTTP(S) protocols,
 * and embedded credentials.
 *
 * @throws {Error} If the URL is invalid or targets a private/blocked address.
 */
export function validateUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http: and https: protocols are supported, got ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  if (isPrivateIp(hostname)) {
    throw new Error("Requests to private/internal IP addresses are blocked");
  }

  // .localhost TLD (RFC 6761)
  if (hostname.endsWith(".localhost")) {
    throw new Error("Requests to localhost/loopback addresses are blocked");
  }

  // Internal network hostnames
  if (
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".arpa")
  ) {
    throw new Error("Requests to internal network hostnames are blocked");
  }

  // Block embedded credentials in URL
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }

  return parsed;
}
