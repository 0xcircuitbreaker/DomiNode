/**
 * Sliding-window limiter whose state belongs to one McpServer. The stdio
 * server has a single instance, so behaviour there is unchanged; on the remote
 * endpoint each agent session gets its own state, so one tenant cannot use up
 * another tenant's tool limits.
 */
export class SlidingWindow {
  private readonly ts: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number) {}

  private prune(now: number): void {
    while (this.ts.length > 0 && now - this.ts[0] > this.windowMs) this.ts.shift();
    if (this.ts.length > 100) this.ts.length = 100;
  }

  /** Take a slot; false when the window is full. */
  take(): boolean {
    const now = Date.now();
    this.prune(now);
    if (this.ts.length >= this.max) return false;
    this.ts.push(now);
    return true;
  }

  /** True while the window has room (does not take a slot). */
  allowed(): boolean {
    this.prune(Date.now());
    return this.ts.length < this.max;
  }

  /** Record an event without checking (e.g. a failed verification). */
  record(): void {
    this.ts.push(Date.now());
  }
}

/** Per-server state, created lazily and dropped with the server. */
export function perServer<T>(make: () => T): { get(server: object): T; reset(): void } {
  let m = new WeakMap<object, T>();
  return {
    get(server: object): T {
      let v = m.get(server);
      if (!v) { v = make(); m.set(server, v); }
      return v;
    },
    reset(): void { m = new WeakMap(); },
  };
}
