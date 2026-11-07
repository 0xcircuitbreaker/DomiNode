import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({ listSnapshots: vi.fn(), listIncidents: vi.fn(), listWanted: vi.fn() }));
vi.mock("@dominusnode/shared", async (orig) => {
  const actual = await orig<typeof import("@dominusnode/shared")>();
  return { ...actual, networkStatusRepo: { ...actual.networkStatusRepo, listSnapshots: m.listSnapshots, listIncidents: m.listIncidents, listWanted: m.listWanted } };
});

import router from "./launch.js";
import { renderStatusPage, escapeHtml } from "../status-page.js";
import { call } from "./test-helpers.js";

function app() {
  const a = express();
  a.use("/v1", router);
  return a;
}

const SNAP = {
  hour: new Date("2026-11-07T10:00:00Z"), onlineNodes: 12, seedOnline: 8, communityOnline: 4, countries: 5, asns: 7,
  successRateBps: 9876, p50Ms: 120, p95Ms: 640, paidBytes24h: "3500000000", seedPaidBytes24h: "3000000000",
  communityPaidBytes24h: "500000000", byClass: { dc: 8, residential: 4 },
};

beforeEach(() => {
  m.listSnapshots.mockReset(); m.listIncidents.mockReset(); m.listWanted.mockReset();
});

describe("/v1 network history, incidents, wanted", () => {
  it("history returns aggregate snapshots and validates hours", async () => {
    m.listSnapshots.mockResolvedValue([SNAP]);
    const r = await call(app(), "GET", "/v1/network/history?hours=24");
    expect(r.status).toBe(200);
    expect((r.body["snapshots"] as unknown[])[0]).toMatchObject({ onlineNodes: 12, seedOnline: 8, communityOnline: 4, p95Ms: 640 });
    expect(m.listSnapshots).toHaveBeenCalledWith(24);
    expect(JSON.stringify(r.body)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    expect((await call(app(), "GET", "/v1/network/history?hours=0")).status).toBe(400);
    expect((await call(app(), "GET", "/v1/network/history?hours=abc")).status).toBe(400);
  });

  it("wanted publishes only aggregated groups above the minimum, no requester data", async () => {
    m.listWanted.mockResolvedValue([{ country: "BR", ipClass: "residential", requests: 40 }]);
    const r = await call(app(), "GET", "/v1/network/wanted?days=7");
    expect(r.status).toBe(200);
    expect(r.body["wanted"]).toEqual([{ country: "BR", ipClass: "residential", requests: 40 }]);
    expect(m.listWanted).toHaveBeenCalledWith(7, 5, 100);
    expect((await call(app(), "GET", "/v1/network/wanted?days=31")).status).toBe(400);
  });

  it("incidents and history fail closed with 503", async () => {
    m.listIncidents.mockRejectedValue(new Error("db down"));
    const r = await call(app(), "GET", "/v1/network/incidents");
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("db down");
  });
});

describe("status page", () => {
  it("renders aggregates, seed vs community, incidents, with HTML escaped and no scripts", () => {
    const html = renderStatusPage([SNAP], [
      { id: "i1", title: "<script>alert(1)</script>", body: "gateway restart", severity: "major", status: "monitoring", startedAt: new Date(), resolvedAt: null, updatedAt: new Date() },
    ], { version: 3, sha256: "a".repeat(64) }, new Date("2026-11-07T11:00:00Z"));
    expect(html).toContain("Network status: Degraded");
    expect(html).toContain("8 / 4");
    expect(html).toContain("98.76%");
    expect(html).toContain("120 ms / 640 ms");
    expect(html).toContain("3.50 (3.00 / 0.50)");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a".repeat(64));
  });

  it("is operational with no open major incident and handles no data", () => {
    expect(renderStatusPage([SNAP], [], null, new Date("2026-11-07T11:00:00Z"))).toContain("Network status: Operational");
    expect(renderStatusPage([], [], null)).toContain("No snapshot has been taken yet.");
    expect(escapeHtml(`"'&`)).toBe("&quot;&#39;&amp;");
  });
});
