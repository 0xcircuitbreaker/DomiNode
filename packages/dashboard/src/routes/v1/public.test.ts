import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const { getActivePolicy, listPricing, listTiers, getSplit, query, getGatewayLiveness, listIncidents } = vi.hoisted(() => ({
  getActivePolicy: vi.fn(), listPricing: vi.fn(), listTiers: vi.fn(), getSplit: vi.fn(), query: vi.fn(),
  getGatewayLiveness: vi.fn(), listIncidents: vi.fn(),
}));

vi.mock("@dominusnode/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dominusnode/shared")>();
  return {
    ...actual,
    query: (...a: unknown[]) => query(...a),
    policyRepo: { getActivePolicy, listPricing, listTiers, getSplit },
    networkStatusRepo: { ...actual.networkStatusRepo, getGatewayLiveness, listIncidents },
  };
});

import router, { invalidatePublicCaches, overallStatus } from "./public.js";
import { call } from "./test-helpers.js";
import { DEFAULT_POLICY } from "@dominusnode/shared";

function app() {
  const a = express();
  a.use(express.json());
  a.use("/v1", router);
  return a;
}

const SHA = "f".repeat(64);

describe("/v1 public routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActivePolicy.mockReset();
    query.mockReset();
    invalidatePublicCaches();
  });

  it("GET /v1/policy returns version, sha256, body, floorGuarantees with ETag", async () => {
    getActivePolicy.mockResolvedValue({ version: 7, sha256: SHA, body: DEFAULT_POLICY, createdAt: new Date() });
    const r = await call(app(), "GET", "/v1/policy");
    expect(r.status).toBe(200);
    expect(r.body["version"]).toBe(7);
    expect(r.body["sha256"]).toBe(SHA);
    expect(Array.isArray(r.body["floorGuarantees"])).toBe(true);
    expect(r.headers.get("etag")).toBe(`"${SHA}"`);
    expect(r.headers.get("cache-control")).toContain("max-age=30");
  });

  it("GET /v1/policy honours If-None-Match and caches", async () => {
    getActivePolicy.mockResolvedValue({ version: 7, sha256: SHA, body: DEFAULT_POLICY, createdAt: null });
    const a = app();
    await call(a, "GET", "/v1/policy");
    const r = await call(a, "GET", "/v1/policy", { headers: { "if-none-match": `"${SHA}"` } });
    expect(r.status).toBe(304);
    expect(getActivePolicy).toHaveBeenCalledTimes(1);
  });

  it("GET /v1/policy fails closed with 503", async () => {
    getActivePolicy.mockRejectedValue(new Error("db down"));
    const r = await call(app(), "GET", "/v1/policy");
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("db down");
  });

  it("GET /v1/pricing serialises µUSD as strings", async () => {
    listPricing.mockResolvedValue([{ ipClass: "residential", pricePerGbMusd: 500000n, updatedAt: new Date() }]);
    listTiers.mockResolvedValue([{ name: "probation", rank: 0, nodeShareBps: 2500 }]);
    getSplit.mockResolvedValue({ id: 1, nodeShareBps: 2500, maturationHours: 168, effectiveFrom: new Date() });
    const r = await call(app(), "GET", "/v1/pricing");
    expect(r.status).toBe(200);
    expect(r.body["prices"]).toEqual([{ ipClass: "residential", pricePerGbMusd: "500000" }]);
    expect(r.body["nodeShare"]).toEqual([{ tier: "probation", rank: 0, nodeShareBps: 2500 }]);
    expect(r.body["maturationHours"]).toBe(168);
    expect(r.body["buyerDiscounts"]).toEqual([{ tier: "probation", rank: 0, buyerDiscountBps: 0 }]);
  });

  it("GET /v1/network/stats aggregates and folds small/sanctioned groups", async () => {
    query.mockResolvedValue({
      rows: [
        { country: "US", ip_class: "residential", n: "5" },
        { country: "US", ip_class: "dc", n: "2" },
        { country: "DE", ip_class: "residential", n: "1" },
        { country: "IR", ip_class: "residential", n: "4" },
        { country: null, ip_class: null, n: "1" },
      ],
    });
    const r = await call(app(), "GET", "/v1/network/stats");
    expect(r.status).toBe(200);
    expect(r.body["onlineNodes"]).toBe(13);
    expect(r.body["byCountry"]).toEqual([{ country: "US", online: 7 }]);
    expect(r.body["otherCountries"]).toBe(6);
    // US and DE are available; IR is sanctioned and never counted.
    expect(r.body["countriesAvailable"]).toBe(2);
    // Classes with fewer than 3 nodes fold into "other" (k-anonymity).
    expect(r.body["byClass"]).toEqual({ residential: 10, other: 3 });
    const sql = String(query.mock.calls[0][0]);
    expect(sql).not.toMatch(/observed_ip|node_key_hash|\bid\b/);
    expect(JSON.stringify(r.body)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });

  it("GET /v1/network/stats never singles out one community node (k-anonymity)", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ country: "US", ip_class: "residential", operator_run: false, n: "1" }] })
      .mockResolvedValueOnce({ rows: [{ operator_run: false, bytes: "123456789" }] });
    const r = await call(app(), "GET", "/v1/network/stats");
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("123456789");
    expect(r.body["community"]).toEqual({ online: 0, paidBytes24h: "0" });
    expect(r.body["onlineNodes"]).toBe(0);
    expect(r.body["byClass"]).toEqual({});
    expect(r.body["suppressed"]).toEqual(expect.arrayContaining(["communityOnline", "communityPaidBytes24h", "onlineNodes"]));
  });

  it("GET /v1/network/stats reports operator-run seed nodes separately from community nodes", async () => {
    query
      .mockResolvedValueOnce({ rows: [
        { country: "US", ip_class: "dc", operator_run: true, n: "4" },
        { country: "US", ip_class: "residential", operator_run: false, n: "3" },
      ] })
      .mockResolvedValueOnce({ rows: [{ operator_run: true, bytes: "5000" }, { operator_run: false, bytes: "700", nodes: "3" }] });
    const r = await call(app(), "GET", "/v1/network/stats");
    expect(r.status).toBe(200);
    expect(r.body["seed"]).toEqual({ online: 4, paidBytes24h: "5000" });
    expect(r.body["community"]).toEqual({ online: 3, paidBytes24h: "700" });
  });

  describe("GET /v1/status", () => {
    const nodesSql = (sql: string) => sql.includes("FROM nodes\n") || sql.includes("GROUP BY country, ip_class, operator_run");
    beforeEach(() => {
      getActivePolicy.mockResolvedValue({ version: 4, sha256: SHA, body: DEFAULT_POLICY, createdAt: null });
      getGatewayLiveness.mockResolvedValue({ instancesOnline: 2, lastHeartbeatAt: new Date("2026-11-14T10:00:00Z"), availability24hBps: 9993, availability7dBps: 10000 });
      listIncidents.mockResolvedValue([{ id: "11111111-1111-4111-8111-111111111111", title: "Slow tunnels", body: "", severity: "minor", status: "monitoring", startedAt: new Date("2026-11-14T09:00:00Z"), resolvedAt: null, updatedAt: new Date("2026-11-14T09:30:00Z") }]);
      query.mockImplementation(async (sql: string) => nodesSql(sql)
        ? { rows: [
            { country: "US", ip_class: "residential", operator_run: false, n: "4" },
            { country: "DE", ip_class: "dc", operator_run: true, n: "3" },
            { country: "FR", ip_class: "dc", operator_run: false, n: "1" },
          ] }
        : { rows: [] });
    });

    it("returns health, availability, k-anonymous node counts and incidents without ids, with cache headers", async () => {
      const r = await call(app(), "GET", "/v1/status");
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toContain("public, max-age=30");
      expect(r.body).toMatchObject({
        status: "operational",
        coordinator: { status: "operational", policyVersion: 4 },
        gateway: { status: "operational", instancesOnline: 2, lastHeartbeatAt: "2026-11-14T10:00:00.000Z" },
        availability: { last24h: 99.93, last7d: 100 },
      });
      const nodes = r.body["nodes"] as Record<string, unknown>;
      expect(nodes["onlineNodes"]).toBe(8);
      expect(nodes["byCountry"]).toEqual([{ country: "US", online: 4 }, { country: "DE", online: 3 }]);
      expect(nodes["otherCountries"]).toBe(1);
      const text = JSON.stringify(r.body);
      expect(text).not.toContain("11111111-1111");
      expect(text).not.toMatch(/node_?id|instance_?id|"ip"/i);
      expect((r.body["incidents"] as unknown[])[0]).toEqual({ title: "Slow tunnels", body: "", severity: "minor", status: "monitoring", startedAt: "2026-11-14T09:00:00.000Z", resolvedAt: null, updatedAt: "2026-11-14T09:30:00.000Z" });
    });

    it("caches the summary and reports a down gateway when heartbeats stopped", async () => {
      getGatewayLiveness.mockResolvedValue({ instancesOnline: 0, lastHeartbeatAt: new Date("2026-11-14T08:00:00Z"), availability24hBps: 5000, availability7dBps: null });
      const a = app();
      const r = await call(a, "GET", "/v1/status");
      expect(r.body).toMatchObject({ status: "down", gateway: { status: "down", instancesOnline: 0 }, availability: { last24h: 50, last7d: null } });
      await call(a, "GET", "/v1/status");
      expect(getGatewayLiveness).toHaveBeenCalledTimes(1);
    });

    it("marks the coordinator down when the database is unreachable but still answers", async () => {
      getActivePolicy.mockRejectedValue(new Error("db down"));
      getGatewayLiveness.mockRejectedValue(new Error("db down"));
      listIncidents.mockRejectedValue(new Error("db down"));
      query.mockRejectedValue(new Error("db down"));
      const r = await call(app(), "GET", "/v1/status");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "down", coordinator: { status: "down", policyVersion: null }, gateway: { status: "unknown" }, nodes: null, incidents: [] });
      expect(JSON.stringify(r.body)).not.toContain("db down");
    });

    it("overallStatus: open major/critical incidents degrade; unknown gateway stays unknown", () => {
      const ok = { coordinator: { status: "operational" as const, policyVersion: 1 }, gateway: { status: "operational" as const, instancesOnline: 1, lastHeartbeatAt: null } };
      const inc = (severity: string, status: string) => ({ title: "t", body: "", severity, status, startedAt: "", resolvedAt: null, updatedAt: "" });
      expect(overallStatus({ ...ok, incidents: [inc("major", "investigating")] })).toBe("degraded");
      expect(overallStatus({ ...ok, incidents: [inc("critical", "resolved"), inc("minor", "investigating")] })).toBe("operational");
      expect(overallStatus({ ...ok, gateway: { ...ok.gateway, status: "unknown" }, incidents: [] })).toBe("unknown");
    });
  });
});
