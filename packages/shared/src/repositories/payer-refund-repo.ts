import { query } from "../db.js";

/**
 * Refunds owed to per-request payers that cannot use a DominusNode wallet
 * (non-EVM x402 payers such as Solana: their wallet-identity user has no
 * wallet address and can never sign in). Keyed by payer address and payment
 * hash; paid back on-chain by an operator, or applied later. Idempotent per
 * payment hash.
 */
export async function recordOwed(o: {
  payerAddress: string; rail: "x402" | "mpp"; payHash: string; amountMusd: bigint; reason: string;
}): Promise<boolean> {
  if (o.amountMusd <= 0n) return false;
  const r = await query(
    `INSERT INTO payer_refunds_owed (payer_address, rail, pay_hash, amount_musd, reason)
     VALUES ($1, $2, $3, $4::bigint, $5) ON CONFLICT (pay_hash) DO NOTHING`,
    [o.payerAddress.slice(0, 100), o.rail, o.payHash, o.amountMusd.toString(), o.reason.slice(0, 200)],
  );
  return (r.rowCount ?? 0) > 0;
}
