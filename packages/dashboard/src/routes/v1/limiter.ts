/**
 * Bounded in-memory sliding-window limiter (size cap + periodic cleanup per
 * .claude/rules/database.md). Keyed by user id or IP.
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
    hit(key: string): boolean {
      const now = Date.now();
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= max) {
        hits.set(key, list);
        return false;
      }
      if (!hits.has(key) && hits.size >= maxKeys) {
        prune(now);
        if (hits.size >= maxKeys) return false; // fail closed under key flood
      }
      list.push(now);
      hits.set(key, list);
      return true;
    },
    reset() { hits.clear(); },
    stop() { clearInterval(timer); },
  };
}
