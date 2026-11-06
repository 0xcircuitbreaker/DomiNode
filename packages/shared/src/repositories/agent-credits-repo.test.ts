import { describe, it, expect, vi, beforeEach } from "vitest";
import { routedClient, type Route } from "./relay-net-test-helpers.js";

const mockConnect = vi.fn();
const mockQuery = vi.fn();
vi.mock("../db.js", () => ({ query: (...a: unknown[]) => mockQuery(...a), getPool: () => ({ connect: () => mockConnect() }) }));
import {
  createSignChallenge, consumeSignChallenge, getCreditSummary, listTransactions, updateNodeCaps, reportSession,
  MAX_OUTSTANDING_SIGN_CHALLENGES,
} from "./agent-credits-repo.js";
import { convertToWallet } from "./node-credit-repo.js";

function setup(routes: Route[]) { const r = routedClient(routes); mockConnect.mockResolvedValue(r.client); return r; }
const H = "a".repeat(64);
const U = "11111111-1111-4111-8111-111111111111";
const S = "33333333-3333-4333-8333-333333333333";
const N = "22222222-2222-4222-8222-222222222222";

beforeEach(() => { vi.resetAllMocks(); });

describe("sign challenges", () => {
  it("caps outstanding challenges per user", async () => {
    setup([[/COUNT\(\*\)/, () => ({ rows: [{ n: String(MAX_OUTSTANDING_SIGN_CHALLENGES) }] })]]);
    expect(await createSignChallenge(U, "withdraw", H, "msg")).toBeNull();
  });
  it("stores and returns expiry", async () => {
    const r = setup([[/COUNT\(\*\)/, () => ({ rows: [{ n: "0" }] })], [/INSERT INTO agent_sign_challenges/, () => ({ rows: [{ expires_at: new Date() }] })]]);
    expect(await createSignChallenge(U, "withdraw", H, "msg")).not.toBeNull();
    expect(r.sqls().some((s) => /FOR UPDATE/.test(s))).toBe(true);
  });
  it("consumes atomically with DELETE ... RETURNING", async () => {
    mockQuery.mockResolvedValue({ rows: [{ message: "m" }] });
    expect(await consumeSignChallenge(U, "withdraw", H)).toBe("m");
    expect(mockQuery.mock.calls[0][0]).toMatch(/DELETE FROM agent_sign_challenges[\s\S]*expires_at > now\(\)[\s\S]*RETURNING message/);
    expect(await consumeSignChallenge(U, "withdraw", "nothex")).toBeNull();
  });
});

describe("reads", () => {
  it("summary zeroes ytd from a previous tax year and never selects *", async () => {
    mockQuery.mockResolvedValue({ rows: [{ pending_musd: "1", available_musd: "2", frozen: true, auto_convert_pct: 0, tax_form_status: "requested", ytd_paid_musd: "9", tax_year: 2025, cur_year: 2026 }] });
    const s = await getCreditSummary(U);
    expect(s).toMatchObject({ pendingMusd: 1n, availableMusd: 2n, frozen: true, ytdPaidMusd: 0n });
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/\*/);
  });
  it("transactions are scoped by user and cursor", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await listTransactions(U, { limit: 10, before: 5n, type: "earn" });
    expect(mockQuery.mock.calls[0][1]).toEqual([U, "5", "earn", 10]);
  });
});

describe("updateNodeCaps", () => {
  it("binds owner in the UPDATE (IDOR-safe)", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await updateNodeCaps(U, N, { maxStreams: 4 })).toBeNull();
    expect(mockQuery.mock.calls[0][0]).toMatch(/WHERE id = \$1 AND owner_user_id = \$2 AND status <> 'revoked'/);
  });
});

describe("reportSession", () => {
  it("not_found for a session the reporter does not own", async () => {
    setup([[/FROM sessions/, () => ({ rows: [] })]]);
    expect(await reportSession(U, S, "blocked")).toEqual({ ok: false, reason: "not_found" });
  });
  it("caps at 5 per reporter per node per day under an advisory lock", async () => {
    const r = setup([
      [/FROM sessions/, () => ({ rows: [{ node_id: N, recent: true }] })],
      [/COUNT\(\*\)/, () => ({ rows: [{ n: "5" }] })],
    ]);
    expect(await reportSession(U, S, "blocked")).toEqual({ ok: false, reason: "rate_limited" });
    expect(r.sqls().some((s) => /pg_advisory_xact_lock/.test(s))).toBe(true);
    expect(r.sqls().some((s) => /INSERT INTO node_reports/.test(s))).toBe(false);
  });
  it("records and bumps node_daily_stats.burns", async () => {
    const r = setup([
      [/FROM sessions/, () => ({ rows: [{ node_id: N, recent: true }] })],
      [/COUNT\(\*\)/, () => ({ rows: [{ n: "1" }] })],
      [/INSERT INTO node_reports/, () => ({ rows: [{ id: "7" }] })],
    ]);
    expect(await reportSession(U, S, "captcha")).toEqual({ ok: true, reportId: "7", nodeId: N, reportsToday: 2 });
    expect(r.sqls().some((s) => /INSERT INTO node_daily_stats/.test(s))).toBe(true);
  });
  it("rejects non-relay and old sessions", async () => {
    setup([[/FROM sessions/, () => ({ rows: [{ node_id: null, recent: true }] })]]);
    expect(await reportSession(U, S, "blocked")).toEqual({ ok: false, reason: "not_relay" });
    setup([[/FROM sessions/, () => ({ rows: [{ node_id: N, recent: false }] })]]);
    expect(await reportSession(U, S, "blocked")).toEqual({ ok: false, reason: "too_old" });
  });
});

describe("convertToWallet idempotency", () => {
  it("returns the original conversion for a repeated key", async () => {
    const r = setup([
      [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w", balance_cents: 0 }] })],
      [/FROM node_credit_accounts WHERE user_id = \$1 FOR UPDATE/, () => ({ rows: [{ user_id: U, pending_musd: "0", available_musd: "0", auto_convert_pct: 0, frozen: false }] })],
      [/external_ref = \$2/, () => ({ rows: [{ amount_musd: "20000" }] })],
    ]);
    const out = await convertToWallet(U, 20_000n, "idem-key-1");
    expect(out).toEqual({ convertedCents: 2, convertedMusd: 20_000n, duplicate: true });
    expect(r.sqls().some((s) => /UPDATE wallets/.test(s))).toBe(false);
  });
  it("rejects malformed keys", async () => {
    await expect(convertToWallet(U, 20_000n, "bad key")).rejects.toThrow(/idempotency/);
  });
});
