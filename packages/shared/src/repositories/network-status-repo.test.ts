import { describe, it, expect, vi } from "vitest";

vi.mock("../db.js", () => ({ query: vi.fn() }));
import { kAnonymize, availabilityBps, getGatewayLiveness, recordGatewayHeartbeat, purgeGatewayHeartbeats } from "./network-status-repo.js";
import { query } from "../db.js";
const q = vi.mocked(query);

const base = { onlineNodes: 0, seedOnline: 0, communityOnline: 0, paidBytes24h: "0", seedPaidBytes24h: "0", communityPaidBytes24h: "0", byClass: {} };

describe("kAnonymize", () => {
  it("hides the split and totals when one community node is alone", () => {
    const r = kAnonymize({ ...base, onlineNodes: 1, communityOnline: 1, paidBytes24h: "999", communityPaidBytes24h: "999", byClass: { residential: 1 } });
    expect(JSON.stringify(r)).not.toContain("999");
    expect(r.onlineNodes).toBe(0);
    expect(r.byClass).toEqual({});
  });

  it("hides everything while the community is below k, even with seeds in a crowd", () => {
    const r = kAnonymize({ ...base, onlineNodes: 6, seedOnline: 5, communityOnline: 1, paidBytes24h: "1000", seedPaidBytes24h: "900", communityPaidBytes24h: "100", communityPaidNodes24h: 1, byClass: { dc: 5, residential: 1 } });
    expect(r.onlineNodes).toBe(0);
    expect(r.paidBytes24h).toBe("0");
    expect(r.byClass).toEqual({});
  });

  it("community=0 with community paid bytes from an offline node publishes nothing", () => {
    const r = kAnonymize({ ...base, onlineNodes: 5, seedOnline: 5, communityOnline: 0, paidBytes24h: "1000", seedPaidBytes24h: "900", communityPaidBytes24h: "100", communityPaidNodes24h: 1, byClass: { dc: 5 } });
    expect(JSON.stringify(r)).not.toMatch(/"(1000|900|100)"/);
    expect(r.onlineNodes).toBe(0);
  });

  it("an hour-to-hour 0 -> 1 -> 0 sequence publishes identical rows", () => {
    const seeds = { ...base, onlineNodes: 5, seedOnline: 5, paidBytes24h: "900", seedPaidBytes24h: "900", byClass: { dc: 5 } };
    const h0 = kAnonymize(seeds);
    const h1 = kAnonymize({ ...seeds, onlineNodes: 6, communityOnline: 1, byClass: { dc: 5, residential: 1 }, paidBytes24h: "950", communityPaidBytes24h: "50", communityPaidNodes24h: 1 });
    const h2 = kAnonymize({ ...seeds, paidBytes24h: "950", communityPaidBytes24h: "50", communityPaidNodes24h: 1 });
    expect(h1).toEqual(h0);
    expect(h2).toEqual(h0);
  });

  it("hides paid figures when fewer than k community nodes earned, even with k online", () => {
    const r = kAnonymize({ ...base, onlineNodes: 8, seedOnline: 5, communityOnline: 3, paidBytes24h: "1000", seedPaidBytes24h: "900", communityPaidBytes24h: "100", communityPaidNodes24h: 1, byClass: { dc: 5, residential: 3 } });
    expect(r.onlineNodes).toBe(8);
    expect(r.communityPaidBytes24h).toBe("0");
    expect(r.paidBytes24h).toBe("0");
    expect(r.suppressed).toEqual(["paidBytes24h", "seedPaidBytes24h", "communityPaidBytes24h"]);
  });

  it("publishes everything once each group has at least 3 nodes", () => {
    const x = { ...base, onlineNodes: 7, seedOnline: 4, communityOnline: 3, paidBytes24h: "10", seedPaidBytes24h: "6", communityPaidBytes24h: "4", communityPaidNodes24h: 3, byClass: { dc: 4, residential: 3 } };
    const r = kAnonymize(x);
    const { communityPaidNodes24h: _n, ...pub } = x;
    expect(r).toMatchObject(pub);
    expect(r.suppressed).toEqual([]);
  });
});

describe("gateway liveness", () => {
  it("availabilityBps clamps and returns null without a window", () => {
    expect(availabilityBps(1439, 1440)).toBe(9993);
    expect(availabilityBps(1440, 1440)).toBe(10000);
    expect(availabilityBps(2000, 1440)).toBe(10000);
    expect(availabilityBps(0, 0)).toBeNull();
    expect(availabilityBps(Number.NaN, 10)).toBeNull();
  });

  it("records one row per instance per minute and rejects bad ids", async () => {
    q.mockReset().mockResolvedValue({ rows: [], rowCount: 1 } as never);
    await recordGatewayHeartbeat("gw:1:abcd");
    expect(String(q.mock.calls[0]![0])).toContain("date_trunc('minute', now())");
    expect(String(q.mock.calls[0]![0])).toContain("ON CONFLICT (minute, instance_id) DO NOTHING");
    await recordGatewayHeartbeat("");
    await recordGatewayHeartbeat("x".repeat(65));
    expect(q).toHaveBeenCalledTimes(1);
    expect(await purgeGatewayHeartbeats()).toBe(1);
    expect(q.mock.calls[1]![1]).toEqual([8]);
  });

  it("maps the liveness query without exposing instance ids", async () => {
    const last = new Date("2026-11-14T10:00:00Z");
    q.mockReset().mockResolvedValue({ rows: [{ online: "2", last, up24: "1439", tot24: "1440", up7: "0", tot7: "0" }] } as never);
    expect(await getGatewayLiveness()).toEqual({ instancesOnline: 2, lastHeartbeatAt: last, availability24hBps: 9993, availability7dBps: null });
    const sql = String(q.mock.calls[0]![0]);
    expect(sql).not.toMatch(/SELECT \*/);
    expect(sql).toContain("COUNT(DISTINCT instance_id)");
    expect(sql).toContain("COALESCE(e.first, e.e)");
    q.mockResolvedValue({ rows: [] } as never);
    expect(await getGatewayLiveness()).toEqual({ instancesOnline: 0, lastHeartbeatAt: null, availability24hBps: null, availability7dBps: null });
  });
});
