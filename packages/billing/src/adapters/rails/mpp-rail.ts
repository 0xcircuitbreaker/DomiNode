import * as crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { query, stripDangerousKeys } from "@dominusnode/shared";
import type { PerRequestRail, VerifyResult, SettleResult } from "../types.js";

/**
 * MPP (Tempo machine payments) per-request rail. The credential check is a
 * pluggable MppVerifier so the Tempo wire format can be swapped in without
 * touching the gateway. Disabled unless MPP_PAY_TO and a verifier
 * (MPP_VERIFIER_SECRET for the built-in HMAC verifier) are configured.
 * Idempotency: claim-hash on mpp_transactions.payment_hash (UNIQUE).
 */

export const MAX_MPP_CREDENTIAL_BYTES = 4096;

export interface MppVerification {
  ok: boolean;
  payer?: string;
  amountMusd?: bigint;
  reason?: string;
}
export interface MppVerifier {
  verify(credential: string, req: { amountMusd: bigint; resource: string }, now: number): MppVerification;
}

/**
 * Interim HMAC verifier: credential = base64url(JSON{payer,amountMusd,resource,expiresAt,nonce}) "." hex(HMAC-SHA256(secret, b64)).
 * Rejects bad signatures (constant-time), expired, under-paid or resource-mismatched credentials.
 */
export function createHmacMppVerifier(secret: string): MppVerifier {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("MPP verifier secret must be at least 32 characters");
  const key = Buffer.from(secret, "utf8");
  return {
    verify(credential, req, now) {
      const dot = credential.indexOf(".");
      if (dot <= 0 || credential.length > MAX_MPP_CREDENTIAL_BYTES) return { ok: false, reason: "malformed credential" };
      const b64 = credential.slice(0, dot);
      const sig = credential.slice(dot + 1);
      if (!/^[0-9a-f]{64}$/.test(sig)) return { ok: false, reason: "bad signature" };
      const expect = crypto.createHmac("sha256", key).update(b64).digest();
      if (!crypto.timingSafeEqual(expect, Buffer.from(sig, "hex"))) return { ok: false, reason: "bad signature" };
      let body: Record<string, unknown>;
      try {
        body = stripDangerousKeys(JSON.parse(Buffer.from(b64, "base64url").toString("utf8"))) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "malformed credential" };
      }
      if (!body || typeof body !== "object") return { ok: false, reason: "malformed credential" };
      const { payer, amountMusd, resource, expiresAt } = body as { payer?: unknown; amountMusd?: unknown; resource?: unknown; expiresAt?: unknown };
      if (typeof payer !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(payer)) return { ok: false, reason: "bad payer" };
      if (typeof amountMusd !== "string" || !/^\d{1,11}$/.test(amountMusd)) return { ok: false, reason: "bad amount" };
      if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt < now) return { ok: false, reason: "expired" };
      if (resource !== req.resource) return { ok: false, reason: "resource mismatch" };
      const amt = BigInt(amountMusd);
      if (amt < req.amountMusd) return { ok: false, reason: "amount insufficient" };
      return { ok: true, payer: payer.toLowerCase(), amountMusd: amt };
    },
  };
}

export interface MppStore {
  claim(paymentHash: string, amountMusd: bigint): Promise<boolean>;
  mark(paymentHash: string, status: "verified" | "settled" | "failed"): Promise<void>;
  release(paymentHash: string): Promise<void>;
}

export const dbMppStore: MppStore = {
  async claim(paymentHash, amountMusd) {
    const r = await query(
      `INSERT INTO mpp_transactions (payment_hash, amount_musd, status) VALUES ($1, $2, 'claimed')
       ON CONFLICT (payment_hash) DO NOTHING`,
      [paymentHash, amountMusd.toString()],
    );
    return (r.rowCount ?? 0) > 0;
  },
  async mark(paymentHash, status) {
    await query(`UPDATE mpp_transactions SET status = $2 WHERE payment_hash = $1`, [paymentHash, status]);
  },
  async release(paymentHash) {
    await query(`DELETE FROM mpp_transactions WHERE payment_hash = $1 AND status IN ('claimed','verified')`, [paymentHash]);
  },
};

export function createMppRail(o: { verifier: MppVerifier | null; payTo: string | null; store?: MppStore; now?: () => number }): PerRequestRail {
  const store = o.store ?? dbMppStore;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    id: "mpp",
    enabled: () => o.verifier !== null && !!o.payTo,
    requirements(r) {
      return { scheme: "mpp", network: "tempo", payTo: o.payTo, amountMusd: r.amountMusd.toString(), resource: r.resource };
    },
    parseHeader(h: IncomingHttpHeaders) {
      const v = h["x-mpp-credential"];
      if (typeof v !== "string" || v.length === 0 || v.length > MAX_MPP_CREDENTIAL_BYTES) return null;
      return v;
    },
    async verify(payload, req): Promise<VerifyResult> {
      const paymentHash = crypto.createHash("sha256").update(payload).digest("hex");
      if (!o.verifier || !o.payTo) return { ok: false, paymentHash, reason: "MPP not configured" };
      const v = o.verifier.verify(payload, req, now());
      if (!v.ok || !v.amountMusd) return { ok: false, paymentHash, reason: v.reason ?? "invalid credential" };
      if (!(await store.claim(paymentHash, v.amountMusd))) return { ok: false, paymentHash, reason: "Payment already used" };
      await store.mark(paymentHash, "verified");
      return { ok: true, payer: v.payer, paymentHash, amountMusd: v.amountMusd };
    },
    async settle(_payload, _req, verified): Promise<SettleResult> {
      if (!verified.ok) return { ok: false, reason: "not verified" };
      await store.mark(verified.paymentHash, "settled");
      return { ok: true, txRef: verified.paymentHash };
    },
    async release(paymentHash) {
      await store.release(paymentHash);
    },
  };
}

/** MPP rail from env: enabled only when MPP_PAY_TO and MPP_VERIFIER_SECRET are set. */
export function mppRailFromEnv(env: NodeJS.ProcessEnv = process.env): PerRequestRail {
  const payTo = env["MPP_PAY_TO"] && /^0x[0-9a-fA-F]{40}$/.test(env["MPP_PAY_TO"]) ? env["MPP_PAY_TO"] : null;
  const secret = env["MPP_VERIFIER_SECRET"];
  return createMppRail({ verifier: secret ? createHmacMppVerifier(secret) : null, payTo });
}
