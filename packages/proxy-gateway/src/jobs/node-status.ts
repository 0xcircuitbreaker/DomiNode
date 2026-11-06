/**
 * Node status sync (per instance). Admin actions (quarantine/revoke/suspend in
 * /api/admin/network) only change nodes.status in the DB; this job closes the
 * in-memory status of connected nodes to the DB (the selector only routes to
 * 'active') and closes the tunnel of nodes that are revoked, suspended or
 * deleted, within one interval.
 */
import { Job, type JobLogger } from "./runner.js";

export interface NodeStatusDeps {
  /** Ids of nodes with a live tunnel on this instance. */
  liveNodeIds: () => string[];
  /** Map of nodeId → DB status for the given ids (missing ids = deleted). */
  fetchStatuses: (ids: string[]) => Promise<Map<string, string>>;
  /** Update the registry's in-memory status (no-op if unchanged). */
  setStatus: (nodeId: string, status: string) => void;
  close: (nodeId: string, reason: string) => void;
}

const DROP = new Set(["revoked", "suspended"]);

export const NODE_STATUS_BATCH = 1000;

export async function runOnce(d: NodeStatusDeps): Promise<{ checked: number; closed: number; updated: number }> {
  const ids = d.liveNodeIds();
  let closed = 0;
  let updated = 0;
  for (let i = 0; i < ids.length; i += NODE_STATUS_BATCH) {
    const batch = ids.slice(i, i + NODE_STATUS_BATCH);
    const st = await d.fetchStatuses(batch);
    for (const id of batch) {
      const s = st.get(id);
      if (s === undefined || DROP.has(s)) {
        d.close(id, `status: ${s ?? "deleted"}`);
        closed++;
        continue;
      }
      d.setStatus(id, s);
      updated++;
    }
  }
  return { checked: ids.length, closed, updated };
}

export function start(o: { deps: NodeStatusDeps; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "node-status-sync", intervalMs: o.intervalMs ?? 30_000, lockKey: null, logger: o.logger,
    run: () => runOnce(o.deps), initialDelayMs: 30_000,
  });
  job.start();
  return job;
}
