import { EXIT_CLASSES } from "@dominusnode/shared";
/**
 * Unmet demand (LAUNCH_PLAN §11 gap 9): when node selection finds no eligible
 * node, count (UTC hour, requested country, requested class). Nothing else is
 * kept: no requester id, no host, no client IP. Counts live in a size-capped
 * map and are flushed to unmet_demand_hourly by a per-instance job.
 */

const MAX_KEYS = 10_000;
const counts = new Map<string, number>();
const HOUR_MS = 3_600_000;

const CLASSES: ReadonlySet<string> = new Set(EXIT_CLASSES);

export function recordUnmetDemand(country: string | undefined, ipClass: string | undefined, now = Date.now()): void {
  const c = country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : "";
  const k = ipClass && CLASSES.has(ipClass) ? ipClass : "";
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const key = `${hour}|${c}|${k}`;
  const cur = counts.get(key);
  if (cur === undefined && counts.size >= MAX_KEYS) return; // bounded: drop new keys until the next flush
  counts.set(key, Math.min((cur ?? 0) + 1, 2_000_000_000));
}

export interface UnmetRow { hour: Date; country: string; ipClass: string; requests: number }

/** Take and clear the pending counts. */
export function drainUnmetDemand(): UnmetRow[] {
  const out: UnmetRow[] = [];
  for (const [key, n] of counts) {
    const [h, country, ipClass] = key.split("|");
    out.push({ hour: new Date(Number(h)), country, ipClass, requests: n });
  }
  counts.clear();
  return out;
}

/** Put rows back after a failed flush (bounded by the same cap). */
export function restoreUnmetDemand(rows: UnmetRow[]): void {
  for (const r of rows) {
    const key = `${r.hour.getTime()}|${r.country}|${r.ipClass}`;
    const cur = counts.get(key);
    if (cur === undefined && counts.size >= MAX_KEYS) continue;
    counts.set(key, Math.min((cur ?? 0) + r.requests, 2_000_000_000));
  }
}

export function pendingUnmetKeys(): number {
  return counts.size;
}
