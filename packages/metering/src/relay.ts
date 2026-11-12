/**
 * Relay charge math (DESIGN §6.2, §15). Pure BigInt arithmetic, no floats.
 * Units: µUSD (1 USD = 1_000_000 µUSD), GB = 1e9 bytes.
 */

import { RELAY_BYTES_PER_GB as RELAY_GB } from "@dominusnode/shared";

export type RelayRail = "wallet" | "team" | "agentic_wallet" | "x402" | "mpp" | "free";

export const RELAY_RAILS: readonly RelayRail[] = [
  "wallet", "team", "agentic_wallet", "x402", "mpp", "free",
];

/** Same unit as @dominusnode/shared RELAY_BYTES_PER_GB, as a bigint. */
export const RELAY_BYTES_PER_GB = BigInt(RELAY_GB);
export const MUSD_PER_CENT = 10_000n;
export const MAX_RELAY_BYTES = 1n << 40n; // 1 TiB
export const MIN_PRICE_PER_GB_MUSD = 1_000n; // $0.001
export const MAX_PRICE_PER_GB_MUSD = 5_000_000n; // $5
export const MAX_NODE_SHARE_BPS = 5_000; // §15 hard ceiling
export const MAX_BUYER_DISCOUNT_BPS = 5_000;
export const DEFAULT_MIN_PLATFORM_MARGIN_BPS = 2_500;

export type RelayZeroReason = "self_dealing" | "free_rail";

export interface RelayChargeInput {
  bytes: bigint;
  priceMusdPerGb: bigint;
  nodeShareBps: number;
  selfDealing: boolean;
  rail: RelayRail;
  /** Requester's owner-tier buyer discount (0..5000), platform-funded. Default 0. */
  buyerDiscountBps?: number;
  /** Platform keeps at least list × this / 10000 after the discount. Default 2500. */
  minPlatformMarginBps?: number;
}

export interface RelayCharge {
  /** price × bytes (ceil): what the node share is computed on. */
  listGrossMusd: bigint;
  /** Platform-funded buyer discount; grossMusd = listGrossMusd - discountMusd. */
  discountMusd: bigint;
  /** What the requester pays. nodeMusd + platformMusd = grossMusd. */
  grossMusd: bigint;
  nodeMusd: bigint;
  platformMusd: bigint;
  requesterDebitCents: bigint;
  zeroReason: RelayZeroReason | null;
}

export class RelayChargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayChargeError";
  }
}

export function computeRelayCharge(input: RelayChargeInput): RelayCharge {
  const { bytes, priceMusdPerGb, nodeShareBps, selfDealing, rail } = input;
  if (typeof bytes !== "bigint" || bytes < 0n || bytes > MAX_RELAY_BYTES) {
    throw new RelayChargeError("bytes must be a bigint in [0, 1 TiB]");
  }
  if (
    typeof priceMusdPerGb !== "bigint" ||
    priceMusdPerGb < MIN_PRICE_PER_GB_MUSD ||
    priceMusdPerGb > MAX_PRICE_PER_GB_MUSD
  ) {
    throw new RelayChargeError("priceMusdPerGb out of range [1000, 5000000]");
  }
  if (!Number.isInteger(nodeShareBps) || nodeShareBps < 0 || nodeShareBps > MAX_NODE_SHARE_BPS) {
    throw new RelayChargeError("nodeShareBps must be an integer in [0, 5000]");
  }
  if (typeof selfDealing !== "boolean") {
    throw new RelayChargeError("selfDealing must be a boolean");
  }
  if (!RELAY_RAILS.includes(rail)) {
    throw new RelayChargeError("invalid rail");
  }
  const discountBps = input.buyerDiscountBps ?? 0;
  const marginBps = input.minPlatformMarginBps ?? DEFAULT_MIN_PLATFORM_MARGIN_BPS;
  if (!Number.isInteger(discountBps) || discountBps < 0 || discountBps > MAX_BUYER_DISCOUNT_BPS) {
    throw new RelayChargeError("buyerDiscountBps must be an integer in [0, 5000]");
  }
  if (!Number.isInteger(marginBps) || marginBps < 0 || marginBps > 10_000) {
    throw new RelayChargeError("minPlatformMarginBps must be an integer in [0, 10000]");
  }

  const listGrossMusd = (bytes * priceMusdPerGb + RELAY_BYTES_PER_GB - 1n) / RELAY_BYTES_PER_GB; // ceil
  let zeroReason: RelayZeroReason | null = null;
  if (selfDealing) zeroReason = "self_dealing";
  else if (rail === "free") zeroReason = "free_rail";

  // Node share is always on the LIST gross: a buyer discount never changes it.
  const listNodeMusd = (listGrossMusd * BigInt(nodeShareBps)) / 10_000n; // floor
  const nodeMusd = zeroReason ? 0n : listNodeMusd;
  // Discount: clamped so platform keeps >= ceil(list × margin) after paying the node.
  let discountMusd = 0n;
  if (discountBps > 0 && rail !== "free" && listGrossMusd > 0n) {
    const want = (listGrossMusd * BigInt(discountBps)) / 10_000n;
    const floor = (listGrossMusd * BigInt(marginBps) + 9_999n) / 10_000n;
    const max = listGrossMusd - listNodeMusd - floor;
    discountMusd = max <= 0n ? 0n : want < max ? want : max;
  }
  const grossMusd = listGrossMusd - discountMusd;
  const platformMusd = grossMusd - nodeMusd;
  const requesterDebitCents = (grossMusd + MUSD_PER_CENT - 1n) / MUSD_PER_CENT; // ceil

  return { listGrossMusd, discountMusd, grossMusd, nodeMusd, platformMusd, requesterDebitCents, zeroReason };
}
