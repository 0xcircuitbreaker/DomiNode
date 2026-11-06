import { describe, it, expect, vi, beforeEach } from "vitest";
const m = vi.hoisted(() => ({ query: vi.fn(), clientQuery: vi.fn(), release: vi.fn() }));
vi.mock("../db.js", () => ({
  query: (...a: unknown[]) => m.query(...a),
  getPool: () => ({ connect: async () => ({ query: m.clientQuery, release: m.release }) }),
}));
import {
  evaluateNode, evaluateCircular, listNodeConcentration, listCircularPairs, recordFinding, getSettings,
  DEFAULT_COLLUSION_SETTINGS as S, type NodeConcentration, type CollusionFinding,
} from "./collusion-repo.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const NODE = "33333333-3333-4333-8333-333333333333";
const USD = 1_000_000n;

const conc = (o: Partial<NodeConcentration> = {}): NodeConcentration => ({
  nodeId: NODE, ownerUserId: OWNER, totalMusd: 100n * USD, requesters: 10, topRequesterUserId: REQ,
  topMusd: 10n * USD, topKMusd: 25n * USD, ...o,
});

beforeEach(() => { m.query.mockReset(); m.clientQuery.mockReset(); m.release.mockReset(); });

describe("evaluateNode", () => {
  it("ignores spread-out traffic and low-volume nodes", () => {
    expect(evaluateNode(conc(), S)).toBeNull();
    expect(evaluateNode(conc({ totalMusd: USD, topMusd: USD }), S)).toBeNull(); // below $5 minimum
    expect(evaluateNode(conc({ totalMusd: 0n, topMusd: 0n, topRequesterUserId: null, requesters: 0 }), S)).toBeNull();
  });

  it("flags single-requester concentration at or above the threshold", () => {
    const f = evaluateNode(conc({ topMusd: 80n * USD }), S)!;
    expect(f).toMatchObject({ kind: "concentration", ownerUserId: OWNER, nodeId: NODE, requesterUserId: REQ, shareBps: 8000, freeze: false });
    expect(evaluateNode(conc({ topMusd: 79n * USD }), S)).toBeNull();
  });

  it("flags a small cluster that carries nearly all traffic", () => {
    const f = evaluateNode(conc({ requesters: 3, topMusd: 40n * USD, topKMusd: 96n * USD }), S)!;
    expect(f).toMatchObject({ kind: "cluster", shareBps: 9600 });
    expect(evaluateNode(conc({ requesters: 4, topMusd: 40n * USD, topKMusd: 96n * USD }), S)).toBeNull();
  });

  it("marks freeze only when auto_freeze is on and both share and volume cross the freeze bar", () => {
    const hot = conc({ totalMusd: 100n * USD, topMusd: 99n * USD });
    expect(evaluateNode(hot, S)!.freeze).toBe(false); // default off
    const on = { ...S, autoFreeze: true };
    expect(evaluateNode(hot, on)!.freeze).toBe(true);
    expect(evaluateNode(conc({ totalMusd: 10n * USD, topMusd: 99n * USD / 10n }), on)!.freeze).toBe(false); // < $50 volume
    expect(evaluateNode(conc({ topMusd: 90n * USD }), on)!.freeze).toBe(false); // < 95%
  });
});

describe("evaluateCircular", () => {
  it("flags both owners when each buys enough from the other", () => {
    const fs = evaluateCircular({ a: OWNER, b: REQ, aToBMusd: 10n * USD, bToAMusd: 10n * USD }, S);
    expect(fs).toHaveLength(2);
    expect(fs.map((f) => [f.ownerUserId, f.requesterUserId])).toEqual([[REQ, OWNER], [OWNER, REQ]]);
    expect(fs[0].shareBps).toBe(10_000);
    expect(fs.every((f) => !f.freeze)).toBe(true);
  });
  it("ignores one-sided or tiny flows", () => {
    expect(evaluateCircular({ a: OWNER, b: REQ, aToBMusd: 10n * USD, bToAMusd: USD / 2n }, S)).toEqual([]);
  });
  it("freezes balanced, large round-tripping when enabled", () => {
    const on = { ...S, autoFreeze: true };
    expect(evaluateCircular({ a: OWNER, b: REQ, aToBMusd: 60n * USD, bToAMusd: 60n * USD }, on).every((f) => f.freeze)).toBe(true);
    expect(evaluateCircular({ a: OWNER, b: REQ, aToBMusd: 600n * USD, bToAMusd: 60n * USD }, on).some((f) => f.freeze)).toBe(false);
  });
});

describe("SQL", () => {
  it("node concentration: excludes self-traffic and disputes, caps page at 1000", async () => {
    m.query.mockResolvedValue({ rows: [{ node_id: NODE, owner_user_id: OWNER, total_musd: "5", requesters: "1", top_requester: REQ, top_musd: "5", topk_musd: "5" },
      { node_id: REQ, owner_user_id: OWNER, total_musd: null, requesters: null, top_requester: null, top_musd: null, topk_musd: null }] });
    const rows = await listNodeConcentration(null, 5000, 30, 3);
    const [sql, params] = m.query.mock.calls[0];
    expect(sql).toMatch(/requester_user_id IS DISTINCT FROM p\.owner_user_id/);
    expect(sql).toMatch(/NOT rc\.disputed/);
    expect(sql).not.toMatch(/SELECT \*/);
    expect(params).toEqual([null, 1000, 30, 3]);
    expect(rows[0]).toMatchObject({ totalMusd: 5n, requesters: 1, topRequesterUserId: REQ });
    expect(rows[1]).toMatchObject({ totalMusd: 0n, topRequesterUserId: null });
  });

  it("circular pairs: keyset cursor and min volume as string", async () => {
    m.query.mockResolvedValue({ rows: [{ a: OWNER, b: REQ, a_to_b: "7", b_to_a: "9" }] });
    const r = await listCircularPairs({ a: OWNER, b: NODE }, 10, 30, 1_000_000n);
    expect(m.query.mock.calls[0][1]).toEqual([OWNER, NODE, 30, "1000000", 10]);
    expect(r).toEqual([{ a: OWNER, b: REQ, aToBMusd: 7n, bToAMusd: 9n }]);
  });

  it("getSettings falls back to defaults with auto_freeze off", async () => {
    m.query.mockResolvedValue({ rows: [] });
    expect(await getSettings()).toMatchObject({ autoFreeze: false, concentrationBps: 8000 });
  });
});

describe("recordFinding", () => {
  const finding = (o: Partial<CollusionFinding> = {}): CollusionFinding => ({
    kind: "concentration", ownerUserId: OWNER, nodeId: NODE, requesterUserId: REQ, shareBps: 9900,
    volumeMusd: 99n * USD, totalMusd: 100n * USD, freeze: false, ...o,
  });
  function client(over: (sql: string) => { rows: unknown[] } | undefined = () => undefined) {
    m.clientQuery.mockImplementation(async (sql: string) => over(sql) ?? { rows: [] });
  }
  const sqls = () => m.clientQuery.mock.calls.map((c) => String(c[0]));

  it("upserts an open flag under an advisory lock without freezing by default", async () => {
    client((s) => (s.includes("INSERT INTO collusion_flags") ? { rows: [{ id: "1", auto_frozen: false }] } : undefined));
    expect(await recordFinding(finding(), 30)).toEqual({ flagged: true, frozen: false });
    expect(sqls().some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(sqls().some((s) => s.includes("node_credit_accounts SET frozen"))).toBe(false);
    expect(sqls().at(-1)).toBe("COMMIT");
    expect(m.release).toHaveBeenCalled();
  });

  it("skips a recently dismissed flag", async () => {
    client((s) => (s.includes("status = 'dismissed'") ? { rows: [{ "?column?": 1 }] } : undefined));
    expect(await recordFinding(finding(), 30)).toEqual({ flagged: false, frozen: false });
    expect(sqls().some((s) => s.includes("INSERT INTO collusion_flags"))).toBe(false);
  });

  it("freezes once in the same transaction and audits it", async () => {
    client((s) => {
      if (s.includes("INSERT INTO collusion_flags")) return { rows: [{ id: "1", auto_frozen: false }] };
      if (s.includes("UPDATE node_payouts")) return { rows: [{ id: "p1" }] };
      if (s.includes("FROM node_credit_accounts WHERE user_id = $1 FOR UPDATE")) {
        return { rows: [{ user_id: OWNER, pending_musd: "0", available_musd: "0", auto_convert_pct: 0, frozen: false }] };
      }
      return undefined;
    });
    expect(await recordFinding(finding({ freeze: true }), 30)).toEqual({ flagged: true, frozen: true });
    expect(sqls().some((s) => s.includes("node_credit_accounts SET frozen = true"))).toBe(true);
    expect(sqls().some((s) => s.includes("node_credit_auto_freeze"))).toBe(true);
    m.clientQuery.mockReset();
    client((s) => (s.includes("INSERT INTO collusion_flags") ? { rows: [{ id: "1", auto_frozen: true }] } : undefined));
    expect(await recordFinding(finding({ freeze: true }), 30)).toEqual({ flagged: true, frozen: false });
  });

  it("rolls back on error", async () => {
    client((s) => { if (s.includes("INSERT INTO collusion_flags")) throw new Error("boom"); return undefined; });
    await expect(recordFinding(finding(), 30)).rejects.toThrow("boom");
    expect(sqls()).toContain("ROLLBACK");
  });
});
