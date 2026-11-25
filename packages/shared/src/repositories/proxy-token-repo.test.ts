import { describe, it, expect, vi, beforeEach } from "vitest";
import { routedClient, type Route } from "./relay-net-test-helpers.js";

const mockConnect = vi.fn();
const mockQuery = vi.fn();
vi.mock("../db.js", () => ({ query: (...a: unknown[]) => mockQuery(...a), queryOn: (ext: { query: (...x: unknown[]) => unknown } | undefined, ...a: unknown[]) => (ext ? ext.query(...a) : mockQuery(...a)), getPool: () => ({ connect: () => mockConnect() }) }));
import {
  createProxyToken, listProxyTokens, revokeProxyToken, revokeAllForUser, findUsableByHash, recordUsage,
  generateProxyToken, hashProxyToken, tokenStatus, isExhausted, OPAQUE_PROXY_TOKEN_RE, ProxyTokenInputError,
  computeGrant, reserveSessionBudget, settleSessionBudget, findEndedTokenIds,
  type ProxyToken,
} from "./proxy-token-repo.js";

const U = "11111111-1111-4111-8111-111111111111";
const T = "22222222-2222-4222-8222-222222222222";
const row = (o: Record<string, unknown> = {}) => ({
  id: T, user_id: U, label: "ci", expires_at: new Date(Date.now() + 60_000), max_bytes: "1000", max_spend_musd: null,
  bytes_used: "0", spend_used_musd: "0", revoked_at: null, created_at: new Date(), ...o,
});
function setup(routes: Route[]) { const r = routedClient(routes); mockConnect.mockResolvedValue(r.client); return r; }

beforeEach(() => { vi.resetAllMocks(); });

describe("token format", () => {
  it("mints opaque dn_proxy_ tokens with no dot and hashes with SHA-256", () => {
    const a = generateProxyToken();
    const b = generateProxyToken();
    expect(a.token).toMatch(OPAQUE_PROXY_TOKEN_RE);
    expect(a.token).not.toContain(".");
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashProxyToken(a.token));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("createProxyToken", () => {
  it("stores only the hash, returns the secret once, and uses explicit columns", async () => {
    const r = setup([
      [/FROM users/, () => ({ rows: [{ id: U }] })],
      [/COUNT\(\*\)/, () => ({ rows: [{ n: "0" }] })],
      [/INSERT INTO proxy_tokens/, () => ({ rows: [row()] })],
    ]);
    const out = await createProxyToken(U, { label: "ci", ttlMs: 3_600_000, maxBytes: 1000n });
    expect(out).not.toBeNull();
    expect(out!.token).toMatch(OPAQUE_PROXY_TOKEN_RE);
    expect(out!.record.maxBytes).toBe(1000n);
    const ins = r.calls.find((c) => /INSERT INTO proxy_tokens/.test(c.sql))!;
    expect(ins.params[1]).toBe(hashProxyToken(out!.token));
    expect(ins.params).not.toContain(out!.token);
    expect(ins.sql).not.toMatch(/RETURNING \*/);
    expect(ins.sql.split("RETURNING")[1]).not.toMatch(/token_hash/);
    expect(r.sqls().some((s) => /FOR UPDATE/.test(s) && /status = 'active'/.test(s))).toBe(true);
  });
  it("refuses at the active-token cap", async () => {
    setup([[/FROM users/, () => ({ rows: [{ id: U }] })], [/COUNT\(\*\)/, () => ({ rows: [{ n: "3" }] })]]);
    expect(await createProxyToken(U, {}, 3)).toBeNull();
  });
  it("refuses an inactive user", async () => {
    setup([[/FROM users/, () => ({ rows: [] })]]);
    expect(await createProxyToken(U, {})).toBeNull();
  });
  it("validates input before touching the DB", async () => {
    await expect(createProxyToken(U, { ttlMs: 1 })).rejects.toBeInstanceOf(ProxyTokenInputError);
    await expect(createProxyToken(U, { maxBytes: 0n })).rejects.toBeInstanceOf(ProxyTokenInputError);
    await expect(createProxyToken(U, { maxSpendMusd: 10n ** 20n })).rejects.toBeInstanceOf(ProxyTokenInputError);
    await expect(createProxyToken(U, { label: "x".repeat(65) })).rejects.toBeInstanceOf(ProxyTokenInputError);
    await expect(createProxyToken(U, { label: "a\nb" })).rejects.toBeInstanceOf(ProxyTokenInputError);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});

describe("list / revoke / lookup", () => {
  it("lists without the hash", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    const l = await listProxyTokens(U);
    expect(l).toHaveLength(1);
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/token_hash|\*/);
  });
  it("revokes only the owner's unrevoked token", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: T }] }).mockResolvedValueOnce({ rows: [] });
    expect(await revokeProxyToken(U, T)).toBe(true);
    expect(await revokeProxyToken(U, T)).toBe(false);
    expect(mockQuery.mock.calls[0][0]).toMatch(/user_id = \$2 AND revoked_at IS NULL/);
    expect(await revokeProxyToken(U, "nope")).toBe(false);
  });
  it("revokeAllForUser runs on a caller transaction client when given", async () => {
    const tx = { query: vi.fn().mockResolvedValueOnce({ rows: [{ id: T }] }) };
    expect(await revokeAllForUser(U, tx as never)).toBe(1);
    expect(tx.query.mock.calls[0][0]).toMatch(/UPDATE proxy_tokens SET revoked_at = now\(\) WHERE user_id = \$1 AND revoked_at IS NULL/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it("revokeAllForUser counts rows", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: T }, { id: U }] });
    expect(await revokeAllForUser(U)).toBe(2);
  });
  it("lookup requires unrevoked, unexpired, under caps", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [row()] });
    expect(await findUsableByHash("a".repeat(64))).not.toBeNull();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(sql).toMatch(/bytes_used < max_bytes/);
    expect(sql).toMatch(/spend_used_musd < max_spend_musd/);
    expect(await findUsableByHash("not-hex")).toBeNull();
  });
});

describe("recordUsage", () => {
  it("conditional update within caps", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: T, exhausted: false }] });
    expect(await recordUsage(T, 100n, 5n)).toEqual({ withinCaps: true, exhausted: false });
    expect(mockQuery.mock.calls[0][0]).toMatch(/bytes_used \+ \$2::bigint <= COALESCE\(max_bytes/);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
  it("reports exhausted when usage lands exactly on a cap", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: T, exhausted: true }] });
    expect(await recordUsage(T, 1000n, 0n)).toEqual({ withinCaps: true, exhausted: true });
    expect(mockQuery.mock.calls[0][0]).toMatch(/bytes_used >= max_bytes/);
  });
  it("saturates at the cap when the delta does not fit", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await recordUsage(T, 10_000n, 0n)).toEqual({ withinCaps: false, exhausted: true });
    expect(mockQuery.mock.calls[1][0]).toMatch(/LEAST\(bytes_used/);
  });
  it("skips zero usage", async () => {
    expect(await recordUsage(T, 0n, 0n)).toEqual({ withinCaps: true, exhausted: false });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  const base: ProxyToken = {
    id: T, userId: U, label: "", expiresAt: new Date(Date.now() + 60_000), maxBytes: 10n, maxSpendMusd: 10n,
    bytesUsed: 0n, spendUsedMusd: 0n, revokedAt: null, createdAt: new Date(),
  };
  it("derives status", () => {
    expect(tokenStatus(base)).toBe("active");
    expect(tokenStatus({ ...base, revokedAt: new Date() })).toBe("revoked");
    expect(tokenStatus({ ...base, expiresAt: new Date(0) })).toBe("expired");
    expect(tokenStatus({ ...base, spendUsedMusd: 10n })).toBe("exhausted");
    expect(isExhausted({ ...base, maxBytes: null, maxSpendMusd: null, bytesUsed: 99n })).toBe(false);
  });
});

describe("session-start budget reservation", () => {
  const t = (o: Partial<ProxyToken> = {}) => ({ maxBytes: null, maxSpendMusd: null, bytesUsed: 0n, spendUsedMusd: 0n, ...o });
  it("computeGrant takes the smaller of want, remaining bytes and bytes the remaining spend buys", () => {
    expect(computeGrant(t(), 1000n, 500_000n)).toEqual({ bytes: 1000n, spendMusd: 1n });
    expect(computeGrant(t({ maxBytes: 100n, bytesUsed: 40n }), 1000n, 500_000n)?.bytes).toBe(60n);
    // 50 µUSD at $0.50/GB buys 100_000 bytes; ceil(spend) never exceeds the remainder
    const g = computeGrant(t({ maxSpendMusd: 60n, spendUsedMusd: 10n }), 10n ** 9n, 500_000n)!;
    expect(g).toEqual({ bytes: 100_000n, spendMusd: 50n });
    expect(computeGrant(t({ maxBytes: 5n, bytesUsed: 5n }), 10n, 1n)).toBeNull();
    expect(computeGrant(t({ maxSpendMusd: 5n, spendUsedMusd: 5n }), 10n, 1n)).toBeNull();
    expect(computeGrant(t(), 0n, 1n)).toBeNull();
  });
  it("computeGrant for prepaid sessions reserves the paid amount or refuses", () => {
    expect(computeGrant(t({ maxSpendMusd: 100n }), 10n, 1n, 80n)).toEqual({ bytes: 10n, spendMusd: 80n });
    expect(computeGrant(t({ maxSpendMusd: 100n, spendUsedMusd: 30n }), 10n, 1n, 80n)).toBeNull();
  });
  it("reserves under a row lock with a conditional update", async () => {
    const r = setup([
      [/FOR UPDATE/, () => ({ rows: [row({ max_bytes: "1000", bytes_used: "900" })] })],
      [/UPDATE proxy_tokens/, () => ({ rows: [{ id: T }] })],
    ]);
    expect(await reserveSessionBudget(T, 10_000n, 500_000n)).toEqual({ bytes: 100n, spendMusd: 1n });
    const sel = r.calls.find((c) => /FOR UPDATE/.test(c.sql))!;
    expect(sel.sql).toMatch(/revoked_at IS NULL AND expires_at > now\(\)/);
    expect(sel.sql).not.toMatch(/\*/);
    const upd = r.calls.find((c) => /UPDATE proxy_tokens/.test(c.sql))!;
    expect(upd.sql).toMatch(/bytes_used \+ \$2::bigint <= COALESCE\(max_bytes/);
    expect(upd.params.slice(1)).toEqual(["100", "1"]);
  });
  it("refuses a revoked/expired token or an exhausted budget without updating", async () => {
    const r = setup([[/FOR UPDATE/, () => ({ rows: [] })]]);
    expect(await reserveSessionBudget(T, 10n, 1n)).toBeNull();
    expect(r.sqls().some((x) => /UPDATE proxy_tokens/.test(x))).toBe(false);
    setup([[/FOR UPDATE/, () => ({ rows: [row({ max_bytes: "1000", bytes_used: "1000" })] })]]);
    expect(await reserveSessionBudget(T, 10n, 1n)).toBeNull();
    expect(await reserveSessionBudget("nope", 10n, 1n)).toBeNull();
  });
  it("settle replaces the grant with actual usage, floored and saturated", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ exhausted: false }] });
    expect(await settleSessionBudget(T, { bytes: 100n, spendMusd: 5n }, 40n, 2n)).toEqual({ exhausted: false });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/LEAST\(GREATEST\(bytes_used - \$2::bigint \+ \$3::bigint, 0\), COALESCE\(max_bytes/);
    expect(params).toEqual([T, "100", "40", "5", "2"]);
  });
  it("findEndedTokenIds returns ids not live in the table", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: T }] });
    expect(await findEndedTokenIds([T, U, "junk"])).toEqual([U]);
    expect(mockQuery.mock.calls[0][0]).toMatch(/revoked_at IS NULL AND expires_at > now\(\)/);
    expect(await findEndedTokenIds([])).toEqual([]);
  });
});
