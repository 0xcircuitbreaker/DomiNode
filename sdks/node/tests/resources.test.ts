import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { DominusNodeClient } from "../src/client.js";
import { ValidationError, ProtocolError } from "../src/errors.js";
import { Secret } from "../src/secret.js";
import { connected, mockFetch, UUID, WALLET, SIG, makeJwt, API_KEY, signerFor } from "./helpers.js";

const B = "http://api.test";

describe("keys", () => {
  it("create returns the key in a Secret", async () => {
    const { client, calls } = await connected([201, { key: API_KEY, id: "k1", prefix: "dn_live_", label: "bot", created_at: "t" }]);
    const k = await client.keys.create("bot");
    expect(calls[0]).toMatchObject({ url: `${B}/api/keys`, method: "POST", body: { label: "bot" } });
    expect(k.key).toBeInstanceOf(Secret);
    expect(k.key.reveal()).toBe(API_KEY);
    expect(JSON.stringify(k)).not.toContain(API_KEY.slice(8));
    expect(inspect(k)).not.toContain(API_KEY.slice(8));
  });
  it("list / revoke (encoded)", async () => {
    const { client, calls } = await connected([200, { keys: [] }], [200, {}]);
    await client.keys.list();
    await client.keys.revoke("a/b");
    expect(calls[0]).toMatchObject({ url: `${B}/api/keys`, method: "GET" });
    expect(calls[1]).toMatchObject({ url: `${B}/api/keys/a%2Fb`, method: "DELETE" });
  });
});

describe("wallet", () => {
  it("balance, transactions, forecast", async () => {
    const { client, calls } = await connected([200, {}], [200, { transactions: [] }], [200, {}]);
    await client.wallet.getBalance();
    await client.wallet.getTransactions({ limit: 5, offset: 10 });
    await client.wallet.getForecast();
    expect(calls.map((c) => c.url)).toEqual([`${B}/api/wallet`, `${B}/api/wallet/transactions?limit=5&offset=10`, `${B}/api/wallet/forecast`]);
  });
  it("topUpCrypto validates and sends USD", async () => {
    const { client, calls } = await connected([200, { invoiceId: UUID }]);
    await client.wallet.topUpCrypto(2500, "USDC");
    expect(calls[0]).toMatchObject({ url: `${B}/api/wallet/topup/crypto`, body: { amountUsd: 25, currency: "usdc" } });
    await expect(client.wallet.topUpCrypto(999, "btc")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.wallet.topUpCrypto(100_001, "btc")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.wallet.topUpCrypto(1.5 as number, "btc")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.wallet.topUpCrypto(2_147_483_648, "btc")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.wallet.topUpCrypto(2000, "doge")).rejects.toBeInstanceOf(ValidationError);
  });
  it("getCryptoStatus", async () => {
    const { client, calls } = await connected([200, { status: "completed" }]);
    await client.wallet.getCryptoStatus(UUID);
    expect(calls[0].url).toBe(`${B}/api/wallet/crypto/status/${UUID}`);
    await expect(client.wallet.getCryptoStatus("../x")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("usage", () => {
  it("all four endpoints", async () => {
    const { client, calls } = await connected([200, {}], [200, {}], [200, {}], [200, "Date,Bytes\n"]);
    await client.usage.get({ from: "2026-01-01", to: "2026-02-01", limit: 10 });
    await client.usage.getDaily({ from: "2026-01-01" });
    await client.usage.getTopHosts({ limit: 3 });
    expect(await client.usage.exportCsv()).toBe("Date,Bytes\n");
    expect(calls.map((c) => c.url)).toEqual([
      `${B}/api/usage?since=2026-01-01&until=2026-02-01&limit=10`, `${B}/api/usage/daily?since=2026-01-01`,
      `${B}/api/usage/top-hosts?limit=3`, `${B}/api/usage/export`,
    ]);
  });
});

describe("sessions", () => {
  it("getActive whitelists fields (no proxy/node IP)", async () => {
    const { client } = await connected([200, { sessions: [{ id: "s", startedAt: "t", status: "active", proxyIp: "1.2.3.4", nodeIp: "5.6.7.8" }] }]);
    const r = await client.sessions.getActive();
    expect(r.sessions[0]).toEqual({ id: "s", startedAt: "t", status: "active" });
  });
  it("report", async () => {
    const { client, calls } = await connected([201, { reportId: "7", reportsToday: 1, limitPerDay: 5 }]);
    expect(await client.sessions.report(UUID, "captcha")).toEqual({ reportId: "7", reportsToday: 1, limitPerDay: 5 });
    expect(calls[0]).toMatchObject({ url: `${B}/v1/sessions/${UUID}/report`, method: "POST", body: { reason: "captcha" } });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    await expect(client.sessions.report(UUID, "meh" as "other")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.sessions.report("nope", "other")).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("network (no auth)", () => {
  it("policy, pricing, stats", async () => {
    const m = mockFetch([200, { version: 3 }], [200, { prices: [] }], [200, { onlineNodes: 0 }]);
    const c = new DominusNodeClient({ baseUrl: B, fetch: m.fn });
    await c.network.policy();
    await c.network.pricing();
    await c.network.stats();
    expect(m.calls.map((x) => x.url)).toEqual([`${B}/v1/policy`, `${B}/v1/pricing`, `${B}/v1/network/stats`]);
    expect(m.calls.every((x) => !x.headers.Authorization)).toBe(true);
  });
});

describe("x402 + proxy info", () => {
  it("x402 info is public; proxy health public; config authed", async () => {
    const { client, calls } = await connected([200, { supported: true }], [200, { status: "ok" }], [200, {}]);
    await client.x402.getInfo();
    await client.proxy.getHealth();
    await client.proxy.getConfig();
    expect(calls[0]).toMatchObject({ url: `${B}/api/x402/info` });
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(calls[1].headers.Authorization).toBeUndefined();
    expect(calls[2].headers.Authorization).toMatch(/^Bearer eyJ/);
  });
});

describe("walletAuth", () => {
  it("challenge/verify stores tokens", async () => {
    const m = mockFetch([200, { message: `sign ${WALLET.toLowerCase()}`, nonce: "n", challenge: "c", expiresAt: "t" }],
      [200, { token: makeJwt(), refreshToken: makeJwt(86400), user: { id: "u" } }], [200, { pending: {} }]);
    const c = new DominusNodeClient({ baseUrl: B, fetch: m.fn });
    const { signer, signed } = signerFor();
    await c.walletAuth.signIn(signer);
    expect(signed[0]).toBe(`sign ${WALLET.toLowerCase()}`);
    expect(m.calls[1].body).toEqual({ address: WALLET, signature: SIG });
    await c.credits.balance();
    expect(m.calls[2].headers.Authorization).toMatch(/^Bearer eyJ/);
  });
  it("verify detects mfaRequired and stores nothing", async () => {
    const m = mockFetch([200, { mfaRequired: true, mfaChallengeToken: "t" }]);
    const c = new DominusNodeClient({ baseUrl: B, fetch: m.fn });
    expect(await c.walletAuth.verify(WALLET, SIG)).toEqual({ mfaRequired: true, mfaChallengeToken: "t" });
    expect(c.isConnected).toBe(false);
  });
  it("signIn refuses a challenge for another address", async () => {
    const m = mockFetch([200, { message: "sign 0xdead", nonce: "n" }]);
    const c = new DominusNodeClient({ baseUrl: B, fetch: m.fn });
    await expect(c.walletAuth.signIn(signerFor().signer)).rejects.toBeInstanceOf(ProtocolError);
  });
  it("validates address and signature format", async () => {
    const c = new DominusNodeClient({ baseUrl: B, fetch: mockFetch().fn });
    await expect(c.walletAuth.challenge("0x123")).rejects.toBeInstanceOf(ValidationError);
    await expect(c.walletAuth.verify(WALLET, "0x" + "a".repeat(129))).rejects.toBeInstanceOf(ValidationError);
    await expect(c.walletAuth.verify(WALLET, "0x" + "a".repeat(250))).rejects.toThrow(/200/);
    await expect(c.walletAuth.verify(WALLET, "0x" + "g".repeat(130))).rejects.toBeInstanceOf(ValidationError);
  });
  it("link", async () => {
    const { client, calls } = await connected([200, { success: true, walletAddress: WALLET }]);
    await client.walletAuth.link(WALLET, SIG);
    expect(calls[0]).toMatchObject({ url: `${B}/api/auth/wallet/link`, body: { address: WALLET, signature: SIG } });
  });
});

describe("agenticWallets (9)", () => {
  it("all methods hit the right routes", async () => {
    const { client, calls } = await connected(...Array.from({ length: 9 }, () => [200, {}] as [number, unknown]));
    await client.agenticWallets.create("bot", 500, { dailyLimitCents: 100, allowedDomains: ["a.com"] });
    await client.agenticWallets.list();
    await client.agenticWallets.get("w/1");
    await client.agenticWallets.fund("w1", 100);
    await client.agenticWallets.updateWalletPolicy("w1", { dailyLimitCents: null });
    await client.agenticWallets.transactions("w1", 5, 0);
    await client.agenticWallets.freeze("w1");
    await client.agenticWallets.unfreeze("w1");
    await client.agenticWallets.delete("w1");
    expect(calls.map((c) => `${c.method} ${c.url.slice(B.length)}`)).toEqual([
      "POST /api/agent-wallet", "GET /api/agent-wallet", "GET /api/agent-wallet/w%2F1", "POST /api/agent-wallet/w1/fund",
      "PATCH /api/agent-wallet/w1/policy", "GET /api/agent-wallet/w1/transactions?limit=5&offset=0",
      "POST /api/agent-wallet/w1/freeze", "POST /api/agent-wallet/w1/unfreeze", "DELETE /api/agent-wallet/w1",
    ]);
    await expect(client.agenticWallets.fund("w1", 0)).rejects.toBeInstanceOf(ValidationError);
    await expect(client.agenticWallets.fund("w1", 2_147_483_648)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("teams (18)", () => {
  it("all methods hit the right routes", async () => {
    const replies = Array.from({ length: 18 }, () => [200, {}] as [number, unknown]);
    replies[15] = [201, { id: "k", key: API_KEY, keyPrefix: "dn_live_", label: "l" }];
    const { client, calls } = await connected(...replies);
    const t = client.teams;
    await t.create("T", 5); await t.list(); await t.get("t1"); await t.update("t1", { name: "N" }); await t.delete("t1");
    await t.fundWallet("t1", 100); await t.getTransactions("t1", 1, 2); await t.listMembers("t1");
    await t.addMember("t1", "a@b", "member"); await t.updateMemberRole("t1", "u1", "admin"); await t.removeMember("t1", "u1");
    await t.createInvite("t1", "a@b"); await t.listInvites("t1"); await t.cancelInvite("t1", "i1"); await t.acceptInvite("tok/x");
    const k = await t.createKey("t1", "l"); await t.listKeys("t1"); await t.revokeKey("t1", "k1");
    expect(k.key).toBeInstanceOf(Secret);
    expect(calls.map((c) => `${c.method} ${c.url.slice(B.length)}`)).toEqual([
      "POST /api/teams", "GET /api/teams", "GET /api/teams/t1", "PATCH /api/teams/t1", "DELETE /api/teams/t1",
      "POST /api/teams/t1/wallet/fund", "GET /api/teams/t1/wallet/transactions?limit=1&offset=2", "GET /api/teams/t1/members",
      "POST /api/teams/t1/members", "PATCH /api/teams/t1/members/u1", "DELETE /api/teams/t1/members/u1",
      "POST /api/teams/t1/invites", "GET /api/teams/t1/invites", "DELETE /api/teams/t1/invites/i1",
      "POST /api/teams/invites/tok%2Fx/accept", "POST /api/teams/t1/keys", "GET /api/teams/t1/keys", "DELETE /api/teams/t1/keys/k1",
    ]);
    await expect(t.fundWallet("t1", -1)).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("auth", () => {
  it("verifyKey/refresh are unauthenticated", async () => {
    const m = mockFetch([200, { token: "a" }]);
    const c = new DominusNodeClient({ baseUrl: B, fetch: m.fn });
    await c.auth.refresh("r");
    expect(m.calls[0]).toMatchObject({ url: `${B}/api/auth/refresh`, body: { refreshToken: "r" } });
    expect(m.calls[0].headers.Authorization).toBeUndefined();
  });
});
