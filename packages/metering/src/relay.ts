/**
 * Relay charge math (DESIGN §6.2, §15). Pure BigInt arithmetic, no floats.
 * Units: µUSD (1 USD = 1_000_000 µUSD), GB = 1e9 bytes.
 */

export type RelayRail = "wallet" | "team" | "agentic_wallet" | "x402" | "mpp" | "free";

export const RELAY_RAILS: readonly RelayRail[] = [
  "wallet", "team", "agentic_wallet", "x402", "mpp", "free",
];

export const RELAY_BYTES_PER_GB = 1_000_000_000n;
export const MUSD_PER_CENT = 10_000n;
export const MAX_RELAY_BYTES = 1n << 40n; // 1 TiB
export const MIN_PRICE_PER_GB_MUSD = 1_000n; // $0.001
export const MAX_PRICE_PER_GB_MUSD = 5_000_000n; // $5
export const MAX_NODE_SHARE_BPS = 5_000; // §15 hard ceiling

export type RelayZeroReason = "self_dealing" | "free_rail";

export interface RelayChargeInput {
  bytes: bigint;
  priceMusdPerGb: bigint;
  nodeShareBps: number;
  selfDealing: boolean;
  rail: RelayRail;
}

export interface RelayCharge {
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

  const grossMusd = (bytes * priceMusdPerGb + RELAY_BYTES_PER_GB - 1n) / RELAY_BYTES_PER_GB; // ceil
  let zeroReason: RelayZeroReason | null = null;
  if (selfDealing) zeroReason = "self_dealing";
  else if (rail === "free") zeroReason = "free_rail";

  const nodeMusd = zeroReason ? 0n : (grossMusd * BigInt(nodeShareBps)) / 10_000n; // floor
  const platformMusd = grossMusd - nodeMusd;
  const requesterDebitCents = (grossMusd + MUSD_PER_CENT - 1n) / MUSD_PER_CENT; // ceil

  return { grossMusd, nodeMusd, platformMusd, requesterDebitCents, zeroReason };
}
