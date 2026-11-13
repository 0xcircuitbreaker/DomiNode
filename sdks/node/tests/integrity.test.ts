import { describe, it, expect } from "vitest";
import { DominusNodeClient } from "../src/client.js";
import { ValidationError, ConflictError, RateLimitError, ServerError } from "../src/errors.js";
import { buildPayoutWalletMessage } from "../src/messages.js";
import { MAX_RESPONSE_BYTES, USER_AGENT } from "../src/constants.js";
import { connected, mockFetch, API_KEY, USER_ID, NONCE, SIG, WALLET, signerFor } from "./helpers.js";
import type { TeamInvite } from "../src/resources/teams.js";

describe("2.0.0 compatibility", () => {
  it("deprecated fields still type-check and are undefined", async () => {
    const m = mockFetch([200, { status: "ok" }]);
    const c = new DominusNodeClient({ baseUrl: "http://api.test", fetch: m.fn });
    const h = await c.proxy.getHealth();
    const legacy: number | undefined = h.activeSessions ?? h.uptimeSeconds;
    expect(legacy).toBeUndefined();
    const inv: TeamInvite = { id: "i", teamId: "t", email: "e", role: "r", invitedBy: "u", expiresAt: "t", createdAt: "t" };
    expect(inv.token).toBeUndefined();
  });
});

const B = "http://api.test";
const TEAM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("version", () => {
  it("is 2.2.0", () => expect(USER_AGENT).toBe("dominusnode-sdk-node/2.2.0"));
});

describe("team keys", () => {
  it("createKey reads `prefix`", async () => {
    const { client } = await connected([201, { key: API_KEY, id: "k", prefix: "dn_live_ab", label: "l", createdAt: "t" }]);
    const k = await client.teams.createKey(TEAM, "l");
    expect(k.prefix).toBe("dn_live_ab");
    expect(k.keyPrefix).toBe("dn_live_ab");
    expect(k.key.reveal()).toBe(API_KEY);
  });
  it("createKey falls back to keyPrefix", async () => {
    const { client } = await connected([201, { key: API_KEY, id: "k", keyPrefix: "dn_live_cd", label: "l" }]);
    expect((await client.teams.createKey(TEAM, "l")).prefix).toBe("dn_live_cd");
  });
  it("listKeys exposes prefix, userId, teamId, revokedAt", async () => {
    const { client } = await connected([200, { keys: [
      { id: "k1", userId: "u1", prefix: "dn_live_x", label: "a", teamId: TEAM, createdAt: "t", revokedAt: null },
      { id: "k2", userId: "u2", keyPrefix: "dn_live_y", label: "b", teamId: TEAM, createdAt: "t", revokedAt: "r" },
    ] }]);
    const { keys } = await client.teams.listKeys(TEAM);
    expect(keys[0]).toMatchObject({ prefix: "dn_live_x", userId: "u1", teamId: TEAM, revokedAt: null });
    expect(keys[1]).toMatchObject({ prefix: "dn_live_y", revokedAt: "r" });
  });
});

describe("proxy health", () => {
  it("returns only status", async () => {
    const m = mockFetch([200, { status: "ok", activeSessions: 4 }]);
    const c = new DominusNodeClient({ baseUrl: B, fetch: m.fn });
    expect(await c.proxy.getHealth()).toEqual({ status: "ok" });
  });
});

describe("streamed response cap", () => {
  it("cancels a chunked body past the cap without buffering it all", async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) { pulled++; if (pulled > 50) ctrl.close(); else ctrl.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const c = new DominusNodeClient({ baseUrl: B, fetch: fetchImpl });
    await expect(c.network.policy()).rejects.toBeInstanceOf(ServerError);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(Math.ceil(MAX_RESPONSE_BYTES / chunk.length) + 2);
  });
  it("accepts a body at the cap", async () => {
    const m = mockFetch([200, "\"" + "a".repeat(1000) + "\""]);
    const c = new DominusNodeClient({ baseUrl: B, fetch: m.fn });
    expect(await c.network.policy()).toBe("a".repeat(1000));
  });
});

describe("credits cursor", () => {
  it.each(["0", "01", "12345678901234567890", "-1", "1a"])("rejects %s", async (cursor) => {
    const { client, calls } = await connected();
    await expect(client.credits.transactions({ cursor })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
  it("accepts a 19-digit cursor", async () => {
    const { client, calls } = await connected([200, { transactions: [], nextCursor: null }]);
    await client.credits.transactions({ cursor: "9".repeat(19) });
    expect(calls[0].url).toContain("cursor=" + "9".repeat(19));
  });
});

describe("new fields", () => {
  it("team invites carry invitedBy, no token", async () => {
    const { client } = await connected([200, { invites: [{ id: "i", teamId: TEAM, email: "e", role: "member", invitedBy: "u", expiresAt: "t", createdAt: "t" }] }]);
    const { invites } = await client.teams.listInvites(TEAM);
    expect(invites[0].invitedBy).toBe("u");
    expect("token" in invites[0]).toBe(false);
  });
  it("pricing, stats, credits, tier pass the new fields through", async () => {
    const { client } = await connected(
      [200, { prices: [], nodeShare: [], buyerDiscounts: [{ tier: "Partner", rank: 4, buyerDiscountBps: 500 }] }],
      [200, { onlineNodes: 1, seed: { online: 1, paidBytes24h: "10" }, community: { online: 0, paidBytes24h: "0" } }],
      [200, { buyerDiscountBps: 250 }],
      [200, { tier: { buyerDiscountBps: 100 }, nextTier: null }],
    );
    expect((await client.network.pricing()).buyerDiscounts[0].buyerDiscountBps).toBe(500);
    const s = await client.network.stats();
    expect(s.seed.paidBytes24h).toBe("10");
    expect(s.community.online).toBe(0);
    expect((await client.credits.balance()).buyerDiscountBps).toBe(250);
    expect((await client.nodes.tier()).tier.buyerDiscountBps).toBe(100);
  });
});

describe("payout wallet chain", () => {
  const NEW = "0x" + "3".repeat(40);
  it("accepts base-sepolia as an explicit opt-in", async () => {
    const message = buildPayoutWalletMessage({ userId: USER_ID, wallet: WALLET, address: NEW, chain: "base-sepolia", nonce: NONCE });
    const { client, calls } = await connected(
      [200, { nonce: NONCE, message, expiresAt: "t", signer: WALLET, oldWalletSignatureRequired: false, oldWalletAddress: null }],
      [200, { payoutWallet: null, changed: true, cooldownHours: 0 }],
    );
    await client.payoutWallet.set({ address: NEW, chain: "base-sepolia", signer: signerFor().signer });
    expect(calls[0].body).toEqual({ address: NEW, chain: "base-sepolia" });
    expect(calls[1].body).toMatchObject({ chain: "base-sepolia", signature: SIG });
  });
  it("still rejects other chains", async () => {
    const { client, calls } = await connected();
    await expect(client.payoutWallet.set({ address: NEW, chain: "eth" as "base", signer: signerFor().signer })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});

describe("retries", () => {
  const SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  it("409 REPORT_LIMIT is not retried and carries the code", async () => {
    const { client, calls } = await connected([409, { error: "At most 20 reports", code: "REPORT_LIMIT" }]);
    const err = await client.sessions.report(SID, "blocked").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe("REPORT_LIMIT");
    expect(calls).toHaveLength(1);
  });
  it("429 is retried exactly once", async () => {
    const { client, calls } = await connected(
      [429, { error: "slow" }, { "retry-after": "0" }],
      [429, { error: "slow", code: "REPORT_LIMIT" }, { "retry-after": "0" }],
    );
    const err = await client.sessions.report(SID, "blocked").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe("REPORT_LIMIT");
    expect(calls).toHaveLength(2);
  });
});

describe("pagination helpers", () => {
  it("credits.iterTransactions follows nextCursor", async () => {
    const { client, calls } = await connected(
      [200, { transactions: [{ id: "3" }, { id: "2" }], nextCursor: "2" }],
      [200, { transactions: [{ id: "1" }], nextCursor: null }],
    );
    const all = await collect(client.credits.iterTransactions({ limit: 2, type: "earn" }));
    expect(all.map((t) => t.id)).toEqual(["3", "2", "1"]);
    expect(calls[0].url).toBe(`${B}/v1/credits/transactions?limit=2&type=earn`);
    expect(calls[1].url).toBe(`${B}/v1/credits/transactions?limit=2&cursor=2&type=earn`);
  });
  it("payouts.iterate pages by offset", async () => {
    const { client, calls } = await connected([200, { payouts: [{ id: "a" }, { id: "b" }] }], [200, { payouts: [{ id: "c" }] }]);
    expect((await collect(client.payouts.iterate({ limit: 2 }))).length).toBe(3);
    expect(calls[1].url).toBe(`${B}/v1/payouts?limit=2&offset=2`);
  });
  it("nodes.iterate pages by offset", async () => {
    const { client, calls } = await connected([200, { nodes: [{ id: "a" }] }], [200, { nodes: [] }]);
    expect((await collect(client.nodes.iterate({ limit: 1 }))).length).toBe(1);
    expect(calls[1].url).toBe(`${B}/v1/nodes?limit=1&offset=1`);
  });
  it("usage.iterRecords stops at pagination.total", async () => {
    const { client, calls } = await connected([200, { records: [{ id: "a" }, { id: "b" }], pagination: { total: 2 } }]);
    expect((await collect(client.usage.iterRecords({ limit: 2, from: "2026-01-01" }))).length).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${B}/api/usage?since=2026-01-01&limit=2&offset=0`);
  });
  it("wallet.iterTransactions pages by offset and validates limit", async () => {
    const { client, calls } = await connected([200, { transactions: [{ id: "a" }] }], [200, { transactions: [] }]);
    expect((await collect(client.wallet.iterTransactions({ limit: 1 }))).length).toBe(1);
    expect(calls[1].url).toBe(`${B}/api/wallet/transactions?limit=1&offset=1`);
    await expect(collect(client.wallet.iterTransactions({ limit: 101 }))).rejects.toBeInstanceOf(ValidationError);
  });
});
