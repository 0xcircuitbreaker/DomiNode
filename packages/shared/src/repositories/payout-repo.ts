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
    // Lock order: account before payout_wallets (same as requestWithdraw / sanctions block).
    await lockAccountTx(client, userId);
    const live = await client.query<PwRow>(
      `SELECT ${PW_COLS} FROM payout_wallets WHERE user_id = $1 AND status IN ('pending','active') FOR UPDATE`, [userId],
    );
    const cur = live.rows[0];
    if (!cur) throw new Error("No payout wallet registered");
    if (cur.status === "pending") throw new Error("A payout wallet change is already cooling down");
    if (cur.address === addr) throw new Error("New address equals current address");
    await client.query(`UPDATE payout_wallets SET status = 'superseded' WHERE id = $1`, [cur.id]);
    // Unsent payouts to the superseded wallet would never go out: reverse them
    // (re-credit available) in this transaction so the owner can withdraw again.
    await reverseUnsentPayoutsTx(client, userId, cur.id, "payout wallet changed");
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

export type PayoutStatus = "pending" | "held_tax" | "held_frozen" | "submitted" | "confirmed" | "failed" | "reversed";

type TxClient = Parameters<typeof lockAccountTx>[0];

/**
 * Reverse every unsent (pending/held_tax/held_frozen) payout bound to a wallet
 * and re-credit available. Caller holds the account lock in the same tx.
 */
export async function reverseUnsentPayoutsTx(
  client: TxClient, userId: string, payoutWalletId: string, reason: string,
): Promise<{ count: number; musd: bigint }> {
  const r = await client.query<{ id: string; amount_musd: string }>(
    `UPDATE node_payouts SET status = 'reversed', failure_reason = $3, updated_at = now()
     WHERE user_id = $1 AND payout_wallet_id = $2 AND status IN ('pending','held_tax','held_frozen') AND tx_hash IS NULL
     RETURNING id, amount_musd`,
    [userId, payoutWalletId, reason.slice(0, 200)],
  );
  let total = 0n;
  for (const row of r.rows) {
    total += BigInt(row.amount_musd);
    await client.query(
      `INSERT INTO node_credit_transactions (user_id, type, amount_musd, external_ref)
       VALUES ($1, 'withdraw_reversal', $2, $3)`,
      [userId, row.amount_musd, row.id],
    );
  }
  if (total > 0n) {
    await client.query(
      `UPDATE node_credit_accounts SET available_musd = available_musd + $2, updated_at = now() WHERE user_id = $1`,
      [userId, total.toString()],
    );
  }
  return { count: r.rows.length, musd: total };
}

/**
 * Freeze a node credit account and hold its unsent payouts (pending →
 * held_frozen) in the caller's transaction. Takes the account lock first.
 */
export async function freezeAccountTx(client: TxClient, userId: string): Promise<number> {
  await lockAccountTx(client, userId);
  await client.query(`UPDATE node_credit_accounts SET frozen = true, updated_at = now() WHERE user_id = $1`, [userId]);
  const r = await client.query<{ id: string }>(
    `UPDATE node_payouts SET status = 'held_frozen', updated_at = now()
     WHERE user_id = $1 AND status = 'pending' AND tx_hash IS NULL
     RETURNING id`,
    [userId],
  );
  return r.rows.length;
}

export type UnfreezeMode = "release" | "reverse";

/**
 * Unfreeze a node credit account in the caller's transaction (admin action).
 * Locks the account row FOR UPDATE, clears `frozen`, then either releases its
 * held_frozen payouts back to pending ("release") or reverses them and
 * re-credits available ("reverse"). Returns null when no account exists.
 */
export async function unfreezeAccountTx(
  client: TxClient, userId: string, mode: UnfreezeMode,
): Promise<{ wasFrozen: boolean; payouts: number; musd: bigint } | null> {
  const a = await client.query<{ frozen: boolean }>(
    `SELECT frozen FROM node_credit_accounts WHERE user_id = $1 FOR UPDATE`, [userId],
  );
  if (!a.rows[0]) return null;
  await client.query(`UPDATE node_credit_accounts SET frozen = false, updated_at = now() WHERE user_id = $1`, [userId]);
  if (mode === "release") {
    const r = await client.query<{ id: string; amount_musd: string }>(
      `UPDATE node_payouts SET status = 'pending', updated_at = now()
       WHERE user_id = $1 AND status = 'held_frozen' AND tx_hash IS NULL
       RETURNING id, amount_musd`,
      [userId],
    );
    const musd = r.rows.reduce((t, x) => t + BigInt(x.amount_musd), 0n);
    return { wasFrozen: a.rows[0].frozen, payouts: r.rows.length, musd };
  }
  const r = await client.query<{ id: string; amount_musd: string }>(
    `UPDATE node_payouts SET status = 'reversed', failure_reason = 'admin unfreeze: reversed', updated_at = now()
     WHERE user_id = $1 AND status = 'held_frozen' AND tx_hash IS NULL
     RETURNING id, amount_musd`,
    [userId],
  );
  let total = 0n;
  for (const row of r.rows) {
    total += BigInt(row.amount_musd);
    await client.query(
      `INSERT INTO node_credit_transactions (user_id, type, amount_musd, external_ref)
       VALUES ($1, 'withdraw_reversal', $2, $3)`,
      [userId, row.amount_musd, row.id],
    );
  }
  if (total > 0n) {
    await client.query(
      `UPDATE node_credit_accounts SET available_musd = available_musd + $2, updated_at = now() WHERE user_id = $1`,
      [userId, total.toString()],
    );
  }
  return { wasFrozen: a.rows[0].frozen, payouts: r.rows.length, musd: total };
}

/** Freeze an account (admin/compliance) and hold its pending payouts. */
export async function freezeNodeCreditAccount(userId: string): Promise<{ heldPayouts: number }> {
  return withTx(async (client) => ({ heldPayouts: await freezeAccountTx(client, userId) }));
}
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
           WHERE user_id = $1 AND status IN ('pending','held_tax','held_frozen','submitted')
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
    if (p.status !== "pending" && p.status !== "held_tax" && p.status !== "held_frozen" && p.status !== "failed") {
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

// ─── Payout job support (commit 22b) ─────────────────────────────────

export const PAYOUT_JOB_LIMIT = 1000;
const lim1000 = (n: number) => (Number.isInteger(n) && n > 0 && n <= PAYOUT_JOB_LIMIT ? n : PAYOUT_JOB_LIMIT);

/** Accounts eligible for the daily auto push: available ≥ $1, not frozen, active (non-blocked) wallet. */
export async function listAutoPayoutCandidates(limit = PAYOUT_JOB_LIMIT): Promise<{ userId: string; availableMusd: bigint }[]> {
  const r = await query<{ user_id: string; available_musd: string }>(
    `SELECT a.user_id, a.available_musd FROM node_credit_accounts a
     JOIN payout_wallets w ON w.user_id = a.user_id AND w.status IN ('pending','active') AND w.active_from <= now()
     WHERE NOT a.frozen AND a.available_musd >= $1
     ORDER BY a.user_id LIMIT $2`,
    [MIN_WITHDRAW_MUSD.toString(), lim1000(limit)],
  );
  return r.rows.map((x) => ({ userId: x.user_id, availableMusd: BigInt(x.available_musd) }));
}

export interface DuePayout {
  id: string;
  userId: string;
  payoutWalletId: string;
  address: string;
  chain: PayoutChain;
  amountMusd: bigint;
}

/** Pending payouts whose wallet is active (blocked/superseded wallets are left for an admin). */
export async function listDuePayouts(limit = PAYOUT_JOB_LIMIT): Promise<DuePayout[]> {
  const r = await query<{ id: string; user_id: string; payout_wallet_id: string; address: string; chain: PayoutChain; amount_musd: string }>(
    `SELECT p.id, p.user_id, p.payout_wallet_id, w.address, w.chain, p.amount_musd
     FROM node_payouts p JOIN payout_wallets w ON w.id = p.payout_wallet_id
     JOIN node_credit_accounts a ON a.user_id = p.user_id
     WHERE p.status = 'pending' AND p.user_id IS NOT NULL AND w.status = 'active' AND NOT a.frozen
     ORDER BY p.created_at LIMIT $1`,
    [lim1000(limit)],
  );
  return r.rows.map((x) => ({
    id: x.id, userId: x.user_id, payoutWalletId: x.payout_wallet_id, address: x.address, chain: x.chain, amountMusd: BigInt(x.amount_musd),
  }));
}

/**
 * Claim a pending payout for sending (pending → submitted, compare-and-set).
 * Returns false if another worker/run already claimed it, or the owner's
 * credit account is frozen (FOR SHARE serializes with freezeAccountTx): the
 * send is skipped, so one payout id is broadcast at most once.
 */
export async function claimPayoutForSend(payoutId: string): Promise<boolean> {
  const r = await query(
    `UPDATE node_payouts p SET status = 'submitted', updated_at = now()
     WHERE p.id = $1 AND p.status = 'pending' AND p.tx_hash IS NULL
       AND EXISTS (SELECT 1 FROM node_credit_accounts a WHERE a.user_id = p.user_id AND NOT a.frozen FOR SHARE)`,
    [payoutId],
  );
  return (r.rowCount ?? 0) === 1;
}

/** Record the broadcast tx hash on a claimed payout (only once). */
export async function recordPayoutTx(payoutId: string, txHash: string): Promise<boolean> {
  const hash = typeof txHash === "string" ? txHash.toLowerCase() : "";
  if (!TX_HASH_RE.test(hash)) throw new Error("Invalid tx hash");
  const r = await query(
    `UPDATE node_payouts SET tx_hash = $2, updated_at = now()
     WHERE id = $1 AND status = 'submitted' AND tx_hash IS NULL`,
    [payoutId, hash],
  );
  return (r.rowCount ?? 0) === 1;
}

/**
 * Return a claimed payout to 'pending' when the sender proved nothing was
 * broadcast (no tx hash recorded). Ambiguous failures must NOT use this.
 */
export async function releaseUnbroadcastPayout(payoutId: string): Promise<boolean> {
  const r = await query(
    `UPDATE node_payouts SET status = 'pending', updated_at = now()
     WHERE id = $1 AND status = 'submitted' AND tx_hash IS NULL`,
    [payoutId],
  );
  return (r.rowCount ?? 0) === 1;
}

/** SDN hit: block the payout wallet and freeze the owner's credit account (admin case). */
export async function blockWalletForSanctions(payoutWalletId: string, userId: string): Promise<void> {
  await withTx(async (client) => {
    await freezeAccountTx(client, userId); // locks the account first, holds pending payouts
    await client.query(`UPDATE payout_wallets SET status = 'blocked' WHERE id = $1 AND user_id = $2`, [payoutWalletId, userId]);
  });
}

/** Submitted payouts with a broadcast tx awaiting a final receipt (reconciled each run). */
export async function listSubmittedPayouts(limit = PAYOUT_JOB_LIMIT): Promise<{ id: string; txHash: string }[]> {
  const r = await query<{ id: string; tx_hash: string }>(
    `SELECT id, tx_hash FROM node_payouts WHERE status = 'submitted' AND tx_hash IS NOT NULL
     ORDER BY updated_at LIMIT $1`,
    [lim1000(limit)],
  );
  return r.rows.map((x) => ({ id: x.id, txHash: x.tx_hash }));
}
