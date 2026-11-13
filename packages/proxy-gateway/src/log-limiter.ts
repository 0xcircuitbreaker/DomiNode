/**
 * At most one log line per key per interval, with a bounded key map so a
 * flood of distinct keys cannot grow memory (oldest keys are evicted).
 */
export class PerKeyLogLimiter {
  private readonly last = new Map<string, number>();
  constructor(private readonly intervalMs: number, private readonly maxKeys: number) {}

  allow(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.intervalMs) return false;
    this.last.delete(key);
    if (this.last.size >= this.maxKeys) {
      const oldest = this.last.keys().next().value;
      if (oldest !== undefined) this.last.delete(oldest);
    }
    this.last.set(key, now);
    return true;
  }

  get size(): number {
    return this.last.size;
  }
}
