/**
 * Local per-node caps (DESIGN.md §3, §11 row 6): concurrent streams, OPEN req/s
 * and GB/day. Policy and gateway hints can only lower these (tighten()).
 */
export interface LimitValues {
  maxStreams: number;
  reqPerSec: number;
  gbPerDay: number;
}

const DAY_MS = 86_400_000;
const BYTES_PER_GB = 1_000_000_000;

export class Limits {
  private caps: LimitValues;
  private active = 0;
  private tokens: number;
  private lastRefill: number;
  private bytesToday = 0;
  private day: number;

  constructor(caps: LimitValues, private readonly now: () => number = Date.now) {
    this.caps = { ...caps };
    this.tokens = caps.reqPerSec;
    this.lastRefill = now();
    this.day = Math.floor(this.lastRefill / DAY_MS);
  }

  get values(): Readonly<LimitValues> {
    return this.caps;
  }

  get activeStreams(): number {
    return this.active;
  }

  /** Lower caps only; any value above the current cap (or invalid) is ignored. */
  tighten(next: Partial<LimitValues>): void {
    for (const k of ["maxStreams", "reqPerSec", "gbPerDay"] as const) {
      const v = next[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < this.caps[k]) this.caps[k] = v;
    }
    this.tokens = Math.min(this.tokens, this.caps.reqPerSec);
  }

  private rollDay(): void {
    const d = Math.floor(this.now() / DAY_MS);
    if (d !== this.day) {
      this.day = d;
      this.bytesToday = 0;
    }
  }

  /** Reserve a stream slot. Caller must release() exactly once on success. */
  tryOpenStream(): boolean {
    this.rollDay();
    if (this.active >= this.caps.maxStreams) return false;
    if (this.bytesToday >= this.caps.gbPerDay * BYTES_PER_GB) return false;
    const t = this.now();
    this.tokens = Math.min(this.caps.reqPerSec, this.tokens + ((t - this.lastRefill) / 1000) * this.caps.reqPerSec);
    this.lastRefill = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    this.active++;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active--;
  }

  /** Account relayed bytes. Returns false once the daily cap is exceeded. */
  addBytes(n: number): boolean {
    this.rollDay();
    if (Number.isFinite(n) && n > 0) this.bytesToday += n;
    return this.bytesToday <= this.caps.gbPerDay * BYTES_PER_GB;
  }

  get bytesUsedToday(): number {
    this.rollDay();
    return this.bytesToday;
  }
}
