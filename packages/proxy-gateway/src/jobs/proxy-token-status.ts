/**
 * Proxy token sweep (per instance). DELETE /v1/proxy-tokens/:id also POSTs
 * /internal/terminate-token-sessions to a gateway, but that call cannot reach
 * a gateway on another host or every instance of a multi-gateway deployment.
 * Every interval this job looks up the dn_proxy_ tokens with an open session
 * on this instance and ends the sessions of any token that is revoked,
 * expired or deleted, so a revoked token loses open tunnels within one interval.
 */
import { Job, type JobLogger } from "./runner.js";

export interface ProxyTokenStatusDeps {
  /** Token ids with an open session on this instance. */
  liveTokenIds: () => string[];
  /** Of the given ids, those that no longer authorize traffic. */
  findEnded: (ids: string[]) => Promise<string[]>;
  terminate: (tokenId: string) => Promise<number>;
  /** Drop the gateway's cached lookups of an ended token. */
  forget?: (tokenId: string) => void;
}

export const PROXY_TOKEN_STATUS_BATCH = 1000;

export async function runOnce(d: ProxyTokenStatusDeps): Promise<{ checked: number; tokens: number; sessions: number }> {
  const ids = [...new Set(d.liveTokenIds())];
  let tokens = 0;
  let sessions = 0;
  for (let i = 0; i < ids.length; i += PROXY_TOKEN_STATUS_BATCH) {
    const ended = await d.findEnded(ids.slice(i, i + PROXY_TOKEN_STATUS_BATCH));
    for (const id of ended) {
      tokens++;
      d.forget?.(id);
      sessions += await d.terminate(id);
    }
  }
  return { checked: ids.length, tokens, sessions };
}

export function start(o: { deps: ProxyTokenStatusDeps; logger: JobLogger; intervalMs?: number }): Job {
  const job = new Job({
    name: "proxy-token-sweep", intervalMs: o.intervalMs ?? 30_000, lockKey: null, logger: o.logger,
    run: () => runOnce(o.deps), initialDelayMs: 30_000,
  });
  job.start();
  return job;
}
