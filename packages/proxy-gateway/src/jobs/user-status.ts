/**
 * Requester status sweep (per instance). Admin suspend and account deletion
 * also POST /internal/terminate-sessions to a gateway, but that call cannot
 * reach a gateway on another host (split self-host) or every instance of a
 * multi-gateway deployment. The DB is the shared signal: every interval this
 * job looks up the users with live sessions on this instance and terminates
 * the sessions of any user that is no longer 'active' (suspended, deleted or
 * anonymised), so a revoked requester loses open tunnels within one interval.
 */
import { Job, type JobLogger } from "./runner.js";

export interface UserStatusDeps {
  /** User ids with a live session on this instance (duplicates allowed). */
  liveUserIds: () => string[];
  /** Map of userId -> DB status for the given ids (missing ids = deleted). */
  fetchStatuses: (ids: string[]) => Promise<Map<string, string>>;
  terminate: (userId: string) => Promise<number>;
}

export const USER_STATUS_BATCH = 1000;

export async function runOnce(d: UserStatusDeps): Promise<{ checked: number; users: number; sessions: number }> {
  const ids = [...new Set(d.liveUserIds())];
  let users = 0;
  let sessions = 0;
  for (let i = 0; i < ids.length; i += USER_STATUS_BATCH) {
    const batch = ids.slice(i, i + USER_STATUS_BATCH);
    const st = await d.fetchStatuses(batch);
    for (const id of batch) {
      if (st.get(id) === "active") continue;
      users++;
      sessions += await d.terminate(id);
    }
  }
  return { checked: ids.length, users, sessions };
}

export function start(o: { deps: UserStatusDeps; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "user-status-sweep", intervalMs: o.intervalMs ?? 30_000, lockKey: null, logger: o.logger,
    run: () => runOnce(o.deps), initialDelayMs: 30_000,
  });
  job.start();
  return job;
}
