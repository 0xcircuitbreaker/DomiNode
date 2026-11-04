import { query } from "../db.js";
import { withTx, lockAccountTx } from "./node-credit-repo.js";

/** Payout wallets and node payouts (DESIGN.md §15). Gated by PAYOUTS_ENABLED. */

export const MIN_WITHDRAW_MUSD = 1_000_000n; // $1
const MAX_PAYOUT_MUSD = 100_000_000_000n;
export const PAYOUT_WALLET_COOLDOWN_HOURS = 72;
export const TAX_REQUEST_THRESHOLD_MUSD = 1_500_000_000n; // $1,500
export const TAX_HOLD_THRESHOLD_MUSD = 2_000_000_000n; // $2,000
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

export class PayoutsDisabledError extends Error {
  constructor() {
    super("Payouts are disabled");
    this.name = "PayoutsDisabledError";
  }
}

/** Default false; only the literal "true" enables payouts. */
export function payoutsEnabled(): boolean {
  return process.env["PAYOUTS_ENABLED"] === "true";
}

export type PayoutChain = "base" | "base-sepolia";

export interface PayoutWallet {
  id: string;
  userId: string;
  address: string;
  chain: PayoutChain;
  status: "pending" | "active" | "superseded" | "blocked";
  activeFrom: Date;
}

const PW_COLS = "id, user_id, address, chain, status, active_from";
interface PwRow { id: string; user_id: string; address: string; chain: PayoutChain; status: PayoutWallet["status"]; active_from: Date }
const mapPw = (r: PwRow): PayoutWallet => ({ id: r.id, userId: r.user_id, address: r.address, chain: r.chain, status: r.status, activeFrom: r.active_from });

function normAddress(a: string): string {
  const v = typeof a === "string" ? a.toLowerCase() : "";
  if (!ADDRESS_RE.test(v)) throw new Error("Invalid payout address");
  return v;
}

/**
 * Register the first payout wallet. The caller must have OFAC-screened the
 * address (ofacCleared) and verified the wallet signature.
 */
export async function registerPayoutWallet(
  userId: string, address: string, opts: { ofacCleared: boolean; chain?: PayoutChain },
): Promise<PayoutWallet> {
  const addr = normAddress(address);
  if (!opts.ofacCleared) throw new Error("Payout address failed sanctions screening");
  return withTx(async (client) => {
    const u = await client.query(`SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId]);
    if (u.rows.length === 0) throw new Error("User not found");
    const live = await client.query(
      `SELECT id FROM payout_wallets WHERE user_id = $1 AND status IN ('pending','active') FOR UPDATE`, [userId],
    );
    if (live.rows.length > 0) throw new Error("Payout wallet already registered; use change");
    const r = await client.query<PwRow>(
      `INSERT INTO payout_wallets (user_id, address, chain, status, ofac_checked_at, active_from)
       VALUES ($1, $2, $3, 'active', now(), now())
       RETURNING ${PW_COLS}`,
      [userId, addr, opts.chain ?? "base"],
    );
    return mapPw(r.rows[0]);
  });
}

/**
 * Change payout wallet. Caller verified `changeSig` was signed by the OLD
 * wallet. The new wallet is 'pending' for 72h; the old one is superseded,
 * so no payout can go out during the cooldown.
 */
export async function changePayoutWallet(
  userId: string, newAddress: string, changeSig: string, opts: { ofacCleared: boolean; chain?: PayoutChain },
): Promise<PayoutWallet> {
  const addr = normAddress(newAddress);
  if (!opts.ofacCleared) throw new Error("Payout address failed sanctions screening");
  if (typeof changeSig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(changeSig)) throw new Error("Invalid change signature");
  return withTx(async (client) => {
    const u = await client.query(`SELECT id FROM users WHERE id = $1 AND status = 'active' FOR UPDATE`, [userId]);
    if (u.rows.length === 0) throw new Error("User not found");
    const live = await client.query<PwRow>(
      `SELECT ${PW_COLS} FROM payout_wallets WHERE user_id = $1 AND status IN ('pending','active') FOR UPDATE`, [userId],
    );
    const cur = live.rows[0];
    if (!cur) throw new Error("No payout wallet registered");
    if (cur.status === "pending") throw new Error("A payout wallet change is already cooling down");
    if (cur.address === addr) throw new Error("New address equals current address");
    await client.query(`UPDATE payout_wallets SET status = 'superseded' WHERE id = $1`, [cur.id]);
    const r = await client.query<PwRow>(
      `INSERT INTO payout_wallets (user_id, address, chain, status, ofac_checked_at, change_sig, active_from)
       VALUES ($1, $2, $3, 'pending', now(), $4, now() + make_interval(hours => $5))
       RETURNING ${PW_COLS}`,
      [userId, addr, opts.chain ?? cur.chain, changeSig.toLowerCase(), PAYOUT_WALLET_COOLDOWN_HOURS],
    );
    return mapPw(r.rows[0]);
  });
}

export async function getLivePayoutWallet(userId: string): Promise<PayoutWallet | null> {
  const r = await query<PwRow>(
    `SELECT ${PW_COLS} FROM payout_wallets WHERE user_id = $1 AND status IN ('pending','active')`, [userId],
  );
  return r.rows[0] ? mapPw(r.rows[0]) : null;
}

export type PayoutStatus = "pending" | "held_tax" | "submitted" | "confirmed" | "failed" | "reversed";
export interface NodePayout {
  id: string;
  userId: string | null;
  payoutWalletId: string | null;
  idempotencyKey: string;
  amountMusd: bigint;
  trigger: "auto" | "on_demand";
  status: PayoutStatus;
  txHash: string | null;
  createdAt: Date;
}
const NP_COLS = "id, user_id, payout_wallet_id, idempotency_key, amount_musd, trigger, status, tx_hash, created_at";
interface NpRow {
  id: string; user_id: string | null; payout_wallet_id: string | null; idempotency_key: string; amount_musd: string;
  trigger: "auto" | "on_demand"; status: PayoutStatus; tx_hash: string | null; created_at: Date;
}
const mapNp = (r: NpRow): NodePayout => ({
  id: r.id, userId: r.user_id, payoutWalletId: r.payout_wallet_id, idempotencyKey: r.idempotency_key,
  amountMusd: BigInt(r.amount_musd), trigger: r.trigger, status: r.status, txHash: r.tx_hash, createdAt: r.created_at,
});

export interface WithdrawRequest {
  userId: string;
  amountMusd: bigint;
  idempotencyKey: string;
  trigger?: "auto" | "on_demand";
}

/**
 * Debit available credit and queue a payout in one transaction.
 * Idempotent on (user_id, idempotency_key): a repeat returns the original.
 */
export async function requestWithdraw(req: WithdrawRequest): Promise<{ payout: NodePayout; duplicate: boolean }> {
  if (!payoutsEnabled()) throw new PayoutsDisabledError();
  const { userId, amountMusd, idempotencyKey } = req;
  if (typeof amountMusd !== "bigint" || amountMusd < MIN_WITHDRAW_MUSD || amountMusd > MAX_PAYOUT_MUSD) {
    throw new Error("Withdrawal amount must be at least $1");
  }
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey)) {
    throw new Error("Invalid idempotency key");
  }
  return withTx(async (client) => {
    // Lock the account first: serializes all withdraws for this user.
    const acct = await lockAccountTx(client, userId);

    const dup = await client.query<NpRow>(
      `SELECT ${NP_COLS} FROM node_payouts WHERE user_id = $1 AND idempotency_key = $2`, [userId, idempotencyKey],
    );
    if (dup.rows[0]) return { payout: mapNp(dup.rows[0]), duplicate: true };

    if (acct.frozen) throw new Error("Node credit account is frozen");
    if (acct.availableMusd < amountMusd) throw new Error("Insufficient available credit");

    // Activate a matured pending wallet, then require an active one.
    await client.query(
      `UPDATE payout_wallets SET status = 'active' WHERE user_id = $1 AND status = 'pending' AND active_from <= now()`, [userId],
    );
    const pw = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM payout_wallets WHERE user_id = $1 AND status IN ('pending','active') FOR UPDATE`, [userId],
    );
    if (!pw.rows[0]) throw new Error("No payout wallet registered");
    if (pw.rows[0].status !== "active") throw new Error("Payout wallet change is cooling down");

    const lim = await client.query<{ daily_withdraw_limit_musd: string; used_today: string }>(
      `SELECT t.daily_withdraw_limit_musd,
         (SELECT COALESCE(SUM(amount_musd), 0) FROM node_payouts
           WHERE user_id = $1 AND created_at >= date_trunc('day', now())
             AND status NOT IN ('failed','reversed')) AS used_today
       FROM node_tiers t
       WHERE t.id = COALESCE((SELECT node_tier_id FROM users WHERE id = $1),
                             (SELECT id FROM node_tiers ORDER BY rank LIMIT 1))`,
      [userId],
    );
    if (!lim.rows[0]) throw new Error("Tier lookup failed"); // fail closed
    if (BigInt(lim.rows[0].used_today) + amountMusd > BigInt(lim.rows[0].daily_withdraw_limit_musd)) {
      throw new Error("Daily withdrawal limit exceeded");
    }

    // ytd_paid_musd only counts confirmed payouts; add this year's in-flight ones
    // (pending/held_tax/submitted) so splitting a withdrawal cannot dodge the tax hold.
    const tax = await client.query<{ tax_form_status: string; ytd_paid_musd: string; tax_year: number | null; cur_year: number; in_flight_musd: string }>(
      `SELECT tax_form_status, ytd_paid_musd, tax_year, EXTRACT(YEAR FROM now())::int AS cur_year,
         (SELECT COALESCE(SUM(amount_musd), 0) FROM node_payouts
           WHERE user_id = $1 AND status IN ('pending','held_tax','submitted')
             AND created_at >= date_trunc('year', now())) AS in_flight_musd
       FROM node_credit_accounts WHERE user_id = $1`, [userId],
    );
    const t = tax.rows[0];
    const ytd = t && t.tax_year === t.cur_year ? BigInt(t.ytd_paid_musd) : 0n;
    const inFlight = t ? BigInt(t.in_flight_musd ?? "0") : 0n;
    const projected = ytd + inFlight + amountMusd;
    const formReceived = t?.tax_form_status === "received";
    if (!formReceived && projected >= TAX_REQUEST_THRESHOLD_MUSD && t?.tax_form_status === "not_required") {
      await client.query(`UPDATE node_credit_accounts SET tax_form_status = 'requested' WHERE user_id = $1`, [userId]);
    }
    const status: PayoutStatus = !formReceived && projected > TAX_HOLD_THRESHOLD_MUSD ? "held_tax" : "pending";

    await client.query(
      `UPDATE node_credit_accounts SET available_musd = available_musd - $2, updated_at = now() WHERE user_id = $1`,
      [userId, amountMusd.toString()],
    );
    const ins = await client.query<NpRow>(
      `INSERT INTO node_payouts (user_id, payout_wallet_id, idempotency_key, amount_musd, trigger, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${NP_COLS}`,
      [userId, pw.rows[0].id, idempotencyKey, amountMusd.toString(), req.trigger ?? "on_demand", status],
    );
    const payout = mapNp(ins.rows[0]);
    await client.query(
      `INSERT INTO node_credit_transactions (user_id, type, amount_musd, external_ref)
       VALUES ($1, 'withdraw', $2, $3)`,
      [userId, amountMusd.toString(), payout.id],
    );
    return { payout, duplicate: false };
  });
}

/** Mark a payout confirmed on-chain. Idempotent for the same tx hash. */
export async function markPayoutConfirmed(payoutId: string, txHash: string): Promise<NodePayout> {
  const hash = typeof txHash === "string" ? txHash.toLowerCase() : "";
  if (!TX_HASH_RE.test(hash)) throw new Error("Invalid tx hash");
  return withTx(async (client) => {
    const r = await client.query<NpRow>(`SELECT ${NP_COLS} FROM node_payouts WHERE id = $1 FOR UPDATE`, [payoutId]);
    const p = r.rows[0];
    if (!p) throw new Error("Payout not found");
    if (p.status === "confirmed") {
      if (p.tx_hash === hash) return mapNp(p);
      throw new Error("Payout already confirmed with a different tx hash");
    }
    if (p.status !== "pending" && p.status !== "submitted") throw new Error(`Cannot confirm payout in status ${p.status}`);
    const u = await client.query<NpRow>(
      `UPDATE node_payouts SET status = 'confirmed', tx_hash = $2, updated_at = now() WHERE id = $1 RETURNING ${NP_COLS}`,
      [payoutId, hash],
    );
    if (p.user_id) {
      await client.query(
        `UPDATE node_credit_accounts
         SET ytd_paid_musd = CASE WHEN tax_year = EXTRACT(YEAR FROM now())::int THEN ytd_paid_musd ELSE 0 END + $2,
             tax_year = EXTRACT(YEAR FROM now())::int, updated_at = now()
         WHERE user_id = $1`,
        [p.user_id, p.amount_musd],
      );
    }
    return mapNp(u.rows[0]);
  });
}

/**
 * Mark a submitted payout failed, with evidence that its tx was dropped or
 * reverted on-chain. Only a 'failed' payout may then be reversed/re-credited.
 * Idempotent for an already-failed payout.
 */
export async function markPayoutFailed(
  payoutId: string, evidence: { txHash: string; outcome: "dropped" | "reverted"; detail?: string },
): Promise<NodePayout> {
  const hash = typeof evidence?.txHash === "string" ? evidence.txHash.toLowerCase() : "";
  if (!TX_HASH_RE.test(hash)) throw new Error("Invalid tx hash");
  if (evidence.outcome !== "dropped" && evidence.outcome !== "reverted") throw new Error("Invalid failure outcome");
  const detail = typeof evidence.detail === "string" ? evidence.detail.slice(0, 120) : "";
  const reason = `tx ${evidence.outcome}${detail ? `: ${detail}` : ""}`.slice(0, 200);
  return withTx(async (client) => {
    const r = await client.query<NpRow>(`SELECT ${NP_COLS} FROM node_payouts WHERE id = $1 FOR UPDATE`, [payoutId]);
    const p = r.rows[0];
    if (!p) throw new Error("Payout not found");
    if (p.status === "failed") return mapNp(p);
    if (p.status !== "submitted") throw new Error(`Cannot fail payout in status ${p.status}`);
    if (p.tx_hash && p.tx_hash !== hash) throw new Error("Evidence tx hash does not match payout");
    const u = await client.query<NpRow>(
      `UPDATE node_payouts SET status = 'failed', tx_hash = $2, failure_reason = $3, updated_at = now()
       WHERE id = $1 RETURNING ${NP_COLS}`,
      [payoutId, hash, reason],
    );
    return mapNp(u.rows[0]);
  });
}

/**
 * Reverse a payout that never went (or provably failed) on-chain and re-credit
 * available. Allowed only from pending, held_tax or failed; a 'submitted'
 * payout must first go through markPayoutFailed. Idempotent.
 */
export async function markPayoutReversed(payoutId: string, reason: string): Promise<NodePayout> {
  const why = typeof reason === "string" ? reason.slice(0, 200) : "";
  return withTx(async (client) => {
    const r = await client.query<NpRow>(`SELECT ${NP_COLS} FROM node_payouts WHERE id = $1 FOR UPDATE`, [payoutId]);
    const p = r.rows[0];
    if (!p) throw new Error("Payout not found");
    if (p.status === "reversed") return mapNp(p);
    if (p.status === "confirmed") throw new Error("Cannot reverse a confirmed payout");
    if (p.status === "submitted") throw new Error("Cannot reverse a submitted payout without failure evidence (markPayoutFailed)");
    if (p.status !== "pending" && p.status !== "held_tax" && p.status !== "failed") {
      throw new Error(`Cannot reverse payout in status ${p.status}`);
    }
    const u = await client.query<NpRow>(
      `UPDATE node_payouts SET status = 'reversed', failure_reason = $2, updated_at = now() WHERE id = $1 RETURNING ${NP_COLS}`,
      [payoutId, why || null],
    );
    if (p.user_id) {
      await lockAccountTx(client, p.user_id);
      await client.query(
        `UPDATE node_credit_accounts SET available_musd = available_musd + $2, updated_at = now() WHERE user_id = $1`,
        [p.user_id, p.amount_musd],
      );
      await client.query(
        `INSERT INTO node_credit_transactions (user_id, type, amount_musd, external_ref)
         VALUES ($1, 'withdraw_reversal', $2, $3)`,
        [p.user_id, p.amount_musd, p.id],
      );
    }
    return mapNp(u.rows[0]);
  });
}
