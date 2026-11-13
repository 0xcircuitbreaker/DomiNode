import { ipRateKey } from "../../helpers/ip-key.js";

/**
 * Bounded in-memory sliding-window limiter (size cap + periodic cleanup per
 * .claude/rules/database.md). Keyed by user id or IP; IPv6 keys are reduced
 * to their /64 (ipRateKey) so one host cannot rotate addresses for budget.
 * When the key map is full the oldest key is evicted: failing closed would
 * let one flood deny every new client.
 */
export interface KeyedLimiter {
  /** Returns true if allowed (and records the hit). */
  hit(key: string): boolean;
  reset(): void;
  stop(): void;
}

export function createKeyedLimiter(max: number, windowMs: number, maxKeys = 50_000): KeyedLimiter {
  const hits = new Map<string, number[]>();
  const prune = (now: number) => {
    for (const [k, v] of hits) {
      const kept = v.filter((t) => now - t < windowMs);
      if (kept.length === 0) hits.delete(k);
      else hits.set(k, kept);
    }
  };
  const timer = setInterval(() => prune(Date.now()), Math.max(windowMs, 60_000));
  timer.unref?.();
  return {
    hit(rawKey: string): boolean {
      const key = ipRateKey(rawKey);
      const now = Date.now();
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      if (!hits.has(key) && hits.size >= maxKeys) {
        prune(now);
        while (hits.size >= maxKeys) {
          const oldest = hits.keys().next().value;
          if (oldest === undefined) break;
          hits.delete(oldest);
        }
      }
      list.push(now);
      hits.set(key, list);
      return true;
    },
    reset() { hits.clear(); },
    stop() { clearInterval(timer); },
  };
}
