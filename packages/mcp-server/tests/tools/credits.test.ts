import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Wallet, verifyMessage } from "ethers";
import { registerCreditsTools, payoutWalletMessage, withdrawMessage } from "../../src/tools/credits.js";
import type { McpConfig } from "../../src/config.js";
import { callTool, jsonResponse, makeHttpClient } from "../helpers/mock.js";

const API_KEY = "dn_live_" + "k".repeat(40);
const USER = "11111111-1111-4111-8111-111111111111";
const NONCE = "c".repeat(64);
const NODE_ID = "22222222-2222-4222-8222-222222222222";

let dir: string;
let wallet: Wallet;
let oldPayout: Wallet;
let config: McpConfig;

function keyFile(name: string, w: Wallet): string {
  const f = path.join(dir, name);
  fs.writeFileSync(f, w.privateKey, { mode: 0o600 });
  return f;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-mcp-credits-"));
  wallet = Wallet.createRandom() as unknown as Wallet;
  oldPayout = Wallet.createRandom() as unknown as Wallet;
  config = {
    apiKey: API_KEY, apiUrl: "http://localhost:3000", proxyHost: "p", httpProxyPort: 8080, socks5ProxyPort: 1080,
    fetchTimeoutMs: 30000, fetchMaxResponseBytes: 1024, mcpAgentSecret: "",
    walletKeyFile: keyFile("wallet.key", wallet), payoutWalletKeyFile: null, nodeKeyFile: path.join(dir, "node.json"),
  };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function setup(cfg: Partial<McpConfig> = {}) {
  const http = await makeHttpClient();
  const server = new McpServer({ name: "t", version: "1" });
  registerCreditsTools(server, http, { ...config, ...cfg });
  return server;
}

type Handler = (url: string, init: RequestInit, body: Record<string, unknown>) => Response;
function route(h: Handler) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url, init, body });
    return h(url, init, body);
  }) as unknown as typeof fetch;
  return calls;
}

describe("message builders (parity with dashboard routes/v1/credits.ts)", () => {
  it("payout wallet message", () => {
    expect(payoutWalletMessage({ userId: USER, wallet: "0xa", address: "0xb", chain: "base", nonce: "n" })).toBe(
      `DominusNode payout wallet\nAction: payout_wallet_set\nUser: ${USER}\nAccount wallet: 0xa\nPayout address: 0xb\nChain: base\nNonce: n`,
    );
  });
  it("withdraw message", () => {
    expect(withdrawMessage({ userId: USER, wallet: "0xa", amountMusd: "1000000", idempotencyKey: "k", nonce: "n" })).toBe(
      `DominusNode withdrawal\nAction: withdraw\nUser: ${USER}\nAccount wallet: 0xa\nAmount (µUSD): 1000000\nIdempotency key: k\nNonce: n`,
    );
  });
});

describe("credits tools", () => {
  it("credits_balance renders {musd, usd} money with Bearer API key", async () => {
    const server = await setup();
    const calls = route(() => jsonResponse({
      pending: { musd: "2000000", usd: "2.000000" }, available: { musd: "1500000", usd: "1.500000" }, frozen: false,
      autoConvertPct: 0, tier: { name: "probation", holdDays: 14, dailyWithdrawLimit: { musd: "50000000", usd: "50.000000" } },
      taxFormStatus: "not_required", ytdPaid: { musd: "0", usd: "0.000000" }, payoutsEnabled: false, minWithdraw: { musd: "1000000", usd: "1.000000" },
    }));
    const r = await callTool(server, "dominusnode_credits_balance");
    expect(r.content[0].text).toContain("Available: $1.500000");
    expect(r.content[0].text).toContain("disabled");
    expect((calls[0].init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${API_KEY}`);
  });

  it("credits_convert sends Idempotency-Key header", async () => {
    const server = await setup();
    const calls = route(() => jsonResponse({ converted: { musd: "10000", usd: "0.010000" }, convertedCents: 1, duplicate: false }));
    const r = await callTool(server, "dominusnode_credits_convert", { amount_musd: "10000", idempotency_key: "my-key-0001" });
    expect(r.isError).toBeUndefined();
    expect((calls[0].init.headers as Record<string, string>)["Idempotency-Key"]).toBe("my-key-0001");
    expect(calls[0].body).toEqual({ amountMusd: "10000" });
  });

  it("credits_convert and credits_withdraw put the idempotency key in error output", async () => {
    const server = await setup();
    route(() => jsonResponse({ error: "upstream timeout" }, 500));
    const c = await callTool(server, "dominusnode_credits_convert", { amount_musd: "10000", idempotency_key: "retry-key-01" });
    expect(c.isError).toBe(true);
    expect(c.content[0].text).toContain('idempotency_key="retry-key-01"');
    const gen = await callTool(server, "dominusnode_credits_convert", { amount_musd: "10000" });
    expect(gen.content[0].text).toMatch(/idempotency_key="mcp-conv-[0-9a-f]{24}"/);
    const w = await callTool(server, "dominusnode_credits_withdraw", { amount_musd: "2000000", idempotency_key: "wd-retry-01", confirm: true });
    expect(w.isError).toBe(true);
    expect(w.content[0].text).toContain('idempotency_key="wd-retry-01"');
  });

  it("payout_wallet_set signs the locally rebuilt message with the key file", async () => {
    const server = await setup();
    const addr = Wallet.createRandom().address.toLowerCase();
    const calls = route((url, init, body) => {
      if (url.endsWith("/challenge")) {
        return jsonResponse({ nonce: NONCE, message: payoutWalletMessage({ userId: USER, wallet: wallet.address.toLowerCase(), address: body["address"] as string, chain: "base", nonce: NONCE }), signer: wallet.address.toLowerCase(), oldWalletSignatureRequired: false, oldWalletAddress: null });
      }
      return jsonResponse({ payoutWallet: { address: addr, status: "active", activeFrom: "x" }, changed: false, cooldownHours: 0 });
    });
    const r = await callTool(server, "dominusnode_payout_wallet_set", { address: addr, confirm: true });
    expect(r.isError).toBeUndefined();
    const put = calls[1];
    expect(put.init.method).toBe("PUT");
    const msg = payoutWalletMessage({ userId: USER, wallet: wallet.address.toLowerCase(), address: addr, chain: "base", nonce: NONCE });
    expect(verifyMessage(msg, put.body["signature"] as string).toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(JSON.stringify(calls)).not.toContain(wallet.privateKey.slice(2));
  });

  it("payout_wallet_set defaults to chain base", async () => {
    const server = await setup();
    const addr = Wallet.createRandom().address.toLowerCase();
    const calls = route((url, _i, body) => url.endsWith("/challenge")
      ? jsonResponse({ nonce: NONCE, message: payoutWalletMessage({ userId: USER, wallet: wallet.address.toLowerCase(), address: body["address"] as string, chain: body["chain"] as string, nonce: NONCE }), oldWalletSignatureRequired: false, oldWalletAddress: null })
      : jsonResponse({ payoutWallet: { address: addr, status: "active", activeFrom: "x" }, changed: false, cooldownHours: 0 }));
    await callTool(server, "dominusnode_payout_wallet_set", { address: addr, confirm: true });
    expect(calls[0].body).toEqual({ address: addr, chain: "base" });
    expect(calls[1].body["chain"]).toBe("base");
  });

  it("payout_wallet_set passes chain base-sepolia through and signs it", async () => {
    const server = await setup();
    const addr = Wallet.createRandom().address.toLowerCase();
    const calls = route((url, _i, body) => url.endsWith("/challenge")
      ? jsonResponse({ nonce: NONCE, message: payoutWalletMessage({ userId: USER, wallet: wallet.address.toLowerCase(), address: body["address"] as string, chain: body["chain"] as string, nonce: NONCE }), oldWalletSignatureRequired: false, oldWalletAddress: null })
      : jsonResponse({ payoutWallet: { address: addr, status: "active", activeFrom: "x" }, changed: false, cooldownHours: 0 }));
    const r = await callTool(server, "dominusnode_payout_wallet_set", { address: addr, chain: "base-sepolia", confirm: true });
    expect(r.isError).toBeUndefined();
    expect(calls[0].body).toEqual({ address: addr, chain: "base-sepolia" });
    expect(calls[1].body["chain"]).toBe("base-sepolia");
    const msg = payoutWalletMessage({ userId: USER, wallet: wallet.address.toLowerCase(), address: addr, chain: "base-sepolia", nonce: NONCE });
    expect(verifyMessage(msg, calls[1].body["signature"] as string).toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("payout_wallet_set rejects an unknown chain before any request", async () => {
    const server = await setup();
    const calls = route(() => jsonResponse({}));
    const r = await callTool(server, "dominusnode_payout_wallet_set", { address: Wallet.createRandom().address.toLowerCase(), chain: "ethereum", confirm: true });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("payout_wallet_set surfaces a server-side chain rejection", async () => {
    const server = await setup();
    const calls = route(() => jsonResponse({ error: "chain not supported on this deployment" }, 400));
    const r = await callTool(server, "dominusnode_payout_wallet_set", { address: Wallet.createRandom().address.toLowerCase(), chain: "base-sepolia", confirm: true });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("payout_wallet_set refuses to sign a tampered server message", async () => {
    const server = await setup();
    const addr = Wallet.createRandom().address.toLowerCase();
    const calls = route(() => jsonResponse({ nonce: NONCE, message: payoutWalletMessage({ userId: USER, wallet: wallet.address.toLowerCase(), address: "0x" + "9".repeat(40), chain: "base", nonce: NONCE }) }));
    const r = await callTool(server, "dominusnode_payout_wallet_set", { address: addr, confirm: true });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("payout wallet change needs DOMINUSNODE_PAYOUT_WALLET_KEY_FILE and co-signs with it", async () => {
    const addr = Wallet.createRandom().address.toLowerCase();
    const handler: Handler = (url, _i, body) => url.endsWith("/challenge")
      ? jsonResponse({ nonce: NONCE, message: payoutWalletMessage({ userId: USER, wallet: wallet.address.toLowerCase(), address: body["address"] as string, chain: "base", nonce: NONCE }), oldWalletSignatureRequired: true, oldWalletAddress: oldPayout.address.toLowerCase() })
      : jsonResponse({ payoutWallet: { address: addr, status: "pending", activeFrom: "later" }, changed: true, cooldownHours: 72 });
    let server = await setup();
    route(handler);
    const missing = await callTool(server, "dominusnode_payout_wallet_set", { address: addr, confirm: true });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("DOMINUSNODE_PAYOUT_WALLET_KEY_FILE");

    server = await setup({ payoutWalletKeyFile: keyFile("old.key", oldPayout) });
    const calls = route(handler);
    const r = await callTool(server, "dominusnode_payout_wallet_set", { address: addr, confirm: true });
    expect(r.content[0].text).toContain("72h cooldown");
    const msg = payoutWalletMessage({ userId: USER, wallet: wallet.address.toLowerCase(), address: addr, chain: "base", nonce: NONCE });
    expect(verifyMessage(msg, calls[1].body["oldWalletSignature"] as string).toLowerCase()).toBe(oldPayout.address.toLowerCase());
  });

  it("credits_withdraw signs a challenge bound to amount + key", async () => {
    const server = await setup();
    const calls = route((url, _i, body) => url.endsWith("/challenge")
      ? jsonResponse({ nonce: NONCE, message: withdrawMessage({ userId: USER, wallet: wallet.address.toLowerCase(), amountMusd: body["amountMusd"] as string, idempotencyKey: body["idempotencyKey"] as string, nonce: NONCE }) })
      : jsonResponse({ payout: { id: "p1", amount: { musd: "2000000", usd: "2.000000" }, status: "pending" }, duplicate: false }, 201));
    const r = await callTool(server, "dominusnode_credits_withdraw", { amount_musd: "2000000", idempotency_key: "wd-key-0001", confirm: true });
    expect(r.content[0].text).toContain("payout p1");
    expect(calls[1].body).toMatchObject({ amountMusd: "2000000", idempotencyKey: "wd-key-0001", nonce: NONCE });
  });

  it("credits_withdraw surfaces PAYOUTS_DISABLED and enforces $1 minimum locally", async () => {
    const server = await setup();
    route(() => jsonResponse({ error: "Payouts are currently disabled.", code: "PAYOUTS_DISABLED" }, 503));
    const r = await callTool(server, "dominusnode_credits_withdraw", { amount_musd: "2000000", confirm: true });
    expect(r.isError).toBe(true);
    const small = await callTool(server, "dominusnode_credits_withdraw", { amount_musd: "999999", confirm: true });
    expect(small.content[0].text).toContain("minimum");
  });

  it("credits_withdraw without a wallet key file errors before any request", async () => {
    const server = await setup({ walletKeyFile: null });
    const calls = route(() => jsonResponse({}));
    const r = await callTool(server, "dominusnode_credits_withdraw", { amount_musd: "2000000", confirm: true });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("node_update_caps maps args to camelCase and PATCHes", async () => {
    const server = await setup();
    const calls = route(() => jsonResponse({ id: NODE_ID, effective: { maxStreams: 8, gbPerDay: 2, reqPerSec: 200 } }));
    await callTool(server, "dominusnode_node_update_caps", { node_id: NODE_ID, max_streams: 8, gb_per_day: 2 });
    expect(calls[0].init.method).toBe("PATCH");
    expect(calls[0].body).toEqual({ maxStreams: 8, gbPerDay: 2 });
  });

  it("session_report and payouts_list hit the right routes", async () => {
    const server = await setup();
    const calls = route((url) => url.includes("/report")
      ? jsonResponse({ reportId: "7", reportsToday: 1, limitPerDay: 5 }, 201)
      : jsonResponse({ payouts: [{ id: "p1", amount: { musd: "1", usd: "0.000001" }, trigger: "auto", status: "confirmed", txHash: "0xabc", address: "0x1", createdAt: "t" }] }));
    const a = await callTool(server, "dominusnode_session_report", { session_id: NODE_ID, reason: "captcha" });
    expect(a.content[0].text).toContain("1/5");
    const b = await callTool(server, "dominusnode_payouts_list", { limit: 5, offset: 0 });
    expect(b.content[0].text).toContain("tx=0xabc");
    expect(calls[0].url).toContain(`/v1/sessions/${NODE_ID}/report`);
  });
});
