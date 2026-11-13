import * as crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { createLogger, invoiceRepo, walletRepo, stripDangerousKeys, query } from "@dominusnode/shared";
import type { PrepaidRail, PrepaidCallbackResult } from "../types.js";
import { NotConfiguredError } from "../types.js";

/**
 * Tempo prepaid top-up (DESIGN.md §7, docs/agent-network/PAYMENTS.md).
 *
 * Confirmed against public Tempo docs:
 * - TIP-20 stablecoin transfers carry a 32-byte memo and emit
 *   `TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)`
 *   (https://rustdocs.tempo.xyz/tempo_precompiles/tip20/ITIP20/index.html,
 *    https://docs.tempo.xyz/guide/payments/transfer-memos). topic0 below is
 *   keccak256 of that signature. TIP-20 stablecoins use 6 decimals, so one base
 *   unit is 1 µUSD and a cent is 10_000 base units.
 *
 * Assumed (Tempo publishes no payment-confirmation webhook as of 2026-11):
 * - Confirmation reaches us as a POST from the operator's chain watcher, which
 *   reports the TransferWithMemo log it saw. The POST is HMAC-SHA256 signed
 *   (`x-tempo-signature: t=<unix>,v1=<hex>` over `${t}.${rawBody}`), must be
 *   fresh (±5 min) and ≤16 KB. Body:
 *   { status: "paid"|"failed"|"pending", chainId, txHash, token, from, to, amount, memo }
 *   with amount in token base units (decimal string) and memo the bytes32 memo.
 * - The memo is the charge id's UUID (16 bytes) right-padded with zeros to
 *   bytes32, so the charge is recoverable from the on-chain log alone.
 *
 * A "paid" event for an invoice previously marked failed (same memo) is still
 * credited, exactly once, in one transaction (atomicCompleteInvoiceAndCredit
 * with fromStatuses pending|failed).
 */

/** keccak256("TransferWithMemo(address,address,uint256,bytes32)") */
export const TIP20_TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";
/** TIP-20 stablecoin base units per cent (6 decimals). */
const UNITS_PER_CENT = 10_000n;

const log = createLogger("billing:tempo");
export const TEMPO_MAX_BODY_BYTES = 16 * 1024;
export const TEMPO_SIG_TOLERANCE_S = 300;
const MIN_CENTS = 100;
const MAX_CENTS = 100_000;
const CHARGE_ID_RE = /^tempo_[0-9a-f-]{36}$/;

export interface TempoConfig {
  webhookSecret: string;
  payTo: string;
  /** TIP-20 token contract the user must pay in (lowercase 0x address). */
  token: string;
  chainId: number;
}

/** Charge id -> bytes32 memo (UUID bytes, right-padded with zeros). */
export function chargeIdToMemo(chargeId: string): string {
  return "0x" + chargeId.slice("tempo_".length).replace(/-/g, "").toLowerCase() + "0".repeat(32);
}
/** bytes32 memo -> charge id, or null if it is not one of ours. */
export function memoToChargeId(memo: string): string | null {
  const m = /^0x([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})0{32}$/.exec(memo.toLowerCase());
  return m ? `tempo_${m[1]}-${m[2]}-${m[3]}-${m[4]}-${m[5]}` : null;
}

export function tempoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TempoConfig | null {
  const secret = env["TEMPO_WEBHOOK_SECRET"];
  const payTo = env["TEMPO_PAY_TO"];
  if (!secret || !payTo) return null;
  if (secret.length < 32) throw new Error("TEMPO_WEBHOOK_SECRET must be at least 32 characters");
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("TEMPO_PAY_TO must be an EVM address");
  const token = env["TEMPO_TOKEN"] ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) throw new Error("TEMPO_TOKEN must be the TIP-20 token address");
  const chainId = Number(env["TEMPO_CHAIN_ID"]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("TEMPO_CHAIN_ID must be a positive integer");
  return { webhookSecret: secret, payTo: payTo.toLowerCase(), token: token.toLowerCase(), chainId };
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

/**
 * Durable record of every signed 'paid' event (tempo_payments, UNIQUE tx_hash),
 * written before matching, so a transfer that is not credited (wrong amount, a
 * second transfer with the same memo, unknown memo) is never lost: it stays
 * 'unmatched' / 'duplicate' for refund or manual credit.
 */
async function recordTempoPayment(p: { txHash: string; chargeId: string; from: string | null; units: string }): Promise<void> {
  await query(
    `INSERT INTO tempo_payments (tx_hash, charge_id, from_address, amount_units, status)
     VALUES ($1, $2, $3, $4::numeric, 'received') ON CONFLICT (tx_hash) DO NOTHING`,
    [p.txHash, p.chargeId, p.from, p.units],
  );
}
async function markTempoPayment(txHash: string, status: "credited" | "unmatched" | "duplicate", note: string): Promise<void> {
  await query(
    `UPDATE tempo_payments SET status = $2, note = $3 WHERE tx_hash = $1 AND status IN ('received','unmatched')`,
    [txHash, status, note.slice(0, 200)],
  );
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
      return {
        chargeId,
        instructions: {
          network: "tempo", chainId: cfg.chainId, token: cfg.token, payTo: cfg.payTo, amountCents,
          amount: (BigInt(amountCents) * UNITS_PER_CENT).toString(), memo: chargeIdToMemo(chargeId),
        },
      };
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
      const { status, chainId, txHash, token, to, amount, memo } = body as Record<string, unknown>;
      if (status !== "paid" && status !== "failed" && status !== "pending") return null;
      if (chainId !== cfg.chainId) return null;
      if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
      if (typeof token !== "string" || token.toLowerCase() !== cfg.token) return null;
      if (typeof to !== "string" || to.toLowerCase() !== cfg.payTo) return null;
      if (typeof amount !== "string" || !/^\d{1,30}$/.test(amount)) return null;
      const chargeId = typeof memo === "string" ? memoToChargeId(memo) : null;
      if (!chargeId || !CHARGE_ID_RE.test(chargeId)) return null;

      const tx = txHash.toLowerCase();
      if (status === "paid") {
        const fromRaw = (body as Record<string, unknown>)["from"];
        const from = typeof fromRaw === "string" && /^0x[0-9a-fA-F]{40}$/.test(fromRaw) ? fromRaw.toLowerCase() : null;
        // Throws on a DB error: the webhook then answers 5xx and is redelivered.
        await recordTempoPayment({ txHash: tx, chargeId, from, units: amount });
      }
      const invoice = await invoiceRepo.findInvoice("tempo", chargeId);
      if (!invoice) {
        if (status === "paid") {
          await markTempoPayment(tx, "unmatched", "no invoice for memo");
          log.error("tempo payment UNMATCHED: no invoice (recorded for refund)", { chargeId, txHash: tx.slice(0, 12) });
        }
        return null;
      }
      if (status === "failed") {
        if (invoice.status === "pending") await invoiceRepo.failInvoice(invoice.id);
        return invoice.status === "completed" ? null : { chargeId, status: "failed", amountCents: invoice.amount_cents, userId: invoice.user_id };
      }
      if (status === "pending") {
        return invoice.status === "pending" ? { chargeId, status: "pending", amountCents: invoice.amount_cents, userId: invoice.user_id } : null;
      }
      // paid: the on-chain amount must be exactly the invoiced cents.
      const units = BigInt(amount);
      if (units % UNITS_PER_CENT !== 0n || units / UNITS_PER_CENT !== BigInt(invoice.amount_cents)) {
        await markTempoPayment(tx, "unmatched", `amount ${amount} units, invoice ${invoice.amount_cents} cents`);
        log.error("tempo payment UNMATCHED: amount mismatch (recorded for refund)", { chargeId, txHash: tx.slice(0, 12), amount });
        return null;
      }
      // Failed-then-paid: credit once (claims pending|failed -> completed inside the credit tx).
      const r = await walletRepo.atomicCompleteInvoiceAndCredit(
        invoice.id, invoice.user_id, invoice.amount_cents, "tempo", tx,
        `Tempo top-up $${(invoice.amount_cents / 100).toFixed(2)}`, ["pending", "failed"],
      );
      if (r?.claimed) {
        await markTempoPayment(tx, "credited", "");
        if (invoice.status === "failed") log.warn("tempo paid after failed: credited", { chargeId });
      } else {
        // Not claimed: a redelivery of the crediting transfer, or a second
        // transfer for an already-paid invoice. Only the latter is kept for refund.
        const d = await query(
          `UPDATE tempo_payments SET status = 'duplicate', note = 'invoice already paid by another transfer'
           WHERE tx_hash = $1 AND status = 'received'
             AND NOT EXISTS (SELECT 1 FROM wallet_transactions WHERE payment_provider = 'tempo' AND payment_id = $1)`,
          [tx],
        );
        if ((d?.rowCount ?? 0) > 0) log.error("tempo payment DUPLICATE: invoice already paid (recorded for refund)", { chargeId, txHash: tx.slice(0, 12) });
      }
      return { chargeId, status: "paid", amountCents: invoice.amount_cents, userId: invoice.user_id };
    },
  };
}
