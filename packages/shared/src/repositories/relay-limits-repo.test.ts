import { describe, it, expect, vi, beforeEach } from "vitest";
import { routedClient, type Route } from "./relay-net-test-helpers.js";

const mockConnect = vi.fn();
const mockQuery = vi.fn();
vi.mock("../db.js", () => ({ query: (...a: unknown[]) => mockQuery(...a), getPool: () => ({ connect: () => mockConnect() }) }));
import { claimNodeSlot, releaseNodeSlot, reserveRequester, settleRequester, heartbeat } from "./relay-limits-repo.js";

function setup(routes: Route[]) { const r = routedClient(routes); mockConnect.mockResolvedValue(r.client); return r; }
const N = "11111111-1111-4111-8111-111111111111";
const claim = (asn: number | null = 64500, enforceAsn = true) => ({
  nodeId: N, instanceId: "gw-1", ip: "1.2.3.4", prefix24: "1.2.3", asn, enforceAsn, limits: { per32: 1, per24: 4, perAsn: 8 },
});

describe("relay-limits-repo", () => {
  beforeEach(() => { vi.clearAllMocks(); mockQuery.mockResolvedValue({ rows: [] }); });

  it("claims a slot under a global advisory lock after sweeping expired rows", async () => {
    const r = setup([[/count\(\*\)/, () => ({ rows: [{ per32: "0", per24: "3", per_asn: "7" }] })]]);
    expect(await claimNodeSlot(claim())).toBe(true);
    const s = r.sqls();
    const iLock = s.findIndex((x) => x.includes("pg_advisory_xact_lock"));
    const iDel = s.findIndex((x) => x.startsWith("DELETE FROM node_ip_slots"));
    const iCount = s.findIndex((x) => x.includes("count(*)"));
    const iIns = s.findIndex((x) => x.includes("INSERT INTO node_ip_slots"));
    expect(iLock).toBeGreaterThan(s.indexOf("BEGIN"));
    expect(iLock).toBeLessThan(iDel);
    expect(iDel).toBeLessThan(iCount);
    expect(iCount).toBeLessThan(iIns);
    expect(s.at(-1)).toBe("COMMIT");
  });

  it("refuses at the /32, /24 or ASN cap without inserting", async () => {
    for (const row of [{ per32: "1", per24: "0", per_asn: "0" }, { per32: "0", per24: "4", per_asn: "0" }, { per32: "0", per24: "0", per_asn: "8" }]) {
      const r = setup([[/count\(\*\)/, () => ({ rows: [row] })]]);
      expect(await claimNodeSlot(claim())).toBe(false);
      expect(r.sqls().some((x) => x.includes("INSERT INTO node_ip_slots"))).toBe(false);
    }
  });

  it("skips the ASN cap when not enforced", async () => {
    setup([[/count\(\*\)/, () => ({ rows: [{ per32: "0", per24: "0", per_asn: "99" }] })]]);
    expect(await claimNodeSlot(claim(null, false))).toBe(true);
  });

  it("rejects malformed instance ids", async () => {
    await expect(claimNodeSlot({ ...claim(), instanceId: "bad id;" })).rejects.toThrow(/instance/);
    await expect(releaseNodeSlot(N, "")).rejects.toThrow(/instance/);
  });

  it("releases only this instance's slot", async () => {
    await releaseNodeSlot(N, "gw-1");
    expect(mockQuery.mock.calls[0][0]).toMatch(/node_id = \$1 AND instance_id = \$2/);
    expect(mockQuery.mock.calls[0][1]).toEqual([N, "gw-1"]);
  });

  it("reserve: rate refusal when the window row is at the limit", async () => {
    const r = setup([[/requester_rate_window/, () => ({ rows: [] })]]);
    expect(await reserveRequester({ userId: N, instanceId: "gw-1", musd: 5n, dailyCapMusd: 100n, reqPerSec: 2 })).toBe("rate");
    expect(r.sqls().some((x) => x.includes("requester_spend_inflight"))).toBe(false);
  });

  it("reserve: counts settled + live in-flight under a row lock against the cap", async () => {
    const routes: Route[] = [
      [/requester_rate_window/, () => ({ rows: [{ count: 1 }] })],
      [/SELECT settled_musd .* FOR UPDATE/s, () => ({ rows: [{ settled_musd: "60" }] })],
      [/SUM\(inflight_musd\)/, () => ({ rows: [{ inflight: "40" }] })],
    ];
    let r = setup(routes);
    expect(await reserveRequester({ userId: N, instanceId: "gw-1", musd: 5n, dailyCapMusd: 100n, reqPerSec: 10 })).toBe("spend");
    expect(r.sqls().some((x) => x.includes("INSERT INTO requester_spend_inflight"))).toBe(false);
    r = setup(routes);
    expect(await reserveRequester({ userId: N, instanceId: "gw-1", musd: 5n, dailyCapMusd: 101n, reqPerSec: 10 })).toBe("ok");
    const ins = r.calls.find((c) => c.sql.includes("INSERT INTO requester_spend_inflight"))!;
    expect(ins.params.slice(0, 3)).toEqual([N, "gw-1", "5"]);
  });

  it("settle releases the hold and adds settled spend in one tx", async () => {
    const r = setup([]);
    await settleRequester(N, "gw-1", 50n, 30n);
    const s = r.sqls();
    expect(s[0]).toBe("BEGIN");
    expect(s.some((x) => x.includes("inflight_musd = GREATEST(inflight_musd - $3, 0)"))).toBe(true);
    expect(s.some((x) => x.includes("INSERT INTO requester_spend_daily"))).toBe(true);
    expect(s.at(-1)).toBe("COMMIT");
    await expect(settleRequester(N, "gw-1", -1n, 0n)).rejects.toThrow(/range/);
  });

  it("heartbeat refreshes own rows and sweeps expired ones", async () => {
    await heartbeat("gw-1");
    const s = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(s.some((x) => x.includes("UPDATE node_ip_slots SET heartbeat_at"))).toBe(true);
    expect(s.some((x) => x.includes("UPDATE requester_spend_inflight SET heartbeat_at"))).toBe(true);
    expect(s.some((x) => x.startsWith("DELETE FROM node_ip_slots WHERE heartbeat_at"))).toBe(true);
  });
});
