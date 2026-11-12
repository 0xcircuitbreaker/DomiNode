import { validatePageCursor } from "./nodes.js";
import { randomUUID } from "node:crypto";
import type { HttpClient } from "../http.js";
import type { Money } from "../types.js";
import { invalidArg, ProtocolError } from "../errors.js";
import { assertSigner, sign, type Signer } from "../signer.js";
import { buildWithdrawMessage, extractUserId, assertSameMessage } from "../messages.js";
import { HEX64_RE, qs, toMusd, validateIdempotencyKey, validateIntRange, type MusdInput } from "../validation.js";

export const CREDIT_TX_TYPES = ["earn", "mature", "clawback", "convert", "withdraw", "withdraw_reversal"] as const;
export type CreditTxType = (typeof CREDIT_TX_TYPES)[number];

/** Server cursor format (a positive ledger id). */
export const CURSOR_RE = /^[1-9][0-9]{0,18}$/;

export const MIN_CONVERT_MUSD = 10_000n;          // 1 cent
export const MAX_CONVERT_MUSD = 10_000_000_000n;  // $10,000
export const MIN_WITHDRAW_MUSD = 1_000_000n;      // $1
export const MAX_WITHDRAW_MUSD = 100_000_000_000n; // $100,000

export interface CreditsBalance {
  pending: Money;
  available: Money;
  frozen: boolean;
  autoConvertPct: number;
  tier: { id: number; name: string; rank: number; holdDays: number; dailyWithdrawLimit: Money };
  taxFormStatus: "not_required" | "requested" | "received" | "rejected";
  ytdPaid: Money;
  payoutsEnabled: boolean;
  minWithdraw: Money;
  /** Discount on relay purchases from your owner tier, in basis points (0 unless you run a node). */
  buyerDiscountBps: number;
}

export interface CreditTransaction {
  id: string;
  type: CreditTxType;
  amount: Money;
  relayChargeId: string | null;
  /** Payout id for withdraw / withdraw_reversal. */
  reference: string | null;
  createdAt: string;
}

export interface ConvertResult {
  converted: Money;
  convertedCents: number;
  duplicate: boolean;
}

export type PayoutStatus = "pending" | "held_tax" | "held_frozen" | "submitted" | "confirmed" | "failed" | "reversed";

export interface Payout {
  id: string;
  amount: Money;
  trigger: "on_demand" | "auto" | string;
  status: PayoutStatus;
  txHash: string | null;
  createdAt: string;
  failureReason?: string | null;
  address?: string;
  chain?: string;
  updatedAt?: string;
}

export interface WithdrawResult {
  payout: Payout;
  duplicate: boolean;
}

/** New idempotency key: "dn-" + UUIDv4 (fits [A-Za-z0-9_-]{8,120}). */
export function newIdempotencyKey(): string {
  return `dn-${randomUUID()}`;
}

/** Node-operator earnings (µUSD). /v1 agent routes. */
export class CreditsResource {
  constructor(private http: HttpClient) {}

  /** GET /v1/credits */
  async balance(): Promise<CreditsBalance> {
    return this.http.get("/v1/credits", "agent");
  }

  /** GET /v1/credits/transactions — cursor pagination (pass the previous nextCursor). */
  async transactions(opts: { limit?: number; cursor?: string; type?: CreditTxType } = {}): Promise<{ transactions: CreditTransaction[]; nextCursor: string | null }> {
    if (opts.limit !== undefined) validateIntRange(opts.limit, "limit", 1, 200);
    if (opts.cursor !== undefined && (typeof opts.cursor !== "string" || !CURSOR_RE.test(opts.cursor))) throw invalidArg("cursor must be a nextCursor value");
    if (opts.type !== undefined && !(CREDIT_TX_TYPES as readonly string[]).includes(opts.type)) {
      throw invalidArg(`type must be one of ${CREDIT_TX_TYPES.join(", ")}`);
    }
    return this.http.get(`/v1/credits/transactions${qs({ limit: opts.limit, cursor: opts.cursor, type: opts.type })}`, "agent");
  }

  /**
   * Iterate every credit transaction (newest first), following nextCursor. `limit` is the page size.
   * Stops when the server returns no nextCursor or an empty page.
   */
  async *iterTransactions(opts: { limit?: number; type?: CreditTxType; cursor?: string } = {}): AsyncGenerator<CreditTransaction, void, undefined> {
    let cursor = opts.cursor;
    for (;;) {
      const page = await this.transactions({ limit: opts.limit, type: opts.type, cursor });
      const txs = Array.isArray(page.transactions) ? page.transactions : [];
      for (const t of txs) yield t;
      const next = page.nextCursor;
      if (txs.length === 0 || typeof next !== "string" || !CURSOR_RE.test(next) || next === cursor) return;
      cursor = next;
    }
  }

  /**
   * POST /v1/credits/convert — move available credit (whole cents) into the requester wallet.
   * 10,000 <= amountMusd <= 10,000,000,000. Pass the same idempotencyKey to retry safely.
   */
  async convert(amountMusd: MusdInput, opts: { idempotencyKey?: string } = {}): Promise<ConvertResult & { idempotencyKey: string }> {
    const amount = toMusd(amountMusd, MIN_CONVERT_MUSD, MAX_CONVERT_MUSD);
    const key = validateIdempotencyKey(opts.idempotencyKey ?? newIdempotencyKey());
    const r = await this.http.post<ConvertResult>("/v1/credits/convert", { amountMusd: amount }, "agent", { "Idempotency-Key": key });
    return { ...r, idempotencyKey: key };
  }

  /**
   * Withdraw to the payout wallet: POST /v1/credits/withdraw/challenge -> rebuild the message
   * locally (refuse on mismatch) -> signer (the LINKED wallet) signs -> POST /v1/credits/withdraw.
   * amountMusd >= 1,000,000 ($1). Reusing idempotencyKey returns the original payout (duplicate: true).
   */
  async withdraw(opts: { amountMusd: MusdInput; signer: Signer; idempotencyKey?: string }): Promise<WithdrawResult & { idempotencyKey: string }> {
    const signer = assertSigner(opts?.signer);
    const amountMusd = toMusd(opts.amountMusd, MIN_WITHDRAW_MUSD, MAX_WITHDRAW_MUSD);
    const idempotencyKey = validateIdempotencyKey(opts.idempotencyKey ?? newIdempotencyKey());

    const ch = await this.http.post<{ nonce: string; message: string; expiresAt: string; signer: string }>(
      "/v1/credits/withdraw/challenge", { amountMusd, idempotencyKey }, "agent",
    );
    if (typeof ch.nonce !== "string" || !HEX64_RE.test(ch.nonce)) throw new ProtocolError("invalid challenge nonce");
    if (typeof ch.signer !== "string" || ch.signer.toLowerCase() !== signer.address.toLowerCase()) {
      throw new ProtocolError("the account's linked wallet is not the signer's address; refusing to sign");
    }
    const local = buildWithdrawMessage({
      userId: extractUserId(String(ch.message)), wallet: signer.address, amountMusd, idempotencyKey, nonce: ch.nonce,
    });
    assertSameMessage(ch.message, local, "withdrawal");
    const signature = await sign(signer, local);
    const r = await this.http.post<WithdrawResult>("/v1/credits/withdraw", { amountMusd, idempotencyKey, nonce: ch.nonce, signature }, "agent");
    return { ...r, idempotencyKey };
  }
}

/** GET /v1/payouts */
export class PayoutsResource {
  constructor(private http: HttpClient) {}

  /** GET /v1/payouts — pass `cursor` (previous nextCursor) or `offset`. */
  async list(opts: { limit?: number; offset?: number; cursor?: string } = {}): Promise<{ payouts: Payout[]; limit: number; offset: number; nextCursor?: string | null }> {
    if (opts.limit !== undefined) validateIntRange(opts.limit, "limit", 1, 200);
    if (opts.offset !== undefined) validateIntRange(opts.offset, "offset", 0, 1_000_000);
    if (opts.cursor !== undefined) validatePageCursor(opts.cursor);
    return this.http.get(`/v1/payouts${qs({ limit: opts.limit, offset: opts.offset, cursor: opts.cursor })}`, "agent");
  }

  /** Iterate every item (follows nextCursor; falls back to offset on servers without it). */
  async *iterate(opts: { limit?: number } = {}): AsyncGenerator<Payout, void, undefined> {
    const limit = opts.limit ?? 50;
    validateIntRange(limit, "limit", 1, 200);
    let cursor: string | undefined;
    for (let offset = 0, pages = 0; offset <= 1_000_000 && pages < 100_000; pages++) {
      const page = await this.list(cursor !== undefined ? { limit, cursor } : { limit, offset });
      const items = Array.isArray(page.payouts) ? page.payouts : [];
      for (const p of items) yield p;
      if (items.length === 0) return;
      if (typeof page.nextCursor === "string" && page.nextCursor) { cursor = page.nextCursor; continue; }
      if (page.nextCursor === null || items.length < limit) return;
      offset += limit;
    }
  }
}
