import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({ clientQuery: vi.fn(), release: vi.fn(), resolve: vi.fn() }));

vi.mock("@dominusnode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dominusnode/shared")>();
  return {
    ...actual,
    resolveAndCheck: m.resolve,
    getPool: () => ({ query: vi.fn(), connect: async () => ({ query: m.clientQuery, release: m.release }) }),
  };
});
vi.mock("./middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as unknown as { user: unknown }).user = { userId: "44444444-4444-4444-8444-444444444444" };
    next();
  },
}));
vi.mock("./middleware/admin.js", () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import {
  parseWebhooks, loadOpsAlertConfig, validateWebhooks, OpsAlertConfigError, OpsAlerter, formatPayload,
  recordOpsEvent, countOpsEvents, resetOpsEvents, setOpsAlerter, v1ErrorCounter, MAX_DEDUPE_ENTRIES,
  type OpsMetrics, type OpsAlertConfig,
} from "./ops-alerts.js";
import router from "./routes/admin-ops-alerts.js";
import { call } from "./routes/v1/test-helpers.js";

const SLACK = "https://hooks.slack.example/services/T000/B000/SECRETPATH";

function cfg(o: Partial<OpsAlertConfig> = {}): OpsAlertConfig {
  return { ...loadOpsAlertConfig({ OPS_ALERT_WEBHOOKS: `slack=${SLACK},https://alerts.example/hook` }), ...o };
}

function metrics(o: Partial<{ age: number | null; nodes: number; recent: number; baseline: number }> = {}) {
  const s = { age: 10 as number | null, nodes: 10, recent: 0, baseline: 0, ...o };
  const mm: OpsMetrics = {
    gatewayHeartbeatAgeSec: async () => s.age,
    liveNodeCount: async () => s.nodes,
    walletDebits: async () => ({ recentCents: s.recent, baselineCents: s.baseline }),
  };
  return { s, mm };
}

function setup(o: Partial<OpsAlertConfig> = {}, mo = {}) {
  let t = 1_700_000_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const { s, mm } = metrics(mo);
  const send = vi.fn(async () => undefined);
  const a = new OpsAlerter({ config: cfg(o), metrics: mm, send, now: clock.now });
  return { a, s, send, clock };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOpsEvents();
  setOpsAlerter(null);
});

describe("config", () => {
  it("parses kinds and defaults", () => {
    const h = parseWebhooks(`slack=${SLACK}, ntfy=https://ntfy.example/topic ,https://x.example/a`);
    expect(h.map((x) => x.kind)).toEqual(["slack", "ntfy", "json"]);
    expect(parseWebhooks(undefined)).toEqual([]);
    const c = loadOpsAlertConfig({});
    expect(c.intervalSec).toBe(60);
    expect(c.minLiveNodes).toBe(0);
  });
  it.each([
    "http://x.example/a", "ftp=https://x.example", "https://u:p@x.example/", "https://x.example:8443/",
    "https://localhost/a", "https://svc.internal/a", "not a url",
  ])("rejects %s", (v) => {
    expect(() => parseWebhooks(v)).toThrow(OpsAlertConfigError);
  });
  it("never echoes the URL in errors", () => {
    try { parseWebhooks("slack=https://x .example/SECRETPATH"); } catch (e) {
      expect(String(e)).not.toContain("SECRETPATH");
    }
  });
  it("caps the number of webhooks", () => {
    expect(() => parseWebhooks(Array.from({ length: 9 }, (_, i) => `https://h${i}.example/`).join(","))).toThrow(/at most/);
  });
  it.each([["OPS_ALERT_INTERVAL_SEC", "abc"], ["OPS_ALERT_INTERVAL_SEC", "1"], ["OPS_ALERT_NODE_DROP_PCT", "101"], ["OPS_ALERT_MAX_PER_HOUR", "NaN"]])(
    "rejects %s=%s", (k, v) => { expect(() => loadOpsAlertConfig({ [k]: v })).toThrow(OpsAlertConfigError); });
  it("SSRF-validates webhook hosts", async () => {
    const hooks = parseWebhooks("https://ok.example/a,https://evil.example/b");
    const resolve = vi.fn(async (h: string) => h === "ok.example" ? { allowed: true } : { allowed: false, reason: "Blocked" });
    await expect(validateWebhooks(hooks, resolve)).rejects.toThrow(/entry 2 rejected/);
    await expect(validateWebhooks(hooks.slice(0, 1), resolve)).resolves.toBeUndefined();
  });
});

describe("event counters", () => {
  it("counts within the window and drops old buckets", () => {
    const t = 1_700_000_000_000;
    recordOpsEvent("v1_request", t - 20 * 60_000);
    recordOpsEvent("v1_request", t - 60_000);
    recordOpsEvent("v1_request", t);
    expect(countOpsEvents("v1_request", 10, t)).toBe(2);
  });
  it("middleware counts 5xx", () => {
    const fns: Array<() => void> = [];
    const res = { statusCode: 503, on: (_e: "finish", f: () => void) => fns.push(f) };
    const next = vi.fn();
    v1ErrorCounter({}, res, next);
    fns.forEach((f) => f());
    expect(next).toHaveBeenCalled();
    expect(countOpsEvents("v1_error", 1)).toBe(1);
    expect(countOpsEvents("v1_request", 1)).toBe(1);
  });
});

describe("rules", () => {
  it("is quiet when healthy", async () => {
    const { a, send } = setup();
    expect(await a.evaluate()).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it("fires on a stale gateway heartbeat and resolves", async () => {
    const { a, s, send } = setup({}, { age: 600 });
    const r = await a.evaluate();
    expect(r.map((x) => x.rule)).toEqual(["gateway_heartbeat_stale"]);
    expect(send).toHaveBeenCalledTimes(2);
    s.age = 5;
    await a.evaluate();
    expect(a.recentAlerts()[0]!.status).toBe("resolved");
    expect(a.firingRules()).toEqual([]);
  });
  it("ignores a missing heartbeat", async () => {
    const { a } = setup({}, { age: null });
    expect(await a.evaluate()).toEqual([]);
  });
  it("fires on live nodes below minimum", async () => {
    const { a } = setup({ minLiveNodes: 20 });
    expect((await a.evaluate()).map((x) => x.rule)).toContain("live_nodes_low");
  });
  it("fires on a node drop within 10 min only", async () => {
    const { a, s, clock } = setup({ nodeDropPct: 50 });
    await a.evaluate();
    s.nodes = 4; clock.advance(60_000);
    expect((await a.evaluate()).map((x) => x.rule)).toEqual(["live_nodes_drop"]);
    clock.advance(11 * 60_000);
    expect(await a.evaluate()).toEqual([]);
  });
  it("fires on payment webhook failures", async () => {
    const { a, clock } = setup({ paymentFailures: 2 });
    recordOpsEvent("payment_webhook_failure", clock.now());
    recordOpsEvent("payment_webhook_failure", clock.now());
    expect((await a.evaluate()).map((x) => x.rule)).toEqual(["payment_webhook_failures"]);
  });
  it("fires on a debit spike over both thresholds", async () => {
    expect((await setup({}, { recent: 9000, baseline: 100 }).a.evaluate()).map((x) => x.rule)).toEqual(["wallet_debit_spike"]);
    expect(await setup({}, { recent: 9000, baseline: 5000 }).a.evaluate()).toEqual([]);
    expect(await setup({}, { recent: 100, baseline: 0 }).a.evaluate()).toEqual([]);
  });
  it("fires on /v1 error rate with enough volume", async () => {
    const { a, clock } = setup({ v1MinRequests: 10, v1ErrorPct: 20 });
    for (let i = 0; i < 10; i++) recordOpsEvent("v1_request", clock.now());
    for (let i = 0; i < 3; i++) recordOpsEvent("v1_error", clock.now());
    expect((await a.evaluate()).map((x) => x.rule)).toEqual(["v1_error_rate"]);
  });
  it("a failing metric does not stop other rules or resolve", async () => {
    const { a, s, clock } = setup({ paymentFailures: 1 }, { age: 600 });
    await a.evaluate();
    recordOpsEvent("payment_webhook_failure", clock.now());
    (a as unknown as { metrics: OpsMetrics }).metrics.gatewayHeartbeatAgeSec = async () => { throw new Error("db"); };
    s.age = 5;
    const r = await a.evaluate();
    expect(r.map((x) => x.rule)).toEqual(["payment_webhook_failures"]);
    expect(a.firingRules()).toContain("gateway_heartbeat_stale");
  });
});

describe("dedupe and rate limit", () => {
  it("dedupes repeats within the window", async () => {
    const { a, send, clock } = setup({ dedupeSec: 600 }, { age: 600 });
    await a.evaluate();
    await a.evaluate();
    expect(send).toHaveBeenCalledTimes(2);
    clock.advance(601_000);
    await a.evaluate();
    expect(send).toHaveBeenCalledTimes(4);
  });
  it("rate limits per hour", async () => {
    const { a, send } = setup({ maxPerHour: 2 });
    await a.sendTest(); await a.sendTest();
    const third = await a.sendTest();
    expect(third.suppressed).toBe("rate_limit");
    expect(send).toHaveBeenCalledTimes(4);
  });
  it("caps the dedupe map", async () => {
    const { a } = setup({ maxPerHour: 1000 });
    a.config.webhooks = [];
    for (let i = 0; i < MAX_DEDUPE_ENTRIES + 50; i++) {
      await a.notify({ rule: `r${i}`, severity: "warning", status: "firing", summary: "x", values: {}, at: "" });
    }
    expect(a.dedupeSize()).toBe(MAX_DEDUPE_ENTRIES);
  });
  it("counts failed deliveries", async () => {
    const { a, send } = setup();
    send.mockRejectedValueOnce(new Error("down"));
    expect((await a.sendTest()).delivered).toBe(1);
  });
});

describe("payloads", () => {
  const alert = { rule: "gateway_heartbeat_stale", severity: "critical" as const, status: "firing" as const,
    summary: "No gateway heartbeat", values: { ageSec: 600 }, at: "2026-01-01T00:00:00.000Z" };
  it("formats each kind", () => {
    expect(JSON.parse(formatPayload("slack", alert, "api").body).text).toContain("CRITICAL");
    const d = JSON.parse(formatPayload("discord", alert, "api").body);
    expect(d.allowed_mentions).toEqual({ parse: [] });
    const n = formatPayload("ntfy", alert, "api");
    expect(n.headers["Priority"]).toBe("urgent");
    expect(n.body).toBe("No gateway heartbeat");
    expect(JSON.parse(formatPayload("json", alert, "api").body)).toMatchObject({ source: "dominusnode", rule: alert.rule });
  });
  it("never includes webhook URLs", async () => {
    const { a, send } = setup();
    await a.sendTest();
    for (const c of send.mock.calls as unknown as Array<[unknown, string]>) expect(c[1]).not.toContain("SECRETPATH");
  });
});

describe("admin routes", () => {
  function app() {
    const x = express();
    x.use(express.json());
    x.use("/api/admin/ops-alerts", router);
    return x;
  }
  it("503 when not running", async () => {
    expect((await call(app(), "GET", "/api/admin/ops-alerts")).status).toBe(503);
  });
  it("lists config without URLs", async () => {
    const { a } = setup({}, { age: 600 });
    await a.evaluate();
    setOpsAlerter(a);
    const r = await call(app(), "GET", "/api/admin/ops-alerts?limit=5");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("SECRETPATH");
    expect(r.body["webhooks"]).toEqual([{ kind: "slack", host: "hooks.slack.example" }, { kind: "json", host: "alerts.example" }]);
    expect(r.body["firing"]).toEqual(["gateway_heartbeat_stale"]);
  });
  it("sends a test alert and audits it", async () => {
    const { a, send } = setup();
    setOpsAlerter(a);
    m.clientQuery.mockImplementation(async (sql: string) =>
      sql.includes("SELECT admin_role") ? { rows: [{ admin_role: "admin" }] } : { rows: [] });
    expect((await call(app(), "POST", "/api/admin/ops-alerts/test", { body: {} })).status).toBe(400);
    const r = await call(app(), "POST", "/api/admin/ops-alerts/test", { body: { reason: "launch check" } });
    expect(r.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
    const sqls = m.clientQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("INSERT INTO audit_events"))).toBe(true);
  });
});

describe("pinnedLookup (DNS rebinding pin)", () => {
  it("returns only vetted addresses, honouring family and all", async () => {
    const { pinnedLookup } = await import("./ops-alerts.js");
    const lk = pinnedLookup(["93.184.216.34", "2606:2800:220:1::1"]);
    const one = await new Promise<unknown[]>((res) => lk("evil.example", {}, (...a: unknown[]) => res(a)));
    expect(one).toEqual([null, "93.184.216.34", 4]);
    const v6 = await new Promise<unknown[]>((res) => lk("evil.example", { family: 6 }, (...a: unknown[]) => res(a)));
    expect(v6).toEqual([null, "2606:2800:220:1::1", 6]);
    const all = await new Promise<unknown[]>((res) => lk("evil.example", { all: true }, (...a: unknown[]) => res(a)));
    expect((all[1] as unknown[]).length).toBe(2);
  });
  it("fails when no vetted address matches the family", async () => {
    const { pinnedLookup } = await import("./ops-alerts.js");
    const lk = pinnedLookup(["93.184.216.34"]);
    const r = await new Promise<unknown[]>((res) => lk("x.example", { family: 6 }, (...a: unknown[]) => res(a)));
    expect(r[0]).toBeInstanceOf(Error);
  });
});
