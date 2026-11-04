import {
  PRICE_PER_GB_CENTS,
  BYTES_PER_GB,
  usageRepo,
  walletRepo,
  createLogger,
} from "@dominusnode/shared";
import type { UsageRecord } from "@dominusnode/shared";

const log = createLogger("metering");

// PostgreSQL INTEGER max — costs above this would cause INSERT failures
const MAX_COST_CENTS = 2_147_483_647;

export function computeCostCents(totalBytes: number, pricePerGbCents: number = PRICE_PER_GB_CENTS): number {
  if (totalBytes <= 0) return 0;
  if (pricePerGbCents <= 0) return 0; // Free plan — no charge
  // guard against non-finite or extreme values
  if (!Number.isFinite(totalBytes) || totalBytes > Number.MAX_SAFE_INTEGER) {
    return MAX_COST_CENTS;
  }
  const cost = Math.ceil((totalBytes / BYTES_PER_GB) * pricePerGbCents);
  return Math.min(Math.max(cost, 1), MAX_COST_CENTS); // minimum 1 cent, capped at PostgreSQL INTEGER max
}

export async function recordUsage(
  userId: string,
  sessionId: string,
  bytesIn: number,
  bytesOut: number,
  targetHost: string,
  pricePerGbCents: number = PRICE_PER_GB_CENTS,
  connectLatencyMs?: number,
  proxyType: string = "residential",
): Promise<UsageRecord> {
  const totalBytes = bytesIn + bytesOut;
  const costCents = computeCostCents(totalBytes, pricePerGbCents);

  const record = await usageRepo.createUsageRecord({
    user_id: userId,
    session_id: sessionId,
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    cost_cents: costCents,
    proxy_type: proxyType, // Pass actual proxy type instead of hardcoding
    target_host: targetHost,
    connect_latency_ms: connectLatencyMs ?? null,
  });

  log.info("usage recorded", {
    userId,
    sessionId,
    bytesIn,
    bytesOut,
    costCents,
    connectLatencyMs,
  });

  return record;
}

export async function debitForUsage(
  userId: string,
  costCents: number,
  sessionId: string,
): Promise<boolean> {
  if (costCents <= 0) return true;

  const tx = await walletRepo.debitWallet(
    userId,
    costCents,
    `Proxy usage (session ${sessionId.slice(0, 8)})`,
  );

  if (!tx) {
    log.warn("insufficient balance for debit", { userId, costCents, sessionId });
    return false;
  }

  return true;
}

export {
  computeRelayCharge,
  RelayChargeError,
  RELAY_RAILS,
  RELAY_BYTES_PER_GB,
  MUSD_PER_CENT,
  MAX_RELAY_BYTES,
  MIN_PRICE_PER_GB_MUSD,
  MAX_PRICE_PER_GB_MUSD,
  MAX_NODE_SHARE_BPS,
} from "./relay.js";
export type { RelayRail, RelayZeroReason, RelayChargeInput, RelayCharge } from "./relay.js";
