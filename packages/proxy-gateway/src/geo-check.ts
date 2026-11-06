import * as net from "node:net";
import { isBlockedCountry, createLogger } from "@dominusnode/shared";
import { classifyAsn, HOSTING_ASNS, loadAsnDbFile, parseHostingAsns, type AsnDb } from "./asn-db.js";

const log = createLogger("proxy:geo");

/**
 * Country + ASN lookups come from the offline ip2asn-combined dataset
 * (asn-db.ts, PDDL), loaded from ASN_DB_FILE. No third-party geo library.
 *
 * Fail-closed rules:
 * - DB missing or corrupt: every public destination is blocked ("UNKNOWN") and
 *   lookupPeerGeo returns null (tunnel refuses public peers: GEO_UNAVAILABLE).
 *   ASN_DB_OPTIONAL does NOT relax this; it only relaxes the per-node ASN
 *   requirement in the tunnel server.
 * - DB loaded, public address without a country (unrouted or "None"): blocked
 *   in production, allowed outside production.
 * - SKIP_GEOIP=1 disables geo checks and skips loading the DB, outside
 *   production only. It is ignored (with an error log) when NODE_ENV=production.
 */
let asnDb: AsnDb | null = null;
let hostingAsns: ReadonlySet<number> = HOSTING_ASNS;
let geoDisabled = false;
let geoInitialized = false;

const isProduction = (): boolean => process.env["NODE_ENV"] === "production";

/**
 * Load the ASN/country database once. Idempotent: safe to call from the
 * entrypoint and from both HTTP and SOCKS5 server startup.
 */
export async function initGeoCheck(): Promise<void> {
  if (geoInitialized) return;
  geoInitialized = true;
  hostingAsns = parseHostingAsns(process.env["HOSTING_ASNS"]);

  if (process.env["SKIP_GEOIP"] === "1") {
    if (isProduction()) {
      log.error("SKIP_GEOIP=1 ignored in production: OFAC geo checks stay enabled");
    } else {
      geoDisabled = true;
      log.warn("geo-check DISABLED via SKIP_GEOIP=1: OFAC sanctions not enforced. Do NOT use in production.");
      return;
    }
  }

  const path = process.env["ASN_DB_FILE"] ?? "data/ip2asn-combined.tsv.gz";
  try {
    asnDb = loadAsnDbFile(path);
    if (asnDb) log.info("ASN/geo database loaded (fail-closed mode)", { v4: asnDb.v4Count, v6: asnDb.v6Count });
    else log.error(`ASN/geo database not found at ${path} (run scripts/update-asn-db.sh): ALL public traffic will be BLOCKED`);
  } catch (err) {
    asnDb = null;
    log.error("ASN/geo database failed to load: ALL public traffic will be BLOCKED", {
      error: err instanceof Error ? err.message.slice(0, 100) : "unknown",
    });
  }
}

/** True when a geo database is loaded (or checks are explicitly disabled outside production). */
export function geoAvailable(): boolean {
  return geoDisabled || asnDb !== null;
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
 * FAIL-CLOSED: blocks all public IPs when the database is unavailable, and
 * public IPs with no known country in production.
 */
export function checkSanctionedCountry(clientIp: string): string | null {
  if (net.isIP(clientIp) === 0) return null;
  if (isPrivateIp(clientIp)) return null;
  if (geoDisabled) return null;

  if (!asnDb) {
    log.warn("geo-check unavailable, blocking non-private IP for compliance", { ip: clientIp });
    return "UNKNOWN";
  }

  const country = asnDb.lookupInfo(clientIp)?.country ?? null;
  if (!country) {
    if (isProduction()) {
      log.warn("unknown country for public IP, blocking (production)", { ip: clientIp });
      return "UNKNOWN";
    }
    return null;
  }

  if (isBlockedCountry(country)) {
    log.warn("blocked sanctioned country", { ip: clientIp, country });
    return country;
  }
  return null;
}

/** Install the ASN/country database directly (tests; null = unavailable). */
export function setAsnDb(db: AsnDb | null, hosting: ReadonlySet<number> = HOSTING_ASNS): void {
  asnDb = db;
  hostingAsns = hosting;
  geoDisabled = false;
  geoInitialized = true;
}

/**
 * Country, ASN and ip_class for a node's peer IP (tunnel auth). Returns null
 * when geo data is unavailable or the address has no country, so the tunnel
 * server fails closed for public peers. ip_class is dc for known hosting
 * ASNs, else residential.
 */
export function lookupPeerGeo(ip: string): { country: string | null; asn: number | null; ipClass: "dc" | "residential" | null } | null {
  if (geoDisabled) return { country: null, asn: null, ipClass: null };
  if (!asnDb) return null;
  try {
    const r = asnDb.lookupInfo(ip);
    if (!r || !r.country) return null;
    return { country: r.country, asn: r.asn, ipClass: classifyAsn(r.asn, hostingAsns) as "dc" | "residential" };
  } catch {
    return null;
  }
}
