import {
  PRICE_PER_GB_CENTS,
  BYTES_PER_GB,
  usageRepo,
  walletRepo,
  createLogger,
} from "@dominode/shared";
import type { UsageRecord } from "@dominode/shared";

const log = createLogger("metering");

export function computeCostCents(totalBytes: number, pricePerGbCents: number = PRICE_PER_GB_CENTS): number {
  if (totalBytes <= 0) return 0;
  const cost = Math.ceil((totalBytes / BYTES_PER_GB) * pricePerGbCents);
  return Math.max(cost, 1); // minimum 1 cent if any bytes transferred
}

export async function recordUsage(
  userId: string,
  sessionId: string,
  bytesIn: number,
  bytesOut: number,
  targetHost: string,
  pricePerGbCents: number = PRICE_PER_GB_CENTS,
): Promise<UsageRecord> {
  const totalBytes = bytesIn + bytesOut;
  const costCents = computeCostCents(totalBytes, pricePerGbCents);

  const record = await usageRepo.createUsageRecord({
    user_id: userId,
    session_id: sessionId,
    bytes_in: bytesIn,
    bytes_out: bytesOut,
    cost_cents: costCents,
    proxy_type: "residential",
    target_host: targetHost,
  });

  log.info("usage recorded", {
    userId,
    sessionId,
    bytesIn,
    bytesOut,
    costCents,
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
