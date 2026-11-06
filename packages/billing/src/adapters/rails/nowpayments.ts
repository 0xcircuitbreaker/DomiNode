import type { IncomingHttpHeaders } from "node:http";
import { stripDangerousKeys } from "@dominusnode/shared";
import { createCryptoInvoice, handleIpnCallback } from "../../nowpayments.js";
import type { PrepaidRail, PrepaidCallbackResult } from "../types.js";

/** NOWPayments as a PrepaidRail: thin wrapper, 16 KB body limit, credit via atomicCompleteInvoiceAndCredit. */
export const NOWPAYMENTS_MAX_BODY_BYTES = 16 * 1024;

export const nowpaymentsRail: PrepaidRail = {
  id: "nowpayments",
  async createCharge(userId, amountCents, opts) {
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > 2_147_483_647) throw new Error("Invalid amount");
    const payCurrency = (opts?.["payCurrency"] ?? "usdttrc20") as Parameters<typeof createCryptoInvoice>[2];
    const inv = await createCryptoInvoice(userId, amountCents / 100, payCurrency);
    return { chargeId: inv.invoiceId, instructions: { invoiceUrl: inv.invoiceUrl, payCurrency: inv.payCurrency, priceAmount: inv.priceAmount } };
  },
  async handleCallback(rawBody: Buffer, headers: IncomingHttpHeaders): Promise<PrepaidCallbackResult | null> {
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > NOWPAYMENTS_MAX_BODY_BYTES) return null;
    const sig = headers["x-nowpayments-sig"];
    if (typeof sig !== "string" || sig.length === 0) return null;
    let body: Record<string, unknown>;
    try {
      body = stripDangerousKeys(JSON.parse(rawBody.toString("utf8"))) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const r = await handleIpnCallback(body, sig);
    if (!r) return null;
    const chargeId = typeof body["invoice_id"] === "string" || typeof body["invoice_id"] === "number" ? String(body["invoice_id"]) : "";
    return { chargeId, status: "paid", amountCents: r.amountCents, userId: r.userId };
  },
};
