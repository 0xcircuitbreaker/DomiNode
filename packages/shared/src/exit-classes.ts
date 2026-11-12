/**
 * Exit (egress) classes — single source of truth (ECONOMICS.md "Exit classes").
 *
 * A node's class is the VERIFIED class: the gateway classifies the node's
 * observed egress IP (tunnel peer IP, confirmed by the canary echo probe)
 * against the ASN database and the anonymizer list. A node never chooses its
 * own class; a self-declared class is only compared against the verified one
 * to raise a review flag.
 *
 *  - residential / mobile: consumer access networks
 *  - dc:     hosting / cloud ASNs
 *  - masked: anonymizer egress (VPNs, Cloudflare WARP, Tor exits, iCloud
 *            Private Relay, other proxy networks). Cheaper, flagged more
 *            easily by target sites, served only to class-masked requests.
 *  - unknown (node-only): no ASN/geo data; treated conservatively.
 */

export const EXIT_CLASSES = ["residential", "mobile", "dc", "masked"] as const;
export type ExitClass = (typeof EXIT_CLASSES)[number];
/** Class stored on a node (`unknown` = no classification data). */
export type NodeIpClass = ExitClass | "unknown";
export const NODE_IP_CLASSES: readonly NodeIpClass[] = [...EXIT_CLASSES, "unknown"];
/** network_pricing rows: one per exit class plus 'any' (fallback). */
export const PRICING_CLASSES = ["any", ...EXIT_CLASSES] as const;
export type PricingClass = (typeof PRICING_CLASSES)[number];

export function isExitClass(v: unknown): v is ExitClass {
  return typeof v === "string" && (EXIT_CLASSES as readonly string[]).includes(v);
}
export function isNodeIpClass(v: unknown): v is NodeIpClass {
  return typeof v === "string" && (NODE_IP_CLASSES as readonly string[]).includes(v);
}

/** Default µUSD per GB seeded into network_pricing (admin-tunable afterwards). */
export const DEFAULT_PRICE_PER_GB_MUSD: Readonly<Record<ExitClass, number>> = {
  residential: 500_000,
  mobile: 500_000,
  dc: 200_000,
  masked: 100_000,
};

/**
 * Default tier-credit weight per class in basis points (10000 = 1.0).
 * Applied to the contribution metric used for tier progression.
 */
export const DEFAULT_TIER_WEIGHT_BPS: Readonly<Record<ExitClass, number>> = {
  residential: 10_000,
  mobile: 10_000,
  dc: 4_000,
  masked: 2_500,
};
export const MAX_TIER_WEIGHT_BPS = 10_000;

/**
 * Trust rank: higher = harder to obtain / less likely to be flagged.
 * unknown ranks with masked (conservative).
 */
export const CLASS_TRUST_RANK: Readonly<Record<NodeIpClass, number>> = {
  unknown: 0,
  masked: 0,
  dc: 1,
  residential: 2,
  mobile: 2,
};

/**
 * The more conservative of two observations of the same node (e.g. tunnel
 * peer IP vs probe-echoed egress IP on another address family). Masked wins
 * over unknown since it is positive evidence.
 */
export function conservativeClass(a: NodeIpClass, b: NodeIpClass): NodeIpClass {
  if (a === b) return a;
  if (a === "masked" || b === "masked") return "masked";
  const ra = CLASS_TRUST_RANK[a];
  const rb = CLASS_TRUST_RANK[b];
  if (ra !== rb) return ra < rb ? a : b;
  // Same rank (residential vs mobile): keep the first observation.
  return a;
}

/**
 * True when the verified class is LESS trusted than the class the owner
 * declared (e.g. declared residential, exits via a VPN). unknown never counts
 * as a mismatch: missing data is not evidence.
 */
export function isClassDowngrade(declared: NodeIpClass | null | undefined, verified: NodeIpClass | null | undefined): boolean {
  if (!declared || !verified || verified === "unknown" || declared === "unknown") return false;
  return CLASS_TRUST_RANK[verified] < CLASS_TRUST_RANK[declared];
}

/**
 * Tier weight for a node class. unknown gets the LOWEST configured weight
 * (never more credit than a masked exit). Missing rows fall back to defaults.
 * Result is an integer in [0, 10000].
 */
export function tierWeightBpsFor(cls: NodeIpClass | null | undefined, weights: Partial<Record<ExitClass, number>> = {}): number {
  const w = (c: ExitClass): number => {
    const v = weights[c];
    return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_TIER_WEIGHT_BPS ? (v as number) : DEFAULT_TIER_WEIGHT_BPS[c];
  };
  if (cls && isExitClass(cls)) return w(cls);
  return Math.min(...EXIT_CLASSES.map(w));
}

/**
 * Weighted contribution count: each qualifying exit IP counts for its class
 * weight; the total is floored to whole IPs. Integer math only.
 * Example: 1 residential (10000) + 3 masked (2500 each) = 17500 -> 1;
 * 4 masked = 10000 -> 1; 2 dc (4000) + 1 masked = 10500 -> 1.
 */
export function weightedIpCount(weightsBps: readonly number[]): number {
  let sum = 0;
  for (const w of weightsBps) {
    if (!Number.isInteger(w) || w < 0 || w > MAX_TIER_WEIGHT_BPS) throw new Error("tier weight out of range");
    sum += w;
  }
  return Math.floor(sum / MAX_TIER_WEIGHT_BPS);
}
