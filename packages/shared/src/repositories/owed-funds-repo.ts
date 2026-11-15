/**
 * Money received but not credited ("owed funds"): the four ledgers that record
 * it, read for the admin reconciliation view and the ops alert, and resolved by
 * an audited admin action (docs/agent-network/ADMIN_API.md).
 *
 *  - wallet_overflow_credits: refunds/releases above the $10,000 wallet cap
 *  - payer_refunds_owed:      settled-but-unserved payments of non-wallet payers
 *  - mpp_transactions:        status 'refund_due' or excess_musd > 0
 *  - tempo_payments:          'unmatched' (wrong amount/memo) or 'duplicate'
 */
import { query, type DbTxClient } from "../db.js";

export const OWED_SOURCES = ["overflow", "payer_refund", "mpp", "tempo"] as const;
export type OwedSource = (typeof OWED_SOURCES)[number];

/** Allowed resolutions per source. */
export const OWED_RESOLUTIONS: Record<OwedSource, readonly string[]> = {
  overflow: ["credited", "waived"],
  payer_refund: ["paid", "waived"],
  mpp: ["refunded", "waived"],
  tempo: ["refunded", "credited"],
};

export const OPEN_OVERFLOW_SQL = `resolved_at IS NULL`;
export const OPEN_PAYER_SQL = `status = 'owed'`;
export const OPEN_MPP_SQL = `(status = 'refund_due' OR excess_musd > 0) AND owed_resolved_at IS NULL`;
export const OPEN_TEMPO_SQL = `status IN ('unmatched','duplicate')`;

export interface OwedSummary {
  overflow: { open: number; cents: string };
  payerRefund: { open: number; musd: string };
  mpp: { open: number; refundDue: number; excessMusd: string };
  tempo: { open: number; units: string };
  totalOpen: number;
}

export async function summary(): Promise<OwedSummary> {
  const r = await query<{
    ov_n: string; ov_c: string; pr_n: string; pr_m: string; mpp_n: string; mpp_due: string; mpp_x: string; t_n: string; t_u: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM wallet_overflow_credits WHERE ${OPEN_OVERFLOW_SQL})::text AS ov_n,
       (SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_overflow_credits WHERE ${OPEN_OVERFLOW_SQL})::text AS ov_c,
       (SELECT COUNT(*) FROM payer_refunds_owed WHERE ${OPEN_PAYER_SQL})::text AS pr_n,
       (SELECT COALESCE(SUM(amount_musd), 0) FROM payer_refunds_owed WHERE ${OPEN_PAYER_SQL})::text AS pr_m,
       (SELECT COUNT(*) FROM mpp_transactions WHERE ${OPEN_MPP_SQL})::text AS mpp_n,
       (SELECT COUNT(*) FROM mpp_transactions WHERE status = 'refund_due' AND owed_resolved_at IS NULL)::text AS mpp_due,
       (SELECT COALESCE(SUM(excess_musd), 0) FROM mpp_transactions WHERE ${OPEN_MPP_SQL})::text AS mpp_x,
       (SELECT COUNT(*) FROM tempo_payments WHERE ${OPEN_TEMPO_SQL})::text AS t_n,
       (SELECT COALESCE(SUM(amount_units), 0) FROM tempo_payments WHERE ${OPEN_TEMPO_SQL})::text AS t_u`,
  );
  const x = r.rows[0]!;
  const out = {
    overflow: { open: Number(x.ov_n), cents: x.ov_c },
    payerRefund: { open: Number(x.pr_n), musd: x.pr_m },
    mpp: { open: Number(x.mpp_n), refundDue: Number(x.mpp_due), excessMusd: x.mpp_x },
    tempo: { open: Number(x.t_n), units: x.t_u },
  };
  return { ...out, totalOpen: out.overflow.open + out.payerRefund.open + out.mpp.open + out.tempo.open };
}

export interface OwedRow { source: OwedSource; id: string; createdAt: Date; detail: Record<string, unknown> }

/** Open rows of one source, oldest first. */
export async function listOpen(source: OwedSource, limit = 100): Promise<OwedRow[]> {
  const lim = Math.min(Math.max(Math.trunc(limit) || 100, 1), 500);
  switch (source) {
    case "overflow": {
      const r = await query<{ id: string; user_id: string | null; team_id: string | null; amount_cents: number; reason: string; created_at: Date }>(
        `SELECT id::text AS id, user_id, team_id, amount_cents, reason, created_at FROM wallet_overflow_credits
         WHERE ${OPEN_OVERFLOW_SQL} ORDER BY created_at LIMIT $1`, [lim]);
      return r.rows.map((x) => ({ source, id: x.id, createdAt: x.created_at, detail: { userId: x.user_id, teamId: x.team_id, amountCents: x.amount_cents, reason: x.reason } }));
    }
    case "payer_refund": {
      const r = await query<{ id: string; payer_address: string; rail: string; amount_musd: string; reason: string; created_at: Date }>(
        `SELECT id::text AS id, payer_address, rail, amount_musd::text AS amount_musd, reason, created_at FROM payer_refunds_owed
         WHERE ${OPEN_PAYER_SQL} ORDER BY created_at LIMIT $1`, [lim]);
      return r.rows.map((x) => ({ source, id: x.id, createdAt: x.created_at, detail: { payer: x.payer_address, rail: x.rail, amountMusd: x.amount_musd, reason: x.reason } }));
    }
    case "mpp": {
      const r = await query<{ id: string; user_id: string | null; status: string; amount_musd: string; excess_musd: string; created_at: Date }>(
        `SELECT id::text AS id, user_id, status, amount_musd::text AS amount_musd, excess_musd::text AS excess_musd, created_at FROM mpp_transactions
         WHERE ${OPEN_MPP_SQL} ORDER BY created_at LIMIT $1`, [lim]);
      return r.rows.map((x) => ({ source, id: x.id, createdAt: x.created_at, detail: { userId: x.user_id, status: x.status, amountMusd: x.amount_musd, excessMusd: x.excess_musd } }));
    }
    case "tempo": {
      const r = await query<{ id: string; tx_hash: string; charge_id: string; from_address: string | null; amount_units: string; status: string; note: string | null; created_at: Date }>(
        `SELECT id::text AS id, tx_hash, charge_id, from_address, amount_units::text AS amount_units, status, note, created_at FROM tempo_payments
         WHERE ${OPEN_TEMPO_SQL} ORDER BY created_at LIMIT $1`, [lim]);
      return r.rows.map((x) => ({ source, id: x.id, createdAt: x.created_at, detail: { txHash: x.tx_hash, chargeId: x.charge_id, from: x.from_address, amountUnits: x.amount_units, status: x.status, note: x.note } }));
    }
  }
}

/**
 * Mark one open row resolved (the money was paid back, credited by hand or
 * waived). Returns false when the row is not open (already resolved / unknown).
 */
export async function resolveTx(c: Pick<DbTxClient, "query">, source: OwedSource, id: string, resolution: string): Promise<boolean> {
  if (!OWED_RESOLUTIONS[source]?.includes(resolution)) throw new Error("Invalid resolution");
  let r;
  switch (source) {
    case "overflow":
      r = await c.query(`UPDATE wallet_overflow_credits SET resolved_at = now() WHERE id = $1::bigint AND ${OPEN_OVERFLOW_SQL} RETURNING id`, [id]);
      break;
    case "payer_refund":
      r = await c.query(`UPDATE payer_refunds_owed SET status = $2, resolved_at = now() WHERE id = $1::bigint AND ${OPEN_PAYER_SQL} RETURNING id`, [id, resolution]);
      break;
    case "mpp":
      r = await c.query(
        `UPDATE mpp_transactions SET owed_resolved_at = now(),
                status = CASE WHEN status = 'refund_due' AND $2 = 'refunded' THEN 'refunded' ELSE status END
         WHERE id = $1::uuid AND ${OPEN_MPP_SQL} RETURNING id`, [id, resolution]);
      break;
    case "tempo":
      r = await c.query(`UPDATE tempo_payments SET status = $2 WHERE id = $1::bigint AND ${OPEN_TEMPO_SQL} RETURNING id`, [id, resolution]);
      break;
  }
  return (r?.rows?.length ?? 0) > 0;
}
