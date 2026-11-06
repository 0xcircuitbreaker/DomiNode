/**
 * Background job runner (DESIGN.md §6.4, §15 commit 22/22b).
 * Each job is a pure `runOnce(deps)` plus a timer. Jobs that must run on one
 * gateway instance only take a session-level pg advisory lock for the run.
 */

export interface LockClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}
export interface LockPool {
  connect(): Promise<LockClient>;
}

/** Advisory-lock keys (fixed, distinct per job). */
export const JOB_LOCK_KEYS = {
  maturity: 0x444e_0001,
  retention: 0x444e_0002,
  tiers: 0x444e_0003,
  payouts: 0x444e_0004,
  settleRetry: 0x444e_0005,
} as const;

/**
 * Run `fn` only if this process wins pg_try_advisory_lock(key). The lock is
 * held on one dedicated client for the whole run and always released.
 */
export async function withAdvisoryLock<T>(pool: LockPool, key: number, fn: () => Promise<T>): Promise<{ ran: boolean; result?: T }> {
  const client = await pool.connect();
  try {
    const r = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [key]);
    if (r.rows[0]?.["ok"] !== true) return { ran: false };
    try {
      return { ran: true, result: await fn() };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [key]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Parse an integer env var with NaN + range validation (fails fast on bad config). */
export function envInt(env: NodeJS.ProcessEnv, name: string, def: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return v;
}

export interface JobLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface JobOptions {
  name: string;
  intervalMs: number;
  /** null = per-instance job (no advisory lock). */
  lockKey: number | null;
  pool?: LockPool;
  run: () => Promise<unknown>;
  logger: JobLogger;
  initialDelayMs?: number;
}

export interface JobRunRecord {
  name: string;
  startedAt: Date;
  finishedAt: Date;
  ok: boolean;
  error: string | null;
}

/** Optional sink for per-run heartbeats (job_runs table). Never throws into the job. */
type JobRunRecorder = (r: JobRunRecord) => Promise<void>;
let recorder: JobRunRecorder | null = null;
export function setJobRunRecorder(fn: JobRunRecorder | null): void {
  recorder = fn;
}

/** SQL used by the gateway to upsert a job heartbeat row. */
export const JOB_RUN_UPSERT_SQL = `INSERT INTO job_runs (job_name, instance_id, last_started_at, last_finished_at, last_ok, last_error,
    last_duration_ms, last_success_at, run_count, fail_count)
  VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5 THEN $4::timestamptz END, 1, CASE WHEN $5 THEN 0 ELSE 1 END)
  ON CONFLICT (job_name) DO UPDATE SET instance_id = EXCLUDED.instance_id,
    last_started_at = EXCLUDED.last_started_at, last_finished_at = EXCLUDED.last_finished_at,
    last_ok = EXCLUDED.last_ok, last_error = EXCLUDED.last_error, last_duration_ms = EXCLUDED.last_duration_ms,
    last_success_at = COALESCE(EXCLUDED.last_success_at, job_runs.last_success_at),
    run_count = job_runs.run_count + 1, fail_count = job_runs.fail_count + EXCLUDED.fail_count`;

/** Interval job that never overlaps itself and can be stopped gracefully. */
export class Job {
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private current: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly o: JobOptions) {
    if (!Number.isInteger(o.intervalMs) || o.intervalMs < 1000) throw new Error(`${o.name}: intervalMs must be >= 1000`);
    if (o.lockKey !== null && !o.pool) throw new Error(`${o.name}: lockKey requires a pool`);
  }

  get running(): boolean {
    return this.current !== null;
  }

  /** One tick: skipped while a previous tick is still running. */
  tick(): Promise<void> {
    if (this.stopped || this.current) return this.current ?? Promise.resolve();
    const p = (async () => {
      const startedAt = new Date();
      let ok = true;
      let error: string | null = null;
      try {
        if (this.o.lockKey !== null) {
          const r = await withAdvisoryLock(this.o.pool!, this.o.lockKey, this.o.run);
          if (!r.ran) return;
          this.logResult(r.result);
        } else {
          this.logResult(await this.o.run());
        }
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message.slice(0, 200) : "unknown";
        this.o.logger.error(`job ${this.o.name} failed`, { error });
      }
      if (recorder) {
        await recorder({ name: this.o.name, startedAt, finishedAt: new Date(), ok, error }).catch(() => {});
      }
    })().finally(() => {
      this.current = null;
    });
    this.current = p;
    return p;
  }

  private logResult(result: unknown): void {
    if (result && typeof result === "object") {
      const meta: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(result as Record<string, unknown>)) meta[k] = typeof v === "bigint" ? v.toString() : v;
      this.o.logger.info(`job ${this.o.name} ran`, meta);
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.kick = setTimeout(() => void this.tick(), this.o.initialDelayMs ?? 5_000);
    this.kick.unref?.();
    this.timer = setInterval(() => void this.tick(), this.o.intervalMs);
    this.timer.unref?.();
  }

  /** Stop the timer and wait for an in-flight run to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    if (this.current) await this.current;
  }
}
