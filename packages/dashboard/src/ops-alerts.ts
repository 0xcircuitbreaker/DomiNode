import { createLogger, getPool, resolveAndCheck, isValidHostname } from "@dominusnode/shared";
import type { ResolveCheckResult } from "@dominusnode/shared";
import https from "node:https";
import net from "node:net";
import type { LookupFunction } from "node:net";

/**
 * Operator push alerting (docs/agent-network/ADMIN_API.md §16).
 *
 * A periodic checker in the API process evaluates health and abuse rules and
 * posts deduplicated, rate-limited notifications to the webhooks listed in
 * OPS_ALERT_WEBHOOKS. Payloads carry only rule ids, numbers and fixed text:
 * no user ids, wallet addresses, keys or webhook URLs.
 */
const log = createLogger("api:ops-alerts");

// ─── Configuration ──────────────────────────────────────────────────

export type WebhookKind = "json" | "slack" | "discord" | "ntfy";
export const WEBHOOK_KINDS: readonly WebhookKind[] = ["json", "slack", "discord", "ntfy"];
export const MAX_WEBHOOKS = 8;
const MAX_URL_LEN = 2048;

export interface OpsWebhook {
  kind: WebhookKind;
  url: URL;
}

export interface OpsAlertConfig {
  webhooks: OpsWebhook[];
  intervalSec: number;
  gatewayStaleSec: number;
  minLiveNodes: number;
  nodeDropPct: number;
  paymentFailures: number;
  debitSpikeCents: number;
  debitSpikeFactor: number;
  v1ErrorPct: number;
  v1MinRequests: number;
  dedupeSec: number;
  maxPerHour: number;
}

export class OpsAlertConfigError extends Error {}

function intEnv(raw: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw.trim())) throw new OpsAlertConfigError(`${name} must be an integer`);
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new OpsAlertConfigError(`${name} must be between ${min} and ${max}`);
  }
  return n;
}

/**
 * Parse OPS_ALERT_WEBHOOKS: comma-separated `[kind=]https://host/path` entries,
 * kind one of json (default), slack, discord, ntfy. HTTPS only, no userinfo,
 * hostname syntax checked here; DNS/SSRF in validateWebhooks().
 */
export function parseWebhooks(raw: string | undefined): OpsWebhook[] {
  const out: OpsWebhook[] = [];
  if (!raw || raw.trim() === "") return out;
  for (const part of raw.split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    let kind: WebhookKind = "json";
    let urlText = entry;
    const m = /^([a-z]+)=(.+)$/.exec(entry);
    if (m) {
      if (!WEBHOOK_KINDS.includes(m[1] as WebhookKind)) {
        throw new OpsAlertConfigError(`OPS_ALERT_WEBHOOKS: unknown kind '${m[1]}'`);
      }
      kind = m[1] as WebhookKind;
      urlText = m[2]!;
    }
    if (urlText.length > MAX_URL_LEN) throw new OpsAlertConfigError("OPS_ALERT_WEBHOOKS: URL too long");
    let url: URL;
    try {
      url = new URL(urlText);
    } catch {
      // Never echo the URL: Slack/Discord paths are secrets.
      throw new OpsAlertConfigError(`OPS_ALERT_WEBHOOKS: entry ${out.length + 1} is not a valid URL`);
    }
    if (url.protocol !== "https:") throw new OpsAlertConfigError("OPS_ALERT_WEBHOOKS: only https:// URLs are allowed");
    if (url.username || url.password) throw new OpsAlertConfigError("OPS_ALERT_WEBHOOKS: credentials in URL are not allowed");
    if (url.port && url.port !== "443") throw new OpsAlertConfigError("OPS_ALERT_WEBHOOKS: only port 443 is allowed");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!isValidHostname(host) || /\.(localhost|local|internal|arpa)$/i.test(host) || /^localhost$/i.test(host)) {
      throw new OpsAlertConfigError("OPS_ALERT_WEBHOOKS: invalid or internal hostname");
    }
    out.push({ kind, url });
    if (out.length > MAX_WEBHOOKS) throw new OpsAlertConfigError(`OPS_ALERT_WEBHOOKS: at most ${MAX_WEBHOOKS} entries`);
  }
  return out;
}

export function loadOpsAlertConfig(env: NodeJS.ProcessEnv = process.env): OpsAlertConfig {
  return {
    webhooks: parseWebhooks(env["OPS_ALERT_WEBHOOKS"]),
    intervalSec: intEnv(env["OPS_ALERT_INTERVAL_SEC"] ?? "60", "OPS_ALERT_INTERVAL_SEC", 10, 3600),
    gatewayStaleSec: intEnv(env["OPS_ALERT_GATEWAY_STALE_SEC"] ?? "180", "OPS_ALERT_GATEWAY_STALE_SEC", 30, 86400),
    minLiveNodes: intEnv(env["OPS_ALERT_MIN_LIVE_NODES"] ?? "0", "OPS_ALERT_MIN_LIVE_NODES", 0, 1000000),
    nodeDropPct: intEnv(env["OPS_ALERT_NODE_DROP_PCT"] ?? "50", "OPS_ALERT_NODE_DROP_PCT", 1, 100),
    paymentFailures: intEnv(env["OPS_ALERT_PAYMENT_FAILURES"] ?? "3", "OPS_ALERT_PAYMENT_FAILURES", 1, 100000),
    debitSpikeCents: intEnv(env["OPS_ALERT_DEBIT_SPIKE_CENTS"] ?? "5000", "OPS_ALERT_DEBIT_SPIKE_CENTS", 1, 2147483647),
    debitSpikeFactor: intEnv(env["OPS_ALERT_DEBIT_SPIKE_FACTOR"] ?? "5", "OPS_ALERT_DEBIT_SPIKE_FACTOR", 1, 1000),
    v1ErrorPct: intEnv(env["OPS_ALERT_V1_ERROR_PCT"] ?? "20", "OPS_ALERT_V1_ERROR_PCT", 1, 100),
    v1MinRequests: intEnv(env["OPS_ALERT_V1_MIN_REQUESTS"] ?? "50", "OPS_ALERT_V1_MIN_REQUESTS", 1, 10000000),
    dedupeSec: intEnv(env["OPS_ALERT_DEDUPE_SEC"] ?? "1800", "OPS_ALERT_DEDUPE_SEC", 60, 604800),
    maxPerHour: intEnv(env["OPS_ALERT_MAX_PER_HOUR"] ?? "30", "OPS_ALERT_MAX_PER_HOUR", 1, 1000),
  };
}

/** DNS + SSRF check of every webhook host (all resolved addresses must be public). */
export async function validateWebhooks(
  hooks: OpsWebhook[],
  resolve: (host: string) => Promise<ResolveCheckResult> = resolveAndCheck,
): Promise<void> {
  for (let i = 0; i < hooks.length; i++) {
    const r = await resolve(hooks[i]!.url.hostname.replace(/^\[|\]$/g, ""));
    if (!r.allowed) {
      throw new OpsAlertConfigError(`OPS_ALERT_WEBHOOKS: entry ${i + 1} rejected (${r.reason ?? "blocked"})`);
    }
  }
}

// ─── In-process event counters (per-minute buckets) ─────────────────

export type OpsEventKind = "payment_webhook_failure" | "v1_request" | "v1_error";
const BUCKET_MS = 60_000;
const BUCKETS_KEPT = 15;
const buckets = new Map<number, Record<OpsEventKind, number>>();

export function recordOpsEvent(kind: OpsEventKind, now = Date.now()): void {
  const b = Math.floor(now / BUCKET_MS);
  let row = buckets.get(b);
  if (!row) {
    row = { payment_webhook_failure: 0, v1_request: 0, v1_error: 0 };
    buckets.set(b, row);
    for (const k of buckets.keys()) if (k <= b - BUCKETS_KEPT) buckets.delete(k);
  }
  row[kind]++;
}

/** Count of `kind` in the last `minutes` whole buckets (current included). */
export function countOpsEvents(kind: OpsEventKind, minutes: number, now = Date.now()): number {
  const b = Math.floor(now / BUCKET_MS);
  let n = 0;
  for (const [k, row] of buckets) if (k > b - minutes && k <= b) n += row[kind];
  return n;
}

export function resetOpsEvents(): void {
  buckets.clear();
}

/** Express middleware for /v1: counts requests and 5xx responses. */
export function v1ErrorCounter(_req: unknown, res: { on(ev: "finish", fn: () => void): unknown; statusCode: number }, next: () => void): void {
  res.on("finish", () => {
    recordOpsEvent("v1_request");
    if (res.statusCode >= 500) recordOpsEvent("v1_error");
  });
  next();
}

// ─── Metrics source ─────────────────────────────────────────────────

export interface OpsMetrics {
  /** Seconds since the newest gateway heartbeat, null if none recorded. */
  gatewayHeartbeatAgeSec(): Promise<number | null>;
  liveNodeCount(): Promise<number>;
  /** Wallet debits (cents) in the last 10 min and the 10-min average over the 6 h before. */
  walletDebits(): Promise<{ recentCents: number; baselineCents: number }>;
}

export const dbOpsMetrics: OpsMetrics = {
  async gatewayHeartbeatAgeSec() {
    const r = await getPool().query<{ age_sec: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - GREATEST(
         (SELECT MAX(heartbeat_at) FROM node_ip_slots),
         (SELECT MAX(last_finished_at) FROM job_runs)
       )))::float8 AS age_sec`,
    );
    const v = r.rows[0]?.age_sec;
    return v === null || v === undefined ? null : Number(v);
  },
  async liveNodeCount() {
    const r = await getPool().query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM node_ip_slots WHERE heartbeat_at > now() - interval '90 seconds'`,
    );
    return Number(r.rows[0]?.n ?? 0);
  },
  async walletDebits() {
    const r = await getPool().query<{ recent: string; prior: string }>(
      `SELECT
         COALESCE(SUM(amount_cents) FILTER (WHERE created_at > now() - interval '10 minutes'), 0)::text AS recent,
         COALESCE(SUM(amount_cents) FILTER (WHERE created_at <= now() - interval '10 minutes'), 0)::text AS prior
       FROM wallet_transactions
       WHERE type = 'debit' AND created_at > now() - interval '370 minutes'`,
    );
    const recent = Number(r.rows[0]?.recent ?? 0);
    const prior = Number(r.rows[0]?.prior ?? 0);
    return { recentCents: recent, baselineCents: Math.round(prior / 36) };
  },
};

// ─── Alerts ─────────────────────────────────────────────────────────

export type Severity = "critical" | "warning" | "info";

export interface OpsAlert {
  rule: string;
  severity: Severity;
  status: "firing" | "resolved" | "test";
  summary: string;
  values: Record<string, number | null>;
  at: string;
}

export interface SentAlert extends OpsAlert {
  delivered: number;
  suppressed: "dedupe" | "rate_limit" | null;
}

export function formatPayload(kind: WebhookKind, a: OpsAlert, instance: string): { body: string; headers: Record<string, string> } {
  const title = `[${a.status === "resolved" ? "RESOLVED" : a.severity.toUpperCase()}] DominusNode ${a.rule}`;
  const text = `${title}: ${a.summary}`;
  switch (kind) {
    case "slack":
      return { body: JSON.stringify({ text }), headers: { "content-type": "application/json" } };
    case "discord":
      return { body: JSON.stringify({ content: text.slice(0, 2000), allowed_mentions: { parse: [] } }), headers: { "content-type": "application/json" } };
    case "ntfy":
      return {
        body: a.summary,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          Title: title.replace(/[^\x20-\x7e]/g, ""),
          Priority: a.status === "resolved" ? "default" : a.severity === "critical" ? "urgent" : a.severity === "warning" ? "high" : "default",
          Tags: a.status === "resolved" ? "white_check_mark" : "warning",
        },
      };
    default:
      return {
        body: JSON.stringify({ source: "dominusnode", instance, ...a }),
        headers: { "content-type": "application/json" },
      };
  }
}

export type Sender = (hook: OpsWebhook, body: string, headers: Record<string, string>) => Promise<void>;

/**
 * Build a dns.lookup replacement that only ever returns the pre-vetted
 * addresses, so the socket connects to exactly what the SSRF check approved
 * (no second resolution an attacker could rebind between check and connect).
 */
export function pinnedLookup(addresses: string[]): LookupFunction {
  return ((_host: string, opts: unknown, cb?: unknown) => {
    const callback = (typeof opts === "function" ? opts : cb) as (...args: unknown[]) => void;
    const o = (typeof opts === "object" && opts !== null ? opts : {}) as { all?: boolean; family?: number };
    const list = addresses
      .map((address) => ({ address, family: net.isIP(address) }))
      .filter((a) => a.family !== 0 && (!o.family || a.family === o.family));
    if (list.length === 0) {
      callback(Object.assign(new Error("no vetted address"), { code: "ENOTFOUND" }));
      return;
    }
    if (o.all) callback(null, list);
    else callback(null, list[0]!.address, list[0]!.family);
  }) as LookupFunction;
}

/**
 * POST with an SSRF check per send, the connection pinned to the vetted
 * addresses (DNS rebinding), no redirects, 5 s timeout, 64 KiB response cap.
 */
export const defaultSender: Sender = async (hook, body, headers) => {
  const r = await resolveAndCheck(hook.url.hostname.replace(/^\[|\]$/g, ""));
  if (!r.allowed || !r.addresses || r.addresses.length === 0) throw new Error("webhook host rejected by SSRF check");
  const lookup = pinnedLookup(r.addresses);
  const status = await new Promise<number>((resolve, reject) => {
    const req = https.request(hook.url, {
      method: "POST",
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)) },
      lookup,
      timeout: 5000,
    }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("webhook timed out")));
    req.on("error", (e) => reject(new Error(`webhook request failed: ${(e as NodeJS.ErrnoException).code ?? "error"}`)));
    req.end(body);
  });
  if (status < 200 || status >= 300) throw new Error(`webhook returned HTTP ${status}`);
};

export const MAX_DEDUPE_ENTRIES = 1000;
export const MAX_RECENT = 200;
const NODE_WINDOW_MS = 10 * 60_000;

export interface OpsAlerterDeps {
  config: OpsAlertConfig;
  metrics?: OpsMetrics;
  send?: Sender;
  now?: () => number;
  instance?: string;
}

export class OpsAlerter {
  readonly config: OpsAlertConfig;
  private readonly metrics: OpsMetrics;
  private readonly send: Sender;
  private readonly now: () => number;
  private readonly instance: string;
  /** rule -> last notification time (ms). Capped + pruned. */
  private readonly dedupe = new Map<string, number>();
  private readonly firing = new Set<string>();
  private readonly sentTimes: number[] = [];
  private readonly recent: SentAlert[] = [];
  private nodeSamples: Array<{ t: number; n: number }> = [];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(deps: OpsAlerterDeps) {
    this.config = deps.config;
    this.metrics = deps.metrics ?? dbOpsMetrics;
    this.send = deps.send ?? defaultSender;
    this.now = deps.now ?? Date.now;
    this.instance = (deps.instance ?? "api").slice(0, 64);
  }

  /** Evaluate every rule once; returns the alerts currently firing. */
  async evaluate(): Promise<OpsAlert[]> {
    const c = this.config;
    const now = this.now();
    const at = new Date(now).toISOString();
    const active: OpsAlert[] = [];
    const evaluated = new Set<string>();

    const check = async (rule: string, fn: () => Promise<OpsAlert | null>) => {
      try {
        const a = await fn();
        evaluated.add(rule);
        if (a) active.push(a);
      } catch (err) {
        log.warn("ops alert rule failed", { rule, error: err instanceof Error ? err.message : String(err) });
      }
    };

    await check("gateway_heartbeat_stale", async () => {
      const age = await this.metrics.gatewayHeartbeatAgeSec();
      if (age === null || age <= c.gatewayStaleSec) return null;
      return { rule: "gateway_heartbeat_stale", severity: "critical", status: "firing", at,
        summary: `No gateway heartbeat for ${Math.round(age)} s (threshold ${c.gatewayStaleSec} s)`,
        values: { ageSec: Math.round(age), thresholdSec: c.gatewayStaleSec } };
    });

    let liveNodes: number | null = null;
    await check("live_nodes_low", async () => {
      liveNodes = await this.metrics.liveNodeCount();
      if (c.minLiveNodes === 0 || liveNodes >= c.minLiveNodes) return null;
      return { rule: "live_nodes_low", severity: "critical", status: "firing", at,
        summary: `${liveNodes} live nodes (minimum ${c.minLiveNodes})`,
        values: { liveNodes, minimum: c.minLiveNodes } };
    });

    if (liveNodes !== null) {
      const n: number = liveNodes;
      this.nodeSamples = this.nodeSamples.filter((s) => s.t >= now - NODE_WINDOW_MS);
      const peak = this.nodeSamples.reduce((m, s) => Math.max(m, s.n), 0);
      this.nodeSamples.push({ t: now, n });
      evaluated.add("live_nodes_drop");
      if (peak > 0 && n < peak) {
        const dropPct = Math.round(((peak - n) / peak) * 100);
        if (dropPct >= c.nodeDropPct) {
          active.push({ rule: "live_nodes_drop", severity: "warning", status: "firing", at,
            summary: `Live nodes fell ${dropPct}% in 10 min (${peak} -> ${n})`,
            values: { peak, liveNodes: n, dropPct, thresholdPct: c.nodeDropPct } });
        }
      }
    }

    await check("payment_webhook_failures", async () => {
      const f = countOpsEvents("payment_webhook_failure", 10, now);
      if (f < c.paymentFailures) return null;
      return { rule: "payment_webhook_failures", severity: "critical", status: "firing", at,
        summary: `${f} payment webhook failures in 10 min (threshold ${c.paymentFailures})`,
        values: { failures: f, threshold: c.paymentFailures } };
    });

    await check("wallet_debit_spike", async () => {
      const d = await this.metrics.walletDebits();
      if (d.recentCents < c.debitSpikeCents || d.recentCents < c.debitSpikeFactor * Math.max(d.baselineCents, 1)) return null;
      return { rule: "wallet_debit_spike", severity: "warning", status: "firing", at,
        summary: `Wallet debits $${(d.recentCents / 100).toFixed(2)} in 10 min vs $${(d.baselineCents / 100).toFixed(2)} baseline`,
        values: { recentCents: d.recentCents, baselineCents: d.baselineCents, factor: c.debitSpikeFactor } };
    });

    await check("v1_error_rate", async () => {
      const total = countOpsEvents("v1_request", 10, now);
      const errs = countOpsEvents("v1_error", 10, now);
      if (total < c.v1MinRequests) return null;
      const pct = Math.round((errs / total) * 100);
      if (pct < c.v1ErrorPct) return null;
      return { rule: "v1_error_rate", severity: "warning", status: "firing", at,
        summary: `${pct}% of /v1 requests returned 5xx in 10 min (${errs}/${total})`,
        values: { errorPct: pct, errors: errs, requests: total, thresholdPct: c.v1ErrorPct } };
    });

    const activeRules = new Set(active.map((a) => a.rule));
    for (const a of active) {
      this.firing.add(a.rule);
      await this.notify(a);
    }
    for (const rule of [...this.firing]) {
      if (activeRules.has(rule) || !evaluated.has(rule)) continue;
      this.firing.delete(rule);
      this.dedupe.delete(rule);
      await this.notify({ rule, severity: "info", status: "resolved", at, summary: `${rule} cleared`, values: {} });
    }
    this.pruneDedupe(now);
    return active;
  }

  /** Send a test notification, bypassing dedupe (still rate-limited). */
  async sendTest(): Promise<SentAlert> {
    return this.notify({ rule: "test", severity: "info", status: "test", at: new Date(this.now()).toISOString(),
      summary: "Test alert from the DominusNode admin API", values: {} }, true);
  }

  async notify(a: OpsAlert, skipDedupe = false): Promise<SentAlert> {
    const now = this.now();
    let suppressed: SentAlert["suppressed"] = null;
    if (!skipDedupe && a.status === "firing") {
      const last = this.dedupe.get(a.rule);
      if (last !== undefined && now - last < this.config.dedupeSec * 1000) suppressed = "dedupe";
    }
    while (this.sentTimes.length && this.sentTimes[0]! <= now - 3600_000) this.sentTimes.shift();
    if (!suppressed && this.sentTimes.length >= this.config.maxPerHour) suppressed = "rate_limit";

    let delivered = 0;
    if (!suppressed) {
      this.sentTimes.push(now);
      if (a.status === "firing") {
        this.dedupe.delete(a.rule);
        this.dedupe.set(a.rule, now);
        while (this.dedupe.size > MAX_DEDUPE_ENTRIES) {
          const oldest = this.dedupe.keys().next().value;
          if (oldest === undefined) break;
          this.dedupe.delete(oldest);
        }
      }
      const results = await Promise.allSettled(this.config.webhooks.map((h) => {
        const p = formatPayload(h.kind, a, this.instance);
        return this.send(h, p.body, p.headers);
      }));
      results.forEach((r, i) => {
        if (r.status === "fulfilled") delivered++;
        else log.warn("ops alert delivery failed", { webhook: i + 1, kind: this.config.webhooks[i]!.kind,
          error: r.reason instanceof Error ? r.reason.message.slice(0, 200) : "error" });
      });
      log.warn("ops alert", { rule: a.rule, status: a.status, severity: a.severity, delivered });
    }
    const rec: SentAlert = { ...a, delivered, suppressed };
    if (suppressed !== "dedupe") this.pushRecent(rec);
    return rec;
  }

  private pushRecent(r: SentAlert): void {
    this.recent.push(r);
    if (this.recent.length > MAX_RECENT) this.recent.splice(0, this.recent.length - MAX_RECENT);
  }

  private pruneDedupe(now: number): void {
    const ttl = Math.max(this.config.dedupeSec * 1000, 86400_000);
    for (const [k, t] of this.dedupe) if (now - t > ttl) this.dedupe.delete(k);
  }

  recentAlerts(limit = 50): SentAlert[] {
    return this.recent.slice(-Math.max(1, Math.min(limit, MAX_RECENT))).reverse();
  }

  firingRules(): string[] {
    return [...this.firing].sort();
  }

  dedupeSize(): number {
    return this.dedupe.size;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      this.evaluate().catch((err) => log.error("ops alert evaluation failed", { error: err instanceof Error ? err.message : String(err) }))
        .finally(() => { this.running = false; });
    }, this.config.intervalSec * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ─── Process singleton ──────────────────────────────────────────────

let current: OpsAlerter | null = null;

export function getOpsAlerter(): OpsAlerter | null {
  return current;
}

export function setOpsAlerter(a: OpsAlerter | null): void {
  current = a;
}

/**
 * Load + validate config (throws on bad env or an SSRF-rejected webhook) and
 * start the checker. Rules still run with no webhooks configured: alerts are
 * logged and listed by the admin endpoint.
 */
export async function startOpsAlerts(env: NodeJS.ProcessEnv = process.env): Promise<OpsAlerter> {
  const config = loadOpsAlertConfig(env);
  await validateWebhooks(config.webhooks);
  const a = new OpsAlerter({ config });
  a.start();
  setOpsAlerter(a);
  log.info("ops alerting started", { webhooks: config.webhooks.length, intervalSec: config.intervalSec });
  return a;
}
