/**
 * kill_switches + node_drains (ADMIN_API.md §17). Reads only; admin writes
 * run inside the dashboard's audited admin transaction.
 */
import { query } from "../db.js";
import { isKillSwitchKey, KillSwitchCache, configureKillSwitches, killSwitchEnvMs, type KillSwitchKey, type KillSwitchState } from "../kill-switches.js";

/** Snapshot for KillSwitchCache. Throws on DB error (the cache fails closed). */
export async function loadState(): Promise<KillSwitchState> {
  const [sw, dr] = await Promise.all([
    query<{ key: string }>("SELECT key FROM kill_switches WHERE engaged = true"),
    query<{ node_id: string }>("SELECT node_id FROM node_drains LIMIT 100000"),
  ]);
  const engaged = new Set<KillSwitchKey>();
  for (const r of sw.rows) if (isKillSwitchKey(r.key)) engaged.add(r.key);
  return { engaged, drainedNodeIds: new Set(dr.rows.map((r) => r.node_id)) };
}

/**
 * Build, start and install the process-wide cache (gateway and API main.ts).
 * Throws on an invalid KILL_SWITCH_* env var. A failed first load leaves the
 * service failing closed until a later poll succeeds.
 */
export async function startProcessCache(
  env: NodeJS.ProcessEnv,
  logger: { warn: (msg: string, meta?: Record<string, unknown>) => void },
): Promise<KillSwitchCache> {
  const cache = new KillSwitchCache({
    load: loadState,
    pollMs: killSwitchEnvMs(env, "KILL_SWITCH_POLL_MS"),
    maxStaleMs: killSwitchEnvMs(env, "KILL_SWITCH_MAX_STALE_MS"),
    onError: (err) => logger.warn("kill switch reload failed (failing closed once stale)", { error: err instanceof Error ? err.message.slice(0, 120) : "unknown" }),
  });
  await cache.start();
  configureKillSwitches(cache);
  return cache;
}
