import { query } from "../db.js";

/**
 * Contribution requirement (policy.requireContribution, ECONOMICS.md).
 * A principal "contributes" when it owns an active node that carried matured,
 * undisputed, paid traffic from another principal within the window, or when an
 * admin put it on contribution_allowlist.
 */
export async function hasContribution(userId: string, windowDays: number): Promise<boolean> {
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 365) throw new Error("windowDays out of range");
  const r = await query<{ ok: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM contribution_allowlist WHERE user_id = $1)
       OR EXISTS (
         SELECT 1 FROM nodes n
         WHERE n.owner_user_id = $1 AND n.status = 'active'
           AND EXISTS (
             SELECT 1 FROM relay_charges rc
             WHERE rc.node_id = n.id AND rc.matured AND NOT rc.disputed AND rc.node_musd > 0
               AND rc.requester_user_id IS DISTINCT FROM $1
               AND rc.created_at > now() - make_interval(days => $2)))
     ) AS ok`,
    [userId, windowDays],
  );
  return r.rows[0]?.ok === true;
}
