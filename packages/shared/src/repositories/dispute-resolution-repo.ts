import type pg from "pg";
import { lockAccountTx } from "./node-credit-repo.js";
import { recordOverflowCreditTx } from "./wallet-repo.js";

type TxClient = Pick<pg.PoolClient, "query">;
const MAX_BALANCE_CENTS = 1_000_000;

export interface ResplitResult {
  /** False when the node count was not lower (nothing to adjust). */
  adjusted: boolean;
  grossBeforeMusd: bigint;
  grossAfterMusd: bigint;
  /** Node share taken back from the owner's pending credit. */
  nodeClawbackMusd: bigint;
  /** Whole cents refunded to the requester's personal wallet (wallet rail). */
  refundCents: number;
  /** Cents owed but not credited (wallet cap): recorded in wallet_overflow_credits. */
  overflowCents: number;
  /** µUSD the requester overpaid on a rail refunded manually (team/agentic/x402/mpp). */
  unrefundedMusd: bigint;
}

/**
 * A byte dispute resolved in the node's favour (`resolved_node`): re-split the
 * held charge at the node's (lower) byte count, in the admin's transaction.
 * gross, node share, platform share and buyer discount scale by
 * bytes_node / bytes_gateway (floored); the node share difference is clawed
 * back from the owner's pending credit (it is still held: maturity skips
 * disputed charges); the requester gets the gross difference back in whole
 * cents on the personal wallet rail (other rails: recorded for a manual refund). The caller then clears `disputed`.
 */
export async function resplitAtNodeBytesTx(c: TxClient, chargeId: string, adminUserId: string): Promise<ResplitResult> {
  const r = await c.query<{
    gross: string; node: string; discount: string; list: string | null; bg: string; bn: string | null;
    rail: string; requester: string | null; owner: string | null;
  }>(
    `SELECT rc.gross_musd::text AS gross, rc.node_musd::text AS node, rc.discount_musd::text AS discount,
            rc.list_gross_musd::text AS list, rc.bytes_gateway::text AS bg, rc.bytes_node::text AS bn,
            rc.payment_rail AS rail, rc.requester_user_id AS requester, rc.node_owner_user_id AS owner
     FROM relay_charges rc WHERE rc.id = $1 FOR UPDATE`,
    [chargeId],
  );
  const x = r.rows[0];
  if (!x) throw new Error("Relay charge not found");
  const gross = BigInt(x.gross);
  const none: ResplitResult = { adjusted: false, grossBeforeMusd: gross, grossAfterMusd: gross, nodeClawbackMusd: 0n, refundCents: 0, overflowCents: 0, unrefundedMusd: 0n };
  const bg = BigInt(x.bg);
  if (x.bn === null || bg === 0n || BigInt(x.bn) >= bg) return none;
  const bn = BigInt(x.bn);
  const node = BigInt(x.node);
  const newGross = (gross * bn) / bg;
  const newNode = (node * bn) / bg;
  const newDiscount = (BigInt(x.discount) * bn) / bg;
  await c.query(
    `UPDATE relay_charges SET gross_musd = $2, node_musd = $3, platform_musd = $4, discount_musd = $5,
       list_gross_musd = CASE WHEN list_gross_musd IS NULL THEN NULL ELSE $6::bigint END WHERE id = $1`,
    [chargeId, newGross.toString(), newNode.toString(), (newGross - newNode).toString(), newDiscount.toString(), (newGross + newDiscount).toString()],
  );

  let clawed = 0n;
  const nodeDelta = node - newNode;
  if (nodeDelta > 0n && x.owner) {
    const acct = await lockAccountTx(c, x.owner);
    clawed = nodeDelta < acct.pendingMusd ? nodeDelta : acct.pendingMusd;
    if (clawed > 0n) {
      await c.query(`UPDATE node_credit_accounts SET pending_musd = pending_musd - $2, updated_at = now() WHERE user_id = $1`,
        [x.owner, clawed.toString()]);
      await c.query(
        `INSERT INTO node_credit_transactions (user_id, type, amount_musd, relay_charge_id, external_ref, created_by)
         VALUES ($1, 'clawback', $2, $3, 'dispute:resolved_node', $4)`,
        [x.owner, clawed.toString(), chargeId, adminUserId]);
    }
  }

  const grossDelta = gross - newGross;
  const cents = Number(grossDelta / 10_000n);
  let refundCents = 0;
  let overflowCents = 0;
  let unrefunded = 0n;
  if (cents > 0 && x.rail === "wallet" && x.requester) {
    const w = await c.query<{ id: string; balance_cents: number }>(
      `SELECT id, balance_cents FROM wallets WHERE user_id = $1 FOR UPDATE`, [x.requester]);
    const wal = w.rows[0];
    if (wal) {
      refundCents = Math.min(cents, Math.max(0, MAX_BALANCE_CENTS - wal.balance_cents));
      overflowCents = cents - refundCents;
      if (refundCents > 0) {
        await c.query(`UPDATE wallets SET balance_cents = balance_cents + $2 WHERE id = $1`, [wal.id, refundCents]);
        await c.query(
          `INSERT INTO wallet_transactions (wallet_id, type, amount_cents, description) VALUES ($1, 'refund', $2, $3)`,
          [wal.id, refundCents, `Byte dispute refund (charge ${chargeId.slice(0, 8)})`]);
      }
      if (overflowCents > 0) await recordOverflowCreditTx(c, { userId: x.requester, teamId: null, cents: overflowCents, reason: `dispute refund over cap (charge ${chargeId.slice(0, 8)})` });
    } else {
      unrefunded = grossDelta;
    }
  } else {
    // team/agentic/x402/mpp: no personal wallet movement here; the audit row
    // carries the amount for a manual refund.
    unrefunded = grossDelta;
  }
  return { adjusted: true, grossBeforeMusd: gross, grossAfterMusd: newGross, nodeClawbackMusd: clawed, refundCents, overflowCents, unrefundedMusd: unrefunded };
}
