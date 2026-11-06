import * as crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { createLogger, invoiceRepo, walletRepo, stripDangerousKeys } from "@dominusnode/shared";
import type { PrepaidRail, PrepaidCallbackResult } from "../types.js";
import { NotConfiguredError } from "../types.js";

/**
 * Tempo prepaid top-up (DESIGN.md §7). The user pays TEMPO_PAY_TO with the
 * charge id as memo; Tempo's webhook confirms. The webhook is HMAC-SHA256
 * signed (header `x-tempo-signature: t=<unix>,v1=<hex>` over `${t}.${rawBody}`),
 * must be fresh (±5 min), ≤16 KB, and credits through atomicCompleteInvoiceAndCredit.
 * The exact Tempo wire format is still to be confirmed; it lives behind PrepaidRail.
 */

const log = createLogger("billing:tempo");
export const TEMPO_MAX_BODY_BYTES = 16 * 1024;
export const TEMPO_SIG_TOLERANCE_S = 300;
const MIN_CENTS = 100;
const MAX_CENTS = 100_000;
const CHARGE_ID_RE = /^tempo_[0-9a-f-]{36}$/;

export interface TempoConfig {
  webhookSecret: string;
  payTo: string;
}

export function tempoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TempoConfig | null {
  const secret = env["TEMPO_WEBHOOK_SECRET"];
  const payTo = env["TEMPO_PAY_TO"];
  if (!secret || !payTo) return null;
  if (secret.length < 32) throw new Error("TEMPO_WEBHOOK_SECRET must be at least 32 characters");
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("TEMPO_PAY_TO must be an EVM address");
  return { webhookSecret: secret, payTo };
}

/** Verify `t=<unix>,v1=<hex>` over `${t}.${body}`. Constant-time; rejects stale timestamps. */
export function verifyTempoSignature(rawBody: Buffer, header: string | undefined, secret: string, nowS: number): boolean {
  if (typeof header !== "string" || header.length > 512) return false;
  const parts = new Map<string, string>();
  for (const kv of header.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !/^\d{1,12}$/.test(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return false;
  if (Math.abs(nowS - Number(t)) > TEMPO_SIG_TOLERANCE_S) return false;
  const mac = crypto.createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  return crypto.timingSafeEqual(mac, Buffer.from(v1, "hex"));
}

export function createTempoRail(cfg: TempoConfig | null, now: () => number = () => Math.floor(Date.now() / 1000)): PrepaidRail {
  return {
    id: "tempo",
    async createCharge(userId, amountCents) {
      if (!cfg) throw new NotConfiguredError("Tempo top-up");
      if (!Number.isInteger(amountCents) || amountCents < MIN_CENTS || amountCents > MAX_CENTS) {
        throw new Error("Invalid amount: must be between $1 and $1,000");
      }
      const chargeId = `tempo_${crypto.randomUUID()}`;
      await invoiceRepo.createInvoice(userId, "tempo", chargeId, amountCents);
      return { chargeId, instructions: { network: "tempo", asset: "USD", payTo: cfg.payTo, amountCents, memo: chargeId } };
    },
    async handleCallback(rawBody: Buffer, headers: IncomingHttpHeaders): Promise<PrepaidCallbackResult | null> {
      if (!cfg) return null;
      if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || rawBody.length > TEMPO_MAX_BODY_BYTES) return null;
      const sig = headers["x-tempo-signature"];
      if (!verifyTempoSignature(rawBody, typeof sig === "string" ? sig : undefined, cfg.webhookSecret, now())) {
        log.warn("tempo webhook signature rejected");
        return null;
      }
      let body: Record<string, unknown>;
      try {
        body = stripDangerousKeys(JSON.parse(rawBody.toString("utf8"))) as Record<string, unknown>;
      } catch {
        return null;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return null;
      const chargeId = body["memo"];
      const status = body["status"];
      const amountCents = body["amountCents"];
      const txRef = body["txHash"];
      if (typeof chargeId !== "string" || !CHARGE_ID_RE.test(chargeId)) return null;
      if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_CENTS) return null;
      if (typeof txRef !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txRef)) return null;
      if (status !== "paid" && status !== "failed" && status !== "pending") return null;

      const invoice = await invoiceRepo.findInvoice("tempo", chargeId);
      if (!invoice || invoice.status === "failed") return null;
      if (status === "failed") {
        await invoiceRepo.failInvoice(invoice.id);
        return { chargeId, status: "failed", amountCents: invoice.amount_cents, userId: invoice.user_id };
      }
      if (status === "pending") return { chargeId, status: "pending", amountCents: invoice.amount_cents, userId: invoice.user_id };
      if (amountCents !== invoice.amount_cents) {
        log.error("tempo amount mismatch", { chargeId });
        return null;
      }
      await walletRepo.atomicCompleteInvoiceAndCredit(
        invoice.id, invoice.user_id, invoice.amount_cents, "tempo", txRef.toLowerCase(), `Tempo top-up $${(invoice.amount_cents / 100).toFixed(2)}`,
      );
      return { chargeId, status: "paid", amountCents: invoice.amount_cents, userId: invoice.user_id };
    },
  };
}
