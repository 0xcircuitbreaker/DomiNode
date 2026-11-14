/**
 * Admin kill switches (ADMIN_API.md §17).
 *
 * Switch rows live in `kill_switches`, drained nodes in `node_drains`. Each
 * service (gateway, API) keeps a KillSwitchCache that re-reads both tables every
 * KILL_SWITCH_POLL_MS (default 5 s). The cache FAILS CLOSED: if no read has
 * succeeded within KILL_SWITCH_MAX_STALE_MS (default 15 s), every switch reads
 * as engaged and every check returns KILL_SWITCH_UNAVAILABLE.
 */
import { EXIT_CLASSES, type ExitClass } from "./exit-classes.js";

export const PAYMENT_RAIL_SWITCHES = ["x402", "mpp", "tempo", "nowpayments"] as const;
export type PaymentRailSwitch = (typeof PAYMENT_RAIL_SWITCHES)[number];

export const KILL_SWITCH_KEYS = [
  "relay",
  ...EXIT_CLASSES.map((c) => `relay_${c}` as const),
  "signups",
  "api_keys",
  "payouts",
  ...PAYMENT_RAIL_SWITCHES.map((r) => `rail_${r}` as const),
] as const;
export type KillSwitchKey = (typeof KILL_SWITCH_KEYS)[number];

export function isKillSwitchKey(v: unknown): v is KillSwitchKey {
  return typeof v === "string" && (KILL_SWITCH_KEYS as readonly string[]).includes(v);
}

export interface KillSwitchState {
  engaged: ReadonlySet<KillSwitchKey>;
  drainedNodeIds: ReadonlySet<string>;
}

/** Agent-facing refusal: HTTP status, stable error code, message. */
export interface KillSwitchBlock {
  status: 503;
  code:
    | "RELAY_PAUSED"
    | "EXIT_CLASS_PAUSED"
    | "SIGNUPS_PAUSED"
    | "API_KEYS_PAUSED"
    | "PAYOUTS_PAUSED"
    | "PAYMENT_RAIL_PAUSED"
    | "KILL_SWITCH_UNAVAILABLE";
  message: string;
  retryAfterSec: number;
}

const UNAVAILABLE: KillSwitchBlock = {
  status: 503,
  code: "KILL_SWITCH_UNAVAILABLE",
  message: "Service control state is unavailable; refusing new work. Retry shortly.",
  retryAfterSec: 30,
};

const MESSAGES: Record<Exclude<KillSwitchKey, `relay_${ExitClass}` | `rail_${PaymentRailSwitch}`>, Omit<KillSwitchBlock, "status" | "retryAfterSec">> = {
  relay: { code: "RELAY_PAUSED", message: "New relay sessions are paused by the operator. Retry later." },
  signups: { code: "SIGNUPS_PAUSED", message: "New account signups are paused by the operator. Retry later." },
  api_keys: { code: "API_KEYS_PAUSED", message: "New API key creation is paused by the operator. Retry later." },
  payouts: { code: "PAYOUTS_PAUSED", message: "Payouts and withdrawals are paused by the operator. Your balance is unchanged. Retry later." },
};

/** Immutable view over one snapshot (or the fail-closed state). */
export class KillSwitchView {
  constructor(private readonly state: KillSwitchState | null) {}

  /** True when control state could not be read (everything reads as engaged). */
  get unavailable(): boolean { return this.state === null; }

  engaged(key: KillSwitchKey): boolean {
    return this.state === null || this.state.engaged.has(key);
  }

  isDrained(nodeId: string): boolean {
    return this.state === null || this.state.drainedNodeIds.has(nodeId);
  }

  drainedNodeIds(): string[] { return this.state ? [...this.state.drainedNodeIds] : []; }

  /** Exit classes with new sessions paused. */
  pausedClasses(): ExitClass[] {
    return EXIT_CLASSES.filter((c) => this.engaged(`relay_${c}`));
  }

  /** Refusal for a simple switch (signups, api_keys, payouts), or null. */
  check(key: "signups" | "api_keys" | "payouts"): KillSwitchBlock | null {
    if (this.state === null) return UNAVAILABLE;
    if (!this.state.engaged.has(key)) return null;
    return { status: 503, ...MESSAGES[key], retryAfterSec: 300 };
  }

  /** Refusal for a payment rail, or null. */
  checkRail(rail: PaymentRailSwitch): KillSwitchBlock | null {
    if (this.state === null) return UNAVAILABLE;
    if (!this.state.engaged.has(`rail_${rail}`)) return null;
    return {
      status: 503, code: "PAYMENT_RAIL_PAUSED", retryAfterSec: 300,
      message: `The ${rail} payment rail is paused by the operator. Use another rail or retry later.`,
    };
  }

  /**
   * Refusal for a new relay session. `ipClass` is the requested class; with
   * none, the session is refused only when every non-masked class is paused
   * (unflagged requests never use masked exits).
   */
  checkRelay(ipClass?: ExitClass): KillSwitchBlock | null {
    if (this.state === null) return UNAVAILABLE;
    if (this.state.engaged.has("relay")) return { status: 503, ...MESSAGES.relay, retryAfterSec: 300 };
    const paused = this.pausedClasses();
    const blocked = ipClass
      ? paused.includes(ipClass)
      : EXIT_CLASSES.filter((c) => c !== "masked").every((c) => paused.includes(c));
    if (!blocked) return null;
    return {
      status: 503, code: "EXIT_CLASS_PAUSED", retryAfterSec: 300,
      message: ipClass
        ? `New sessions on ${ipClass} exits are paused by the operator. Try another class or retry later.`
        : "New sessions on all default exit classes are paused by the operator. Retry later.",
    };
  }
}

export interface KillSwitchCacheOptions {
  load: () => Promise<KillSwitchState>;
  pollMs?: number;
  maxStaleMs?: number;
  now?: () => number;
  onError?: (err: unknown) => void;
}

export const KILL_SWITCH_POLL_MS_DEFAULT = 5_000;
export const KILL_SWITCH_MAX_STALE_MS_DEFAULT = 15_000;

/** Poll + cache; current() is synchronous and fails closed when stale. */
export class KillSwitchCache {
  private state: KillSwitchState | null = null;
  private loadedAt = -Infinity;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  readonly pollMs: number;
  readonly maxStaleMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: KillSwitchCacheOptions) {
    this.pollMs = opts.pollMs ?? KILL_SWITCH_POLL_MS_DEFAULT;
    this.maxStaleMs = opts.maxStaleMs ?? KILL_SWITCH_MAX_STALE_MS_DEFAULT;
    this.now = opts.now ?? Date.now;
  }

  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const s = await this.opts.load();
        this.state = s;
        this.loadedAt = this.now();
      } catch (err) {
        this.opts.onError?.(err);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** First load then poll. Resolves after the first attempt (success or not). */
  async start(): Promise<void> {
    await this.refresh();
    if (!this.timer) {
      this.timer = setInterval(() => { void this.refresh(); }, this.pollMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  current(): KillSwitchView {
    if (this.state === null || this.now() - this.loadedAt > this.maxStaleMs) return new KillSwitchView(null);
    return new KillSwitchView(this.state);
  }
}

// ─── Process-wide gate ──────────────────────────────────────────────

let processCache: KillSwitchCache | null = null;

/** Install the service's cache (called from main.ts before listening). */
export function configureKillSwitches(cache: KillSwitchCache | null): void {
  processCache = cache;
}

const OPEN = new KillSwitchView({ engaged: new Set(), drainedNodeIds: new Set() });

/**
 * Current view. Without a configured cache: fail closed in production, all
 * switches off elsewhere (unit tests that never start a service).
 */
export function killSwitches(env: NodeJS.ProcessEnv = process.env): KillSwitchView {
  if (processCache) return processCache.current();
  return env.NODE_ENV === "production" ? new KillSwitchView(null) : OPEN;
}

/** Parse a bounded integer env var (NaN / out of range → default). */
export function killSwitchEnvMs(env: NodeJS.ProcessEnv, name: "KILL_SWITCH_POLL_MS" | "KILL_SWITCH_MAX_STALE_MS"): number {
  const [def, min, max] = name === "KILL_SWITCH_POLL_MS"
    ? [KILL_SWITCH_POLL_MS_DEFAULT, 1_000, 10_000]
    : [KILL_SWITCH_MAX_STALE_MS_DEFAULT, 5_000, 120_000];
  const raw = name === "KILL_SWITCH_POLL_MS" ? env.KILL_SWITCH_POLL_MS : env.KILL_SWITCH_MAX_STALE_MS;
  if (raw === undefined || raw === "") return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max || String(n) !== raw.trim()) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}
