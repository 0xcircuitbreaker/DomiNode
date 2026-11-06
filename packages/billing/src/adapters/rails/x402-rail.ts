import type { IncomingHttpHeaders } from "node:http";
import {
  buildX402Requirements, verifyX402Payment, settleX402Payment, releasePaymentHash, hashPaymentHeader, isX402Enabled,
} from "../../x402.js";
import type { PerRequestRail, VerifyResult, SettleResult } from "../types.js";

export const MAX_X402_HEADER_BYTES = 10_000;

/** "1.234567" USD → 1234567 µUSD; null on any malformed input. */
export function usdStringToMusd(v: string): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(v);
  if (!m) return null;
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/**
 * x402 per-request rail. verify() claims the payment hash first (replay
 * protection: a reused payment is rejected before any facilitator call) and
 * releases it on failure; settle() releases on failure so the payer may retry.
 */
export const x402Rail: PerRequestRail = {
  id: "x402",
  enabled: isX402Enabled,
  requirements(r) {
    return buildX402Requirements({ amountMusd: r.amountMusd });
  },
  parseHeader(h: IncomingHttpHeaders): string | null {
    const v = h["x-payment"];
    if (typeof v !== "string" || v.length === 0 || v.length > MAX_X402_HEADER_BYTES) return null;
    return v;
  },
  async verify(payload, req): Promise<VerifyResult> {
    const paymentHash = hashPaymentHeader(payload);
    const reqs = buildX402Requirements({ amountMusd: req.amountMusd });
    const r = await verifyX402Payment(payload, reqs);
    if (!r.valid) return { ok: false, paymentHash, reason: r.error ?? "Payment verification failed", facilitator: r.facilitator };
    const amountMusd = usdStringToMusd(r.amountUsd);
    if (amountMusd === null || amountMusd < req.amountMusd) {
      await releasePaymentHash(paymentHash).catch(() => {});
      return { ok: false, paymentHash, reason: "Payment amount insufficient", facilitator: r.facilitator };
    }
    return { ok: true, payer: r.payer, paymentHash, amountMusd, facilitator: r.facilitator };
  },
  async settle(payload, req, verified): Promise<SettleResult> {
    if (!verified.ok || !verified.facilitator) return { ok: false, reason: "not verified" };
    try {
      const s = await settleX402Payment(payload, verified.facilitator, buildX402Requirements({ amountMusd: req.amountMusd }));
      return { ok: true, txRef: s.txHash };
    } catch {
      await releasePaymentHash(verified.paymentHash).catch(() => {});
      return { ok: false, reason: "Payment settlement failed" };
    }
  },
  async release(paymentHash: string) {
    await releasePaymentHash(paymentHash);
  },
};
