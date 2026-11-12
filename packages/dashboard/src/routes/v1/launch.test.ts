import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({ grant: vi.fn(), listSnapshots: vi.fn(), listIncidents: vi.fn(), listWanted: vi.fn(), query: vi.fn(), consume: vi.fn(), create: vi.fn(), count: vi.fn() }));
vi.mock("@dominusnode/shared", async (orig) => {
  const actual = await orig<typeof import("@dominusnode/shared")>();
  return {
    ...actual,
    query: (...a: unknown[]) => m.query(...a),
    powChallengeRepo: { ...actual.powChallengeRepo, consumeChallenge: m.consume, createChallenge: m.create, countActiveChallengesForIp: m.count },
    starterCreditRepo: { ...actual.starterCreditRepo, grantStarterCredit: m.grant },
    networkStatusRepo: { ...actual.networkStatusRepo, listSnapshots: m.listSnapshots, listIncidents: m.listIncidents, listWanted: m.listWanted },
  };
});

vi.mock("../../middleware/agent.js", () => ({
  requireAgentPrincipal: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const w = req.headers["x-test-wallet"];
    if (req.headers["x-test-agent"] === undefined) { res.status(401).json({ error: "Authentication required" }); return; }
    (req as unknown as { agent: unknown }).agent = { userId: String(req.headers["x-test-agent"]), email: "", walletAddress: typeof w === "string" ? w : null, via: "api_key", verified: true };
    next();
  },
}));

import router, { parseAbuseReport, ABUSE_POW_DIFFICULTY } from "./launch.js";
import * as nodeCrypto from "node:crypto";
import { countLeadingZeroBits } from "@dominusnode/shared";
import { renderStatusPage, escapeHtml } from "../status-page.js";
import { call } from "./test-helpers.js";

function app() {
  const a = express();
  a.use(express.json({ limit: "16kb" }));
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

describe("/v1/announcements", () => {
  it("lists published announcements with public caching and validates filters", async () => {
    m.query.mockReset().mockResolvedValue({ rows: [{ id: "a1", title: "Price change", body: "dc to $0.25/GB", category: "pricing", url: null, published_at: new Date("2026-11-01T00:00:00Z"), updated_at: new Date("2026-11-01T00:00:00Z") }] });
    const r = await call(app(), "GET", "/v1/announcements?category=pricing&since=2026-10-01T00:00:00Z&limit=5");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=300");
    expect((r.body["announcements"] as unknown[])[0]).toMatchObject({ id: "a1", category: "pricing", publishedAt: "2026-11-01T00:00:00.000Z" });
    const [sql, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("WHERE published AND published_at <= now()");
    expect(params).toEqual([5, "pricing", "2026-10-01T00:00:00.000Z"]);
    expect((await call(app(), "GET", "/v1/announcements?category=gossip")).status).toBe(400);
    expect((await call(app(), "GET", "/v1/announcements?since=yesterday")).status).toBe(400);
    expect((await call(app(), "GET", "/v1/announcements?limit=500")).status).toBe(400);
  });

  it("fails closed with 503 without leaking the error", async () => {
    m.query.mockReset().mockRejectedValue(new Error("db down"));
    const r = await call(app(), "GET", "/v1/announcements");
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("db down");
  });
});

describe("POST /v1/starter-credits/claim", () => {
  const W = "0x2222222222222222222222222222222222222222";
  it("needs an agent with a wallet identity", async () => {
    m.grant.mockReset();
    expect((await call(app(), "POST", "/v1/starter-credits/claim")).status).toBe(401);
    const r = await call(app(), "POST", "/v1/starter-credits/claim", { headers: { "x-test-agent": "u-nowallet" } });
    expect(r.status).toBe(403);
    expect(m.grant).not.toHaveBeenCalled();
  });

  it("grants (201), refuses unfunded (403) and repeats (409)", async () => {
    m.grant.mockReset()
      .mockResolvedValueOnce({ granted: true, grantId: "g", amountMusd: 500000n, expiresAt: new Date("2026-12-12T00:00:00Z") })
      .mockResolvedValueOnce({ granted: false, reason: "unfunded" })
      .mockResolvedValueOnce({ granted: false, reason: "already_granted" });
    const h = (u: string) => ({ headers: { "x-test-agent": u, "x-test-wallet": W } });
    const ok = await call(app(), "POST", "/v1/starter-credits/claim", h("u1"));
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ granted: true, amount: { musd: "500000" } });
    expect(m.grant).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", fundingSource: W }));
    expect((await call(app(), "POST", "/v1/starter-credits/claim", h("u2"))).body).toEqual({ granted: false, reason: "unfunded" });
    expect((await call(app(), "POST", "/v1/starter-credits/claim", h("u3"))).status).toBe(409);
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

function solve(prefix: string, difficulty: number): string {
  for (let i = 0; ; i++) {
    const h = nodeCrypto.createHash("sha256").update(prefix + i).digest();
    if (countLeadingZeroBits(h) >= difficulty) return String(i);
  }
}

describe("public abuse-report intake", () => {
  const now = Date.now();
  const good = {
    destHost: "victim.example.com", windowStart: new Date(now - 3_600_000).toISOString(), windowEnd: new Date(now).toISOString(),
    category: "credential_stuffing", description: "Login attempts from your exit IPs at 10:00 UTC",
  };

  beforeEach(() => { m.query.mockReset(); m.consume.mockReset(); m.create.mockReset(); m.count.mockReset(); });

  it("validates host, window, category, description and unknown fields", () => {
    expect(parseAbuseReport({ ...good }, now)).toMatchObject({ destHost: "victim.example.com", category: "credential_stuffing" });
    expect(parseAbuseReport({ ...good, destHost: "https://x.com/a" }, now)).toMatch(/bare hostname/);
    expect(parseAbuseReport({ ...good, destHost: "10.0.0.1" }, now)).toMatch(/bare hostname/);
    expect(parseAbuseReport({ ...good, windowEnd: new Date(now - 7_200_000).toISOString() }, now)).toMatch(/before/);
    expect(parseAbuseReport({ ...good, windowStart: new Date(now - 40 * 86_400_000).toISOString() }, now)).toMatch(/31 days/);
    expect(parseAbuseReport({ ...good, category: "x" }, now)).toMatch(/category/);
    expect(parseAbuseReport({ ...good, description: "short" }, now)).toMatch(/description/);
    expect(parseAbuseReport({ ...good, description: "x".repeat(4001) }, now)).toMatch(/description/);
    expect(parseAbuseReport({ ...good, requesterIp: "1.2.3.4" }, now)).toMatch(/unknown field/);
  });

  it("requires a PoW, consumes it before verifying, then stores only host/window/description", async () => {
    expect((await call(app(), "POST", "/v1/abuse-reports", { body: good })).body["code"]).toBe("POW_REQUIRED");
    const prefix = "ab".repeat(16);
    const nonce = solve(prefix, ABUSE_POW_DIFFICULTY);
    m.consume.mockResolvedValue({ id: "11111111-1111-4111-8111-111111111111", prefix, difficulty: ABUSE_POW_DIFFICULTY, ip_address: "127.0.0.1", created_at: new Date(), consumed: true });
    m.query.mockResolvedValue({ rows: [{ id: "r1", created_at: new Date() }] });
    const r = await call(app(), "POST", "/v1/abuse-reports", { body: { ...good, pow: { challengeId: "11111111-1111-4111-8111-111111111111", nonce } } });
    expect(r.status).toBe(201);
    const [sql, params] = m.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("INSERT INTO abuse_reports");
    expect(sql).not.toMatch(/ip_address|client_ip|RETURNING \*/i);
    expect(params[0]).toBe("victim.example.com");
  });

  it("rejects a wrong PoW nonce and an oversized body", async () => {
    m.consume.mockResolvedValue({ id: "x", prefix: "ff".repeat(16), difficulty: 32, ip_address: "127.0.0.1", created_at: new Date(), consumed: true });
    const r = await call(app(), "POST", "/v1/abuse-reports", { body: { ...good, pow: { challengeId: "11111111-1111-4111-8111-111111111111", nonce: "1" } } });
    expect(r.body["code"]).toBe("POW_INVALID");
    expect(m.query).not.toHaveBeenCalled();
    const big = await call(app(), "POST", "/v1/abuse-reports", { body: { ...good, description: "x".repeat(20_000) } });
    expect(big.status).toBe(413);
  });

  it("issues a PoW challenge", async () => {
    m.count.mockResolvedValue(0);
    m.create.mockResolvedValue({ id: "c1", prefix: "ab".repeat(16), difficulty: ABUSE_POW_DIFFICULTY, ip_address: "127.0.0.1", created_at: new Date(), consumed: false });
    const r = await call(app(), "POST", "/v1/abuse-reports/challenge");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ challengeId: "c1", algorithm: "sha256", difficulty: ABUSE_POW_DIFFICULTY });
  });
});
