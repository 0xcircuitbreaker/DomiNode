/**
 * NodeSelector (DESIGN.md §4): filter -> score -> weighted pick over top K,
 * with a sticky LRU. Error contract matches the old ProviderSelector:
 * sanctioned -> 403, unavailable -> 503 NO_NODES_AVAILABLE.
 */
import { isBlockedCountry, type NetworkPolicy } from "@dominusnode/shared";
import { NodeRegistry, ipPrefix, dayOf, effectiveReputation, type LiveNode } from "./registry.js";

export const TOP_K = 10;
export const STICKY_TTL_MS = 10 * 60_000;
export const STICKY_CAP = 100_000;
const BYTES_PER_GB = 1_000_000_000;
const MIN_HEALTH = 0.2;

export interface SelectOpts {
  country?: string;
  ipClass?: "residential" | "dc" | "mobile";
  requesterUserId: string;
  requesterWallet?: string;
  requesterTeamId?: string;
  clientIp: string;
  targetHost: string;
  port: number;
  sticky?: string;
  excludeNodeIds?: string[];
}

export class NodeSelectionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(readonly kind: "sanctioned" | "unavailable", message: string) {
    super(message);
    this.name = "NodeSelectionError";
    this.status = kind === "sanctioned" ? 403 : 503;
    this.code = kind === "sanctioned" ? "SANCTIONED_COUNTRY" : "NO_NODES_AVAILABLE";
  }
}

/** Approximate registrable domain (eTLD+1) for burn cooldowns; IPs are returned as-is. */
export function etld1(host: string): string {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":")) return h;
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const sld = parts[parts.length - 2];
  // Common two-level public suffixes (co.uk, com.au, ...).
  const twoLevel = parts[parts.length - 1].length === 2 && ["co", "com", "net", "org", "gov", "ac", "edu"].includes(sld);
  return parts.slice(twoLevel ? -3 : -2).join(".");
}

export interface SelectorOptions {
  getPolicy: () => NetworkPolicy;
  random?: () => number;
  now?: () => number;
  topK?: number;
  stickyTtlMs?: number;
  stickyCap?: number;
}

export class NodeSelector {
  private sticky = new Map<string, { nodeId: string; expires: number }>();
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly topK: number;
  private readonly stickyTtl: number;
  private readonly stickyCap: number;

  constructor(private readonly registry: NodeRegistry, private readonly opts: SelectorOptions) {
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.topK = opts.topK ?? TOP_K;
    this.stickyTtl = opts.stickyTtlMs ?? STICKY_TTL_MS;
    this.stickyCap = opts.stickyCap ?? STICKY_CAP;
  }

  get stickySize(): number {
    return this.sticky.size;
  }

  private isSanctioned(cc: string, policy: NetworkPolicy): boolean {
    const u = cc.toUpperCase();
    return isBlockedCountry(u) || policy.sanctionedCountries.includes(u);
  }

  /** Whether a node passes every §4 filter for this request. */
  eligible(n: LiveNode, o: SelectOpts, policy: NetworkPolicy, now: number, exclude: Set<string>, clientPrefix: string): boolean {
    if (!n.ready || !n.tunnel.isOpen || n.status !== "active") return false;
    if (exclude.has(n.nodeId)) return false;
    if (n.cooldownUntil > now || n.health < MIN_HEALTH) return false;
    if (!n.country || this.isSanctioned(n.country, policy)) return false;
    if (o.country && n.country !== o.country.toUpperCase()) return false;
    if (o.ipClass && n.ipClass !== o.ipClass) return false;
    // Self-dealing: owner, wallet, team or the requester's /24.
    if (n.ownerUserId === o.requesterUserId) return false;
    if (o.requesterWallet && n.ownerWallet.toLowerCase() === o.requesterWallet.toLowerCase()) return false;
    if (o.requesterTeamId && n.ownerTeamId === o.requesterTeamId) return false;
    if (n.prefix24 === clientPrefix) return false;
    // Caps: streams, GB/day, req/s.
    const maxStreams = Math.min(n.maxStreams, policy.nodeDefaults.maxStreams);
    if (n.tunnel.openStreams >= maxStreams) return false;
    const gbDay = Math.min(n.maxGbDay, policy.nodeDefaults.maxGbDay);
    if (n.day === dayOf(now) && n.bytesToday >= gbDay * BYTES_PER_GB) return false;
    const recent = n.recentOpens.filter((t) => now - t < 1000).length;
    const policyRps = policy.requesterLimits.reqPerSec * 10;
    const rps = n.maxReqPerSec ? Math.min(n.maxReqPerSec, policyRps) : policyRps;
    if (recent >= rps) return false;
    // Port allowed by policy and the node.
    if (!policy.ports.includes(o.port) || !n.ports.includes(o.port)) return false;
    const until = n.cooldowns.get(etld1(o.targetHost));
    if (until !== undefined && until > now) return false;
    return true;
  }

  score(n: LiveNode, medianEarnings: number): number {
    const rep = effectiveReputation(n) / 10000;
    const fairness = medianEarnings > 0 && n.earningsTodayMusd > 2 * medianEarnings
      ? (2 * medianEarnings) / n.earningsTodayMusd : 1;
    const floor = n.floorHashKnown ? 1 : 0.5;
    return rep * rep * Math.max(0, Math.min(1, n.health)) * (1 / (1 + n.tunnel.openStreams)) * fairness * floor;
  }

  select(o: SelectOpts): LiveNode {
    const policy = this.opts.getPolicy();
    if (o.country && this.isSanctioned(o.country, policy)) {
      throw new NodeSelectionError("sanctioned", `Country ${o.country.toUpperCase()} is sanctioned`);
    }
    const now = this.now();
    const exclude = new Set(o.excludeNodeIds ?? []);
    const clientPrefix = ipPrefix(o.clientIp);

    if (o.sticky) {
      const key = `${o.requesterUserId}:${o.sticky}`;
      const e = this.sticky.get(key);
      if (e) {
        this.sticky.delete(key);
        const n = this.registry.get(e.nodeId);
        if (e.expires > now && n && this.eligible(n, o, policy, now, exclude, clientPrefix)) {
          this.sticky.set(key, { nodeId: n.nodeId, expires: now + this.stickyTtl });
          return this.take(n, now);
        }
      }
    }

    const pool = o.country ? this.registry.inCountry(o.country) : [...this.registry.all()];
    const candidates = pool.filter((n) => this.eligible(n, o, policy, now, exclude, clientPrefix));
    if (candidates.length === 0) throw new NodeSelectionError("unavailable", "No nodes available");

    const earnings = candidates.map((n) => n.earningsTodayMusd).sort((a, b) => a - b);
    const median = earnings[Math.floor(earnings.length / 2)];
    const scored = candidates.map((n) => ({ n, w: this.score(n, median) }))
      .sort((a, b) => b.w - a.w).slice(0, this.topK);
    const total = scored.reduce((s, x) => s + x.w, 0);
    let pick = scored[0].n;
    if (total > 0) {
      let r = this.random() * total;
      for (const x of scored) {
        r -= x.w;
        if (r < 0) { pick = x.n; break; }
      }
    } else {
      pick = scored[Math.floor(this.random() * scored.length) % scored.length].n;
    }

    if (o.sticky) {
      const key = `${o.requesterUserId}:${o.sticky}`;
      while (this.sticky.size >= this.stickyCap) {
        const oldest = this.sticky.keys().next().value;
        if (oldest === undefined) break;
        this.sticky.delete(oldest);
      }
      this.sticky.set(key, { nodeId: pick.nodeId, expires: now + this.stickyTtl });
    }
    return this.take(pick, now);
  }

  private take(n: LiveNode, now: number): LiveNode {
    n.recentOpens = n.recentOpens.filter((t) => now - t < 1000);
    n.recentOpens.push(now);
    return n;
  }

  /** Drop expired sticky entries. */
  sweepSticky(): void {
    const now = this.now();
    for (const [k, e] of this.sticky) if (e.expires <= now) this.sticky.delete(k);
  }
}
