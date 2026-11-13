import * as crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { query, stripDangerousKeys } from "@dominusnode/shared";
import type { PerRequestRail, VerifyResult, SettleResult } from "../types.js";

/**
 * MPP (Machine Payments Protocol) per-request rail, Tempo "charge" intent.
 * See docs/agent-network/PAYMENTS.md.
 *
 * Confirmed against the public spec, "The Payment HTTP Authentication Scheme"
 * (https://www.ietf.org/archive/id/draft-ryan-httpauth-payment-01.txt,
 *  https://github.com/tempoxyz/mpp-specs, https://paymentauth.org/):
 * - Challenge: `WWW-Authenticate: Payment id=..., realm=..., method=..., intent=..., request=..., expires=...`
 *   where `request` is base64url-nopad of JCS (RFC 8785) JSON and `expires` is RFC 3339.
 * - Stateless id binding: id = base64url(HMAC-SHA256(secret, realm|method|intent|request|expires|digest|opaque)).
 * - Credential: `Authorization: Payment <base64url-nopad JSON {challenge, source?, payload}>`.
 * - Receipt: `Payment-Receipt: <base64url JSON {status:"success", method, timestamp, reference}>`.
 * - Single-use proofs; concurrent use of one credential settles at most once.
 * Confirmed against the Tempo method docs (https://mpp.hexdocs.pm/MPP.Methods.Tempo.html,
 * https://tempo.xyz/developers/docs/api/mpp): the charge request is
 * {amount, currency, recipient, methodDetails:{chainId}}; payload {type:"hash", hash}
 * is verified from the transaction receipt over RPC; the payment carries a
 * challenge-bound memo; `source` may bind the presenter (did:pkh).
 *
 * Assumed (not stated in what is public):
 * - The challenge-bound memo is bytes32 = sha256(challenge.id), checked on the
 *   TIP-20 TransferWithMemo log (see tempo.ts for the event).
 * - Only payload.type "hash" (client-broadcast, push mode) is accepted;
 *   "transaction" (server-broadcast, pull mode) is refused.
 * - A forward proxy also accepts the credential in Proxy-Authorization, since
 *   CONNECT clients usually cannot set Authorization on the tunnel request.
 *
 * Replay: the proof (chainId + tx hash) is claimed in mpp_transactions.payment_hash
 * (UNIQUE) before the request is served, so one transfer buys one request.
 */

export const MAX_MPP_CREDENTIAL_BYTES = 4096;
/** Challenge lifetime advertised in `expires`. */
export const MPP_CHALLENGE_TTL_S = 300;
/** mpp_transactions.amount_musd CHECK upper bound ($10,000). */
const MAX_MPP_AMOUNT_MUSD = 10_000_000_000n;
const MAX_RPC_BYTES = 1024 * 1024;
const RPC_TIMEOUT_MS = 10_000;

/** keccak256("TransferWithMemo(address,address,uint256,bytes32)") — TIP-20. */
const TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";

export interface MppConfig {
  secret: string;
  realm: string;
  /** Tempo address that must receive the transfer (lowercase). */
  recipient: string;
  /** TIP-20 token address (lowercase). 6 decimals: 1 base unit = 1 µUSD. */
  currency: string;
  chainId: number;
}

export interface MppChallenge {
  id: string;
  realm: string;
  method: string;
  intent: string;
  request: string;
  expires?: string;
  digest?: string;
  opaque?: string;
}

const b64u = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** RFC 8785 JCS for the plain JSON values used here (strings, safe ints, objects). */
export function jcs(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(",")}}`;
}

/** Stateless challenge id (draft-ryan-httpauth-payment §5.1.2.1). */
export function computeChallengeId(secret: string, c: Omit<MppChallenge, "id">): string {
  const input = [c.realm, c.method, c.intent, c.request, c.expires ?? "", c.digest ?? "", c.opaque ?? ""].join("|");
  return crypto.createHmac("sha256", secret).update(input).digest("base64url");
}

const quote = (s: string) => `"${s.replace(/[\\"]/g, "")}"`;

/**
 * Issue a challenge. Every challenge carries a random 128-bit `opaque`, so each
 * 402 has its own unguessable id (and memo = sha256(id)). Without it the id was
 * a function of (amount, second) only, and anyone polling the 402 could match a
 * victim's on-chain memo to a harvested id and redeem the victim's transfer.
 */
export function buildMppChallenge(cfg: MppConfig, amountMusd: bigint, nowS: number, opaque: string = crypto.randomBytes(16).toString("base64url")): MppChallenge & { header: string } {
  const request = b64u(jcs({
    amount: amountMusd.toString(), currency: cfg.currency, methodDetails: { chainId: cfg.chainId }, recipient: cfg.recipient,
  }));
  const expires = new Date((nowS + MPP_CHALLENGE_TTL_S) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const base = { realm: cfg.realm, method: "tempo", intent: "charge", request, expires, opaque };
  const id = computeChallengeId(cfg.secret, base);
  const header = `Payment id=${quote(id)}, realm=${quote(cfg.realm)}, method="tempo", intent="charge", expires=${quote(expires)}, request=${quote(request)}, opaque=${quote(opaque)}`;
  return { id, ...base, header };
}

/** Pull the credential token out of `Authorization: Payment <tok>` (or Proxy-Authorization). */
export function parseMppAuthorization(h: IncomingHttpHeaders): string | null {
  for (const name of ["authorization", "proxy-authorization"]) {
    const v = h[name];
    if (typeof v !== "string" || v.length > MAX_MPP_CREDENTIAL_BYTES + 16) continue;
    const m = /^Payment\s+([A-Za-z0-9_-]+)\s*$/i.exec(v);
    if (m && m[1]!.length <= MAX_MPP_CREDENTIAL_BYTES) return m[1]!;
  }
  return null;
}

export interface TempoReceiptLog { address: string; topics: string[]; data: string }
export interface TempoReceipt { status: string; logs: TempoReceiptLog[] }
export interface TempoRpc {
  getTransactionReceipt(hash: string): Promise<TempoReceipt | null>;
}

/** JSON-RPC client for eth_getTransactionReceipt: https only, no redirects, 10 s, 1 MB cap. */
export function createTempoRpc(url: string, fetchImpl: typeof fetch = fetch): TempoRpc {
  if (!/^https:\/\/[^\s/]+/.test(url)) throw new Error("MPP_RPC_URL must be an https URL");
  return {
    async getTransactionReceipt(hash) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [hash] }),
        redirect: "manual",
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_RPC_BYTES) throw new Error("RPC response too large");
      const body = stripDangerousKeys(JSON.parse(text)) as { result?: unknown };
      const r = body?.result as TempoReceipt | null | undefined;
      if (!r) return null;
      if (typeof r.status !== "string" || !Array.isArray(r.logs)) throw new Error("malformed receipt");
      return r;
    },
  };
}

export interface MppVerification {
  ok: boolean;
  payer?: string;
  amountMusd?: bigint;
  /**
   * Paid above the per-payment cap (MAX_MPP_AMOUNT_MUSD). The request is served for the cap
   * and the excess is recorded on the claim (mpp_transactions.excess_musd) for reconciliation.
   */
  excessMusd?: bigint;
  /** Single-use proof reference (chain id + tx hash); the replay key. */
  proofRef?: string;
  reason?: string;
}
export interface MppVerifier {
  verify(credential: string, req: { amountMusd: bigint; resource: string }, nowS: number): Promise<MppVerification>;
}

const ADDR_RE = /^0x[0-9a-f]{40}$/;
const topicAddr = (t: string | undefined) => (t && /^0x0{24}[0-9a-fA-F]{40}$/.test(t) ? "0x" + t.slice(26).toLowerCase() : null);

/** Tempo charge verifier: challenge binding + request match + on-chain receipt. */
export function createTempoMppVerifier(cfg: MppConfig, rpc: TempoRpc): MppVerifier {
  return {
    async verify(credential, req, nowS) {
      if (credential.length > MAX_MPP_CREDENTIAL_BYTES) return { ok: false, reason: "malformed-credential" };
      let cred: Record<string, unknown>;
      try {
        cred = stripDangerousKeys(JSON.parse(Buffer.from(credential, "base64url").toString("utf8"))) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "malformed-credential" };
      }
      if (!cred || typeof cred !== "object" || Array.isArray(cred)) return { ok: false, reason: "malformed-credential" };
      const ch = cred["challenge"] as Record<string, unknown> | undefined;
      const payload = cred["payload"] as Record<string, unknown> | undefined;
      if (!ch || typeof ch !== "object" || !payload || typeof payload !== "object") return { ok: false, reason: "malformed-credential" };
      const str = (k: string) => (typeof ch[k] === "string" ? (ch[k] as string) : undefined);
      const c = { id: str("id"), realm: str("realm"), method: str("method"), intent: str("intent"), request: str("request"),
        expires: str("expires"), digest: str("digest"), opaque: str("opaque") };
      if (!c.id || !c.realm || !c.method || !c.intent || !c.request) return { ok: false, reason: "malformed-credential" };
      if (c.method !== "tempo" || c.intent !== "charge") return { ok: false, reason: "method-unsupported" };
      if (c.realm !== cfg.realm) return { ok: false, reason: "invalid-challenge" };
      // Only challenges issued with a random opaque (see buildMppChallenge) are accepted.
      if (!c.opaque || !/^[A-Za-z0-9_-]{22,64}$/.test(c.opaque)) return { ok: false, reason: "invalid-challenge" };
      const expect = Buffer.from(computeChallengeId(cfg.secret, c as Omit<MppChallenge, "id">));
      const got = Buffer.from(c.id);
      if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return { ok: false, reason: "invalid-challenge" };
      const exp = c.expires ? Date.parse(c.expires) : NaN;
      if (!Number.isFinite(exp) || exp / 1000 < nowS) return { ok: false, reason: "payment-expired" };

      let rq: Record<string, unknown>;
      try {
        rq = stripDangerousKeys(JSON.parse(Buffer.from(c.request, "base64url").toString("utf8"))) as Record<string, unknown>;
      } catch {
        return { ok: false, reason: "malformed-credential" };
      }
      const amount = typeof rq["amount"] === "string" && /^\d{1,15}$/.test(rq["amount"]) ? BigInt(rq["amount"]) : null;
      const md = rq["methodDetails"] as Record<string, unknown> | undefined;
      if (amount === null || rq["currency"] !== cfg.currency || rq["recipient"] !== cfg.recipient || md?.["chainId"] !== cfg.chainId) {
        return { ok: false, reason: "invalid-challenge" };
      }
      if (amount < req.amountMusd) return { ok: false, reason: "payment-insufficient" };

      if (payload["type"] !== "hash") return { ok: false, reason: "method-unsupported" };
      const hash = typeof payload["hash"] === "string" ? payload["hash"].toLowerCase() : "";
      if (!/^0x[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: "malformed-credential" };

      let receipt: TempoReceipt | null;
      try {
        receipt = await rpc.getTransactionReceipt(hash);
      } catch {
        return { ok: false, reason: "verification-unavailable" };
      }
      if (!receipt) return { ok: false, reason: "verification-failed: transaction not confirmed" };
      if (receipt.status !== "0x1") return { ok: false, reason: "verification-failed: transaction reverted" };
      const memo = "0x" + crypto.createHash("sha256").update(c.id).digest("hex");
      const recipientTopic = "0x" + "0".repeat(24) + cfg.recipient.slice(2);
      let paid = 0n;
      let from: string | null = null;
      for (const lg of receipt.logs) {
        if (!lg || typeof lg.address !== "string" || !Array.isArray(lg.topics) || typeof lg.data !== "string") continue;
        if (lg.address.toLowerCase() !== cfg.currency) continue;
        const t = lg.topics.map((x) => String(x).toLowerCase());
        if (t[0] !== TRANSFER_WITH_MEMO_TOPIC || t[2] !== recipientTopic || t[3] !== memo) continue;
        if (!/^0x[0-9a-fA-F]{1,64}$/.test(lg.data)) continue;
        const f = topicAddr(t[1]);
        if (!f || (from && f !== from)) continue;
        from = f;
        paid += BigInt(lg.data);
      }
      if (!from || paid === 0n) return { ok: false, reason: "verification-failed: no matching transfer" };
      if (paid < amount) return { ok: false, reason: "payment-insufficient" };
      // Funds already moved on-chain: never reject an overpayment. Accept up to the cap and
      // hand the rest to reconciliation (recorded with the claim, refunded/credited by ops).
      const excess = paid > MAX_MPP_AMOUNT_MUSD ? paid - MAX_MPP_AMOUNT_MUSD : 0n;
      if (excess > 0n) paid = MAX_MPP_AMOUNT_MUSD;
      const source = cred["source"];
      if (source !== undefined) {
        if (typeof source !== "string" || source.toLowerCase() !== `did:pkh:eip155:${cfg.chainId}:${from}`) {
          return { ok: false, reason: "verification-failed: source mismatch" };
        }
      }
      if (!ADDR_RE.test(from)) return { ok: false, reason: "verification-failed" };
      return { ok: true, payer: from, amountMusd: paid, ...(excess > 0n ? { excessMusd: excess } : {}), proofRef: `tempo:${cfg.chainId}:${hash}` };
    },
  };
}

export interface MppStore {
  /** excessMusd: overpayment above the cap, stored for reconciliation (omitted when 0). */
  claim(paymentHash: string, amountMusd: bigint, excessMusd?: bigint): Promise<boolean>;
  mark(paymentHash: string, status: "verified" | "settled" | "failed"): Promise<void>;
  /**
   * The request was refused after the transfer was verified (funds already moved):
   * keep the claim as 'refund_due'. Never deletes it (the claim is the only record).
   */
  release(paymentHash: string): Promise<void>;
  /**
   * Record money owed back to the payer on the claim: refundMusd owed, creditedCents
   * credited to the payer's wallet-identity user. The claim becomes 'refunded' only
   * when closeClaim and the whole amount was credited; otherwise it stays
   * 'refund_due' (sub-cent remainders and failed credits stay visible).
   */
  recordRefund(paymentHash: string, r: { userId: string | null; refundMusd: bigint; creditedCents: number; reason: string; closeClaim: boolean }): Promise<void>;
}

export const dbMppStore: MppStore = {
  async claim(paymentHash, amountMusd, excessMusd = 0n) {
    const r = await query(
      `INSERT INTO mpp_transactions (payment_hash, amount_musd, excess_musd, status) VALUES ($1, $2, $3, 'claimed')
       ON CONFLICT (payment_hash) DO NOTHING`,
      [paymentHash, amountMusd.toString(), excessMusd.toString()],
    );
    return (r.rowCount ?? 0) > 0;
  },
  async mark(paymentHash, status) {
    await query(`UPDATE mpp_transactions SET status = $2 WHERE payment_hash = $1`, [paymentHash, status]);
  },
  async release(paymentHash) {
    await query(`UPDATE mpp_transactions SET status = 'refund_due' WHERE payment_hash = $1 AND status IN ('claimed','verified')`, [paymentHash]);
  },
  async recordRefund(paymentHash, r) {
    const full = BigInt(r.creditedCents) * 10_000n === r.refundMusd;
    await query(
      `UPDATE mpp_transactions SET user_id = COALESCE($2::uuid, user_id), refund_musd = refund_musd + $3::bigint,
         refunded_cents = refunded_cents + $4::int, refund_reason = $5,
         status = CASE WHEN $6::boolean AND status IN ('claimed','verified','refund_due') THEN 'refunded' ELSE status END
       WHERE payment_hash = $1`,
      [paymentHash, r.userId, r.refundMusd.toString(), r.creditedCents, r.reason.slice(0, 200), r.closeClaim && full],
    );
  },
};

/** Replay key: sha256 of the proof reference (never of the credential, which a payer can re-wrap). */
export const mppPaymentHash = (proofRef: string) => crypto.createHash("sha256").update(proofRef).digest("hex");

/** Payment-Receipt header value (draft §5.3). */
export function buildMppReceipt(reference: string, nowS: number): string {
  return b64u(JSON.stringify({ status: "success", method: "tempo", timestamp: new Date(nowS * 1000).toISOString(), reference }));
}

export interface MppRail extends PerRequestRail {
  challenge(amountMusd: bigint): (MppChallenge & { header: string }) | null;
  recordRefund: MppStore["recordRefund"];
}

export function createMppRail(o: { verifier: MppVerifier | null; config: MppConfig | null; store?: MppStore; now?: () => number }): MppRail {
  const store = o.store ?? dbMppStore;
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const enabled = () => o.verifier !== null && o.config !== null;
  return {
    id: "mpp",
    enabled,
    challenge(amountMusd) {
      return o.config ? buildMppChallenge(o.config, amountMusd, now()) : null;
    },
    requirements(r) {
      const c = o.config ? buildMppChallenge(o.config, r.amountMusd, now()) : null;
      return c ? { scheme: "mpp", method: c.method, intent: c.intent, realm: c.realm, expires: c.expires, wwwAuthenticate: c.header } : null;
    },
    parseHeader(h: IncomingHttpHeaders) {
      return parseMppAuthorization(h);
    },
    async verify(payload, req): Promise<VerifyResult> {
      const credHash = crypto.createHash("sha256").update(payload).digest("hex");
      if (!o.verifier || !o.config) return { ok: false, paymentHash: credHash, reason: "MPP not configured" };
      const v = await o.verifier.verify(payload, req, now());
      if (!v.ok || !v.amountMusd || !v.proofRef) return { ok: false, paymentHash: credHash, reason: v.reason ?? "verification-failed" };
      const paymentHash = mppPaymentHash(v.proofRef);
      const excess = v.excessMusd && v.excessMusd > 0n ? v.excessMusd : 0n;
      const claimed = excess > 0n ? await store.claim(paymentHash, v.amountMusd, excess) : await store.claim(paymentHash, v.amountMusd);
      if (!claimed) return { ok: false, paymentHash, reason: "invalid-challenge: payment already used" };
      await store.mark(paymentHash, "verified");
      return { ok: true, payer: v.payer, paymentHash, amountMusd: v.amountMusd, txRef: v.proofRef };
    },
    async settle(_payload, _req, verified): Promise<SettleResult> {
      // Push mode: funds moved on-chain before verify; settling commits the claim.
      if (!verified.ok) return { ok: false, reason: "not verified" };
      await store.mark(verified.paymentHash, "settled");
      return { ok: true, txRef: verified.txRef ?? verified.paymentHash };
    },
    async release(paymentHash) {
      await store.release(paymentHash);
    },
    async recordRefund(paymentHash, r) {
      await store.recordRefund(paymentHash, r);
    },
  };
}

/**
 * MPP rail from env. Enabled only when MPP_CHALLENGE_SECRET (≥32 chars),
 * MPP_PAY_TO, MPP_CURRENCY, MPP_CHAIN_ID and MPP_RPC_URL are all set.
 */
export function mppConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { config: MppConfig; rpcUrl: string } | null {
  const secret = env["MPP_CHALLENGE_SECRET"];
  const payTo = env["MPP_PAY_TO"];
  const currency = env["MPP_CURRENCY"];
  const chainId = Number(env["MPP_CHAIN_ID"]);
  const rpcUrl = env["MPP_RPC_URL"];
  if (!secret || !payTo || !currency || !env["MPP_CHAIN_ID"] || !rpcUrl) return null;
  if (secret.length < 32) throw new Error("MPP_CHALLENGE_SECRET must be at least 32 characters");
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("MPP_PAY_TO must be an EVM address");
  if (!/^0x[0-9a-fA-F]{40}$/.test(currency)) throw new Error("MPP_CURRENCY must be a TIP-20 token address");
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("MPP_CHAIN_ID must be a positive integer");
  const realm = env["MPP_REALM"] ?? "dominusnode-proxy";
  if (!/^[\x21\x23-\x5b\x5d-\x7e]{1,100}$/.test(realm)) throw new Error("MPP_REALM must be printable ASCII without quotes");
  return { config: { secret, realm, recipient: payTo.toLowerCase(), currency: currency.toLowerCase(), chainId }, rpcUrl };
}

export function mppRailFromEnv(env: NodeJS.ProcessEnv = process.env): MppRail {
  const c = mppConfigFromEnv(env);
  if (!c) return createMppRail({ verifier: null, config: null });
  return createMppRail({ verifier: createTempoMppVerifier(c.config, createTempoRpc(c.rpcUrl)), config: c.config });
}
