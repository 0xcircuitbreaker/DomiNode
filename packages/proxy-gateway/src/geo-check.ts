import * as net from "node:net";
import { isBlockedCountry, createLogger } from "@dominusnode/shared";
import { classifyAsn, HOSTING_ASNS, type AsnDb } from "./asn-db.js";

const log = createLogger("proxy:geo");

let geoLookup: ((ip: string) => { country: string } | null) | null = null;
let geoInitialized = false;

/**
 * Initialize geoip-lite. Call once at startup.
 * If geoip-lite fails to load, geo-blocking will DENY all non-private traffic
 * (fail-closed for OFAC compliance).
 */
export async function initGeoCheck(): Promise<void> {
  // Idempotent — safe to call from both HTTP and SOCKS5 server startup
  if (geoInitialized) return;

  // Skip geoip-lite only with explicit opt-in (saves ~185MB RAM for local dev)
  // NEVER use NODE_ENV alone — that could accidentally disable OFAC compliance in production
  if (process.env["SKIP_GEOIP"] === "1") {
    geoInitialized = true;
    geoLookup = () => null; // Allow all traffic when explicitly opted out
    log.warn("geo-check DISABLED via SKIP_GEOIP=1 — OFAC sanctions not enforced. Do NOT use in production.");
    return;
  }

  try {
    const geoip = await import("geoip-lite");
    geoLookup = geoip.default?.lookup ?? geoip.lookup;
    geoInitialized = true;
    log.info("geo-check initialized (fail-closed mode)");
  } catch (err) {
    geoInitialized = true; // Mark as initialized but without lookup
    log.error("geoip-lite not available — ALL non-private traffic will be BLOCKED for compliance", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Check if an IP is in a private/local range (RFC 1918, RFC 4193, loopback) */
function isPrivateIp(ip: string): boolean {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;

  // IPv4 private ranges
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;

  // 172.16.0.0/12 = 172.16.0.0 - 172.31.255.255
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1], 10);
    if (second >= 16 && second <= 31) return true;
  }

  // IPv6 private
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;

  return false;
}

/**
 * Check if a client IP is from a sanctioned country.
 * Returns the blocked country code if blocked, or null if allowed.
 *
 * FAIL-CLOSED: If geoip-lite is not available, blocks all non-private IPs.
 */
export function checkSanctionedCountry(clientIp: string): string | null {
  // Skip invalid IPs
  if (net.isIP(clientIp) === 0) return null;

  // Always allow private/local IPs (dev/testing)
  if (isPrivateIp(clientIp)) return null;

  // Fail-closed: if geo lookup unavailable, block all non-private traffic
  if (!geoLookup) {
    log.warn("geo-check unavailable, blocking non-private IP for compliance", { ip: clientIp });
    return "UNKNOWN";
  }

  const geo = geoLookup(clientIp);
  if (!geo || !geo.country) return null;

  if (isBlockedCountry(geo.country)) {
    log.warn("blocked sanctioned country", { ip: clientIp, country: geo.country });
    return geo.country;
  }

  return null;
}

let asnDb: AsnDb | null = null;
let hostingAsns: ReadonlySet<number> = HOSTING_ASNS;

/** Install the offline ASN database (null = unavailable) and hosting-ASN list. */
export function setAsnDb(db: AsnDb | null, hosting: ReadonlySet<number> = HOSTING_ASNS): void {
  asnDb = db;
  hostingAsns = hosting;
}

/**
 * Country, ASN and ip_class for a node's peer IP (tunnel auth). Returns null
 * when geo data is unavailable so the tunnel server fails closed for public
 * peers. ASN comes from the offline ip2asn dataset (null when not loaded or
 * the address is unrouted); ip_class is dc for known hosting ASNs, else
 * residential, and null without an ASN (keeps any probe classification).
 */
export function lookupPeerGeo(ip: string): { country: string | null; asn: number | null; ipClass: "dc" | "residential" | null } | null {
  if (!geoLookup) return null;
  try {
    const r = geoLookup(ip);
    if (!r || !r.country) return null;
    const asn = asnDb ? asnDb.lookup(ip) : null;
    return { country: r.country.toUpperCase(), asn, ipClass: asn === null ? null : (classifyAsn(asn, hostingAsns) as "dc" | "residential") };
  } catch {
    return null;
  }
}
