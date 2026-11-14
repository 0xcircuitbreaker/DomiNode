/**
 * Egress (exit) class verification (ECONOMICS.md "Exit classes",
 * ABUSE_CONTROLS.md). The gateway classifies the IP a node's traffic really
 * leaves from — the tunnel peer IP, re-confirmed by the canary echo probe —
 * never anything the node reports about itself.
 *
 * Order (first match wins):
 *  1. masked: IP in the anonymizer IP list (Tor exits, iCloud Private Relay
 *     egress ranges, ...; data/anonymizer-ips.txt), an IPv6 transition
 *     tunnel (Teredo 2001::/32, 6to4 2002::/16), or ASN in the anonymizer ASN
 *     list (data/anonymizer-asns.json + built-ins + ANONYMIZER_ASNS).
 *  2. unknown: no ASN for the address (conservative: lowest tier weight,
 *     never matches a class-* request, priced at the highest price).
 *  3. dc: ASN in the hosting list.
 *  4. residential: ASN in the access-network allowlist (asn-db.ts ACCESS_ASNS
 *     + ACCESS_ASNS / ACCESS_ASNS_FILE).
 *  5. dc: any other routed ASN (reason unlisted_asn). Fails closed: an
 *     unlisted hoster or VPN can never be sold as residential.
 * Mobile carriers are not auto-detected (no carrier list yet); mobile is
 * never assigned from data a node controls.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import { conservativeClass, isBlockedCountry, isClassDowngrade, type NodeIpClass } from "@dominusnode/shared";
import { ACCESS_ASNS, HOSTING_ASNS, type AsnDb } from "./asn-db.js";

/** Built-in anonymizer ASNs (offline-safe default; mirrors data/anonymizer-asns.json v1). */
export const DEFAULT_ANONYMIZER_ASNS: ReadonlySet<number> = new Set([
  13335,  // Cloudflare (WARP egress)
  209242, // Cloudflare London (WARP egress)
  209103, // Proton AG (Proton VPN)
  39351,  // 31173 Services AB (Mullvad)
  136787, // PacketHub S.A. (NordVPN)
  147049, // PacketHub S.A. (NordVPN)
  207137, // PacketHub S.A. (NordVPN)
]);

const MAX_LIST_BYTES = 32 * 1024 * 1024;
const MAX_LIST_ENTRIES = 500_000;

const validAsn = (n: number): boolean => Number.isInteger(n) && n > 0 && n <= 4_294_967_295;

/** Parse data/anonymizer-asns.json ({version, asns:[{asn}]}); bad entries are skipped. */
export function parseAnonymizerAsnJson(text: string): Set<number> {
  const out = new Set<number>();
  const doc = JSON.parse(text) as { asns?: unknown };
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.asns)) throw new Error("anonymizer ASN file: missing asns[]");
  for (const e of doc.asns.slice(0, MAX_LIST_ENTRIES)) {
    const n = typeof e === "number" ? e : e && typeof e === "object" ? Number((e as { asn?: unknown }).asn) : NaN;
    if (validAsn(n)) out.add(n);
  }
  return out;
}

export function parseAsnCsv(env: string | undefined): number[] {
  const out: number[] = [];
  for (const t of (env ?? "").split(",")) {
    const n = Number(t.trim());
    if (t.trim() && validAsn(n)) out.push(n);
  }
  return out;
}

// ─── IP / CIDR set ───────────────────────────────────────────────────

function v4ToBig(ip: string): bigint | null {
  if (!net.isIPv4(ip)) return null;
  return ip.split(".").reduce((a, x) => (a << 8n) | BigInt(Number(x)), 0n);
}

function v6ToBig(ip: string): bigint | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (!net.isIPv6(s)) return null;
  const m = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const v = v4ToBig(m[1]!);
    if (v === null) return null;
    s = s.slice(0, -m[1]!.length) + ((v >> 16n) & 0xffffn).toString(16) + ":" + (v & 0xffffn).toString(16);
  }
  const halves = s.split("::");
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill("0"), ...tail] : head;
  if (groups.length !== 8) return null;
  return groups.reduce((a, g) => (a << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** Normalize ::ffff:a.b.c.d to a.b.c.d; return [family, value]. */
export function ipToBig(ip: string): [4 | 6, bigint] | null {
  const t = ip.trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(t);
  if (mapped) {
    const v = v4ToBig(mapped[1]!);
    return v === null ? null : [4, v];
  }
  const a = v4ToBig(t);
  if (a !== null) return [4, a];
  const b = v6ToBig(t);
  return b === null ? null : [6, b];
}

interface Range { start: bigint; end: bigint }

/** Sorted, merged ranges per family with binary-search membership. */
export class IpRangeSet {
  private v4: Range[] = [];
  private v6: Range[] = [];
  get size(): number {
    return this.v4.length + this.v6.length;
  }
  static from(entries: Iterable<string>): IpRangeSet {
    const s = new IpRangeSet();
    const r4: Range[] = [];
    const r6: Range[] = [];
    let n = 0;
    for (const raw of entries) {
      if (++n > MAX_LIST_ENTRIES) break;
      const e = raw.trim();
      if (!e || e.startsWith("#")) continue;
      const [addr, lenStr] = e.split("/");
      const p = ipToBig(addr ?? "");
      if (!p) continue;
      const bits = p[0] === 4 ? 32 : 128;
      const len = lenStr === undefined ? bits : Number(lenStr);
      if (!Number.isInteger(len) || len < 0 || len > bits) continue;
      // Refuse absurdly wide entries: a typo must not mask the whole internet.
      if (len < (p[0] === 4 ? 8 : 16)) continue;
      const host = BigInt(bits - len);
      const start = (p[1] >> host) << host;
      const end = start + (1n << host) - 1n;
      (p[0] === 4 ? r4 : r6).push({ start, end });
    }
    s.v4 = merge(r4);
    s.v6 = merge(r6);
    return s;
  }
  has(ip: string): boolean {
    const p = ipToBig(ip);
    if (!p) return false;
    const arr = p[0] === 4 ? this.v4 : this.v6;
    let lo = 0;
    let hi = arr.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = arr[mid]!;
      if (p[1] < r.start) hi = mid - 1;
      else if (p[1] > r.end) lo = mid + 1;
      else return true;
    }
    return false;
  }
}

function merge(rs: Range[]): Range[] {
  rs.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const out: Range[] = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1n) {
      if (r.end > last.end) last.end = r.end;
    } else out.push({ ...r });
  }
  return out;
}

/** IPv6 transition tunnels that embed another endpoint (Teredo, 6to4). */
export function isTransitionTunnel(ip: string): boolean {
  const p = ipToBig(ip);
  if (!p || p[0] !== 6) return false;
  const top32 = p[1] >> 96n;
  if (top32 === 0x20010000n) return true; // Teredo 2001:0000::/32
  return p[1] >> 112n === 0x2002n; // 6to4 2002::/16
}

// ─── Classification ──────────────────────────────────────────────────

export interface EgressClassifierData {
  db: AsnDb | null;
  hostingAsns?: ReadonlySet<number>;
  /** Access-network allowlist: the only ASNs classed residential. */
  accessAsns?: ReadonlySet<number>;
  anonymizerAsns?: ReadonlySet<number>;
  anonymizerIps?: IpRangeSet | null;
}

export interface EgressVerdict {
  ipClass: NodeIpClass;
  asn: number | null;
  country: string | null;
  reason: "anonymizer_ip" | "ipv6_tunnel" | "anonymizer_asn" | "no_asn" | "hosting_asn" | "access_asn" | "unlisted_asn" | "invalid_ip";
}

/** Classify an observed egress IP (pure given its data). */
export function classifyEgress(ip: string, d: EgressClassifierData): EgressVerdict {
  if (!ipToBig(ip)) return { ipClass: "unknown", asn: null, country: null, reason: "invalid_ip" };
  let info: { asn: number; country: string | null } | null = null;
  try {
    info = d.db ? d.db.lookupInfo(ip) : null;
  } catch {
    info = null;
  }
  const asn = info?.asn ?? null;
  const country = info?.country ?? null;
  if (d.anonymizerIps?.has(ip)) return { ipClass: "masked", asn, country, reason: "anonymizer_ip" };
  if (isTransitionTunnel(ip)) return { ipClass: "masked", asn, country, reason: "ipv6_tunnel" };
  if (asn !== null && (d.anonymizerAsns ?? DEFAULT_ANONYMIZER_ASNS).has(asn)) {
    return { ipClass: "masked", asn, country, reason: "anonymizer_asn" };
  }
  if (asn === null) return { ipClass: "unknown", asn, country, reason: "no_asn" };
  if ((d.hostingAsns ?? HOSTING_ASNS).has(asn)) return { ipClass: "dc", asn, country, reason: "hosting_asn" };
  if ((d.accessAsns ?? ACCESS_ASNS).has(asn)) return { ipClass: "residential", asn, country, reason: "access_asn" };
  return { ipClass: "dc", asn, country, reason: "unlisted_asn" };
}

// ─── Loading (offline-safe) ──────────────────────────────────────────

export interface AnonymizerLists {
  asns: Set<number>;
  ips: IpRangeSet;
  asnSource: "file" | "builtin";
}

/**
 * Load the anonymizer lists. Missing or bad files fall back to the built-in
 * ASN list and an empty IP list (never fails open to "residential" because a
 * file is missing: anonymizer ASNs are always present).
 */
export function loadAnonymizerLists(
  env: NodeJS.ProcessEnv = process.env,
  warn: (msg: string) => void = () => {},
): AnonymizerLists {
  const asns = new Set(DEFAULT_ANONYMIZER_ASNS);
  let asnSource: "file" | "builtin" = "builtin";
  const asnPath = env["ANONYMIZER_ASNS_FILE"] ?? "data/anonymizer-asns.json";
  try {
    if (fs.existsSync(asnPath) && fs.statSync(asnPath).size <= MAX_LIST_BYTES) {
      for (const n of parseAnonymizerAsnJson(fs.readFileSync(asnPath, "utf8"))) asns.add(n);
      asnSource = "file";
    }
  } catch {
    warn("anonymizer ASN file unreadable; using built-in list");
  }
  for (const n of parseAsnCsv(env["ANONYMIZER_ASNS"])) asns.add(n);

  let ips = new IpRangeSet();
  const ipPath = env["ANONYMIZER_IPS_FILE"] ?? "data/anonymizer-ips.txt";
  try {
    if (fs.existsSync(ipPath) && fs.statSync(ipPath).size <= MAX_LIST_BYTES) {
      ips = IpRangeSet.from(fs.readFileSync(ipPath, "utf8").split("\n"));
    }
  } catch {
    warn("anonymizer IP list unreadable; continuing without it");
  }
  return { asns, ips, asnSource };
}

// ─── Probe-driven re-verification ────────────────────────────────────

export interface VerifiableNode {
  ipClass: NodeIpClass;
  /** Connect-time class (tunnel peer IP); the first probe on a connection starts from it. */
  peerClass?: NodeIpClass;
  /**
   * Peer class tightened by recent probe verdicts (own + same owner/prefix,
   * 30-day window). Base for the first probe on this connection, so a carried
   * verdict is not discarded by that probe.
   */
  connectClass?: NodeIpClass;
  /** ms epoch of the last probe-confirmed egress classification on this gateway. */
  egressVerifiedAt?: number;
  /** True until the first probe on this connection classifies it (not selectable meanwhile). */
  probePending?: boolean;
  /** Country of the tunnel peer IP (what the node is sold under). */
  country?: string | null;
}

export interface EgressVerifierDeps {
  getNode(nodeId: string): VerifiableNode | null | undefined;
  classify(ip: string): { ipClass: NodeIpClass; country?: string | null };
  /**
   * Persist the verified class and the raw probe verdict, and raise the
   * egress_mismatch flag when it is below the declared or connect-time class
   * (nodeRepo.recordVerifiedClass).
   */
  record(nodeId: string, cls: NodeIpClass, opts: { probeClass: NodeIpClass; connectClass: NodeIpClass | null; forceFlag?: boolean }): Promise<unknown>;
  /**
   * Quarantine a node whose probed egress is in a sanctioned (OFAC) country.
   * Without it the node is still made unselectable ("unknown", flagged).
   */
  quarantine?: (nodeId: string, reason: string) => Promise<unknown>;
  /** Called on a country mismatch or sanctioned egress: end every in-flight session on the node. */
  onCountryMismatch?: (nodeId: string) => Promise<unknown> | void;
  /** Called when the class drops below the previous one (end in-flight sessions above it). */
  onDowngrade?: (nodeId: string, from: NodeIpClass, to: NodeIpClass) => Promise<unknown> | void;
  now?: () => number;
  logger?: { warn(msg: string, meta?: Record<string, unknown>): void };
}

/**
 * Handler for probe-echoed egress IPs. The first probe on a connection sets
 * the class to conservative(connect class, observed) (a node that connected
 * while probes are enabled is "unknown" until then); later probes on the same
 * connection only tighten it, so a node cannot upgrade itself by steering one
 * probe. Every verdict is persisted as probe_class so a reconnect cannot shed
 * a downgrade.
 */
export function makeEgressVerifier(d: EgressVerifierDeps): (nodeId: string, egressIp: string) => Promise<NodeIpClass | null> {
  const now = d.now ?? Date.now;
  return async (nodeId, egressIp) => {
    const live = d.getNode(nodeId);
    if (!live) return null;
    const verdict = d.classify(egressIp);
    const observed = verdict.ipClass;
    const first = live.egressVerifiedAt === undefined;
    const base = first ? (live.connectClass ?? live.peerClass ?? live.ipClass) : live.ipClass;
    let next = conservativeClass(base, observed);
    // Country check: the node is sold under its tunnel IP's country, so a
    // probe egress elsewhere (or in a sanctioned country) must not serve.
    const egressCc = verdict.country ? verdict.country.toUpperCase() : null;
    const liveCc = live.country ? live.country.toUpperCase() : null;
    const sanctioned = egressCc !== null && isBlockedCountry(egressCc);
    const countryMismatch = egressCc !== null && liveCc !== null && egressCc !== liveCc;
    if (sanctioned || countryMismatch) {
      next = "unknown"; // never matches a class-* or country-* request
      d.logger?.warn("node egress country mismatch", { nodeId, sanctioned, egressCountry: egressCc, tunnelCountry: liveCc });
    }
    live.egressVerifiedAt = now();
    live.probePending = false;
    const prev = live.ipClass;
    if (next !== prev) {
      d.logger?.warn("node egress reclassified", { nodeId, from: prev, to: next });
      live.ipClass = next; // routing exclusion applies immediately
    }
    if (d.onDowngrade && isClassDowngrade(prev, next)) {
      try {
        await d.onDowngrade(nodeId, prev, next);
      } catch {
        /* sessions still end at max age */
      }
    }
    if ((sanctioned || countryMismatch) && d.onCountryMismatch) {
      try {
        await d.onCountryMismatch(nodeId);
      } catch {
        /* class is already "unknown" (not selectable); sessions still end at max age */
      }
    }
    if (sanctioned && d.quarantine) {
      try {
        await d.quarantine(nodeId, "sanctioned_egress_country");
      } catch {
        /* class is already "unknown"; retried on the next probe */
      }
    }
    await d.record(nodeId, next, { probeClass: observed, connectClass: live.peerClass ?? null, ...(sanctioned || countryMismatch ? { forceFlag: true } : {}) });
    return next;
  };
}
