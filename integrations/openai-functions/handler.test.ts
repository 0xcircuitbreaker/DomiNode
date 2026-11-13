import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DominusNodeTools, NODE_SETUP_GUIDE, TOOL_NAMES, TOOL_SPECS, type SdkClient } from "./core.js";
import { createDominusNodeFunctionHandler, functionDeclarations, toDeclaration } from "./handler.js";

const KEY = "dn_live_" + "ab".repeat(32);
const INV = "123e4567-e89b-12d3-a456-426614174000";
const STANDARD = [
  "fetch", "proxy_url", "network_policy", "network_pricing", "network_stats", "balance", "transactions",
  "topup_crypto", "check_payment", "usage", "active_sessions", "report_session", "node_list", "node_tier",
  "node_setup_guide", "credits_balance", "credits_convert", "payouts_list", "x402_info",
];

function mockClient() {
  const fn = () => vi.fn(async () => ({ ok: true }));
  return {
    connectWithKey: vi.fn(async () => ({ mfaRequired: false })),
    proxy: { fetch: vi.fn(), buildUrl: vi.fn() },
    network: { policy: fn(), pricing: fn(), stats: fn() },
    wallet: { getBalance: fn(), getTransactions: fn(), topUpCrypto: fn(), getCryptoStatus: fn() },
    usage: { get: fn() },
    sessions: { getActive: fn(), report: fn() },
    nodes: { list: fn(), tier: fn() },
    credits: { balance: fn(), convert: fn() },
    payouts: { list: fn() },
    x402: { getInfo: fn() },
  };
}
const tools = (c: ReturnType<typeof mockClient>) => new DominusNodeTools({ apiKey: KEY, client: c as unknown as SdkClient });

const CASES: Array<[string, Record<string, unknown>, (c: ReturnType<typeof mockClient>) => ReturnType<typeof vi.fn>, unknown[]]> = [
  ["network_policy", {}, (c) => c.network.policy, []],
  ["network_pricing", {}, (c) => c.network.pricing, []],
  ["network_stats", {}, (c) => c.network.stats, []],
  ["balance", {}, (c) => c.wallet.getBalance, []],
  ["transactions", { limit: 5 }, (c) => c.wallet.getTransactions, [{ limit: 5, offset: undefined }]],
  ["topup_crypto", { amount_cents: 2000, currency: "usdc" }, (c) => c.wallet.topUpCrypto, [2000, "usdc"]],
  ["check_payment", { invoice_id: INV }, (c) => c.wallet.getCryptoStatus, [INV]],
  ["usage", { from: "2026-01-01" }, (c) => c.usage.get, [{ from: "2026-01-01", to: undefined }]],
  ["active_sessions", {}, (c) => c.sessions.getActive, []],
  ["report_session", { session_id: INV, reason: "captcha" }, (c) => c.sessions.report, [INV, "captcha"]],
  ["node_list", { limit: 3, offset: 1 }, (c) => c.nodes.list, [{ limit: 3, offset: 1 }]],
  ["node_tier", {}, (c) => c.nodes.tier, []],
  ["credits_balance", {}, (c) => c.credits.balance, []],
  ["payouts_list", {}, (c) => c.payouts.list, [{ limit: undefined, offset: undefined }]],
  ["x402_info", {}, (c) => c.x402.getInfo, []],
];

describe("tool registration", () => {
  it("core exposes exactly the 19 standard tools", () => {
    expect(TOOL_NAMES).toEqual(STANDARD);
  });
  it("function declarations are the 19 prefixed tools", () => {
    expect(functionDeclarations.map((d) => d.name)).toEqual(STANDARD.map((n) => "dominusnode_" + n));
  });
  it("functions.json matches the generated declarations", () => {
    const json = JSON.parse(readFileSync(new URL("./functions.json", import.meta.url), "utf8"));
    expect(json).toEqual(TOOL_SPECS.map(toDeclaration));
  });
  it("no schema has a key/token parameter or a key value", () => {
    for (const s of TOOL_SPECS) {
      expect(Object.keys(s.parameters.properties).filter((p) => ["api_key", "apiKey", "key", "token", "password"].includes(p))).toEqual([]);
    }
    expect(JSON.stringify(functionDeclarations)).not.toContain("dn_live_");
    expect(JSON.stringify(functionDeclarations).toLowerCase()).not.toMatch(/stripe|paypal/);
  });
});

describe("dispatch to SDK", () => {
  it.each(CASES)("%s calls the right SDK method", async (name, args, pick, expected) => {
    const c = mockClient();
    const out = JSON.parse(await tools(c).call(name, args));
    expect(out).toEqual({ ok: true });
    expect(pick(c)).toHaveBeenCalledWith(...expected);
  });

  it("credits_convert points to a signer and makes no SDK call", async () => {
    const c = mockClient();
    const out = JSON.parse(await tools(c).call("credits_convert", { amount_musd: "50000" }));
    expect(out.status).toBe("signing_required");
    expect(out.message).toContain("signer key file");
    expect(c.credits.convert).not.toHaveBeenCalled();
  });

  it("fetch uses proxy.fetch with routing flags", async () => {
    const c = mockClient();
    c.proxy.fetch.mockResolvedValue({ status: 200, statusText: "OK", headers: { "content-type": "text/plain" }, truncated: false, text: () => "hi" });
    const out = JSON.parse(await tools(c).call("dominusnode_fetch", { url: "https://example.com", country: "US", ip_class: "dc" }));
    expect(out.status).toBe(200);
    expect(out.body).toBe("hi");
    expect(c.proxy.fetch).toHaveBeenCalledWith("https://example.com", { method: "GET", country: "US", ipClass: "dc", sessionId: undefined, allowHttp: false });
  });

  it("proxy_url never returns the key", async () => {
    const c = mockClient();
    c.proxy.buildUrl.mockReturnValue(`https://country-US:${KEY}@proxy.dominusnode.com:8443`);
    const raw = await tools(c).call("proxy_url", { country: "US" });
    expect(raw).not.toContain(KEY);
    expect(JSON.parse(raw).proxyUrl).toBe("https://country-US:${DOMINUSNODE_API_KEY}@proxy.dominusnode.com:8443");
  });

  it("node_setup_guide is static", async () => {
    const c = mockClient();
    expect(JSON.parse(await tools(c).call("node_setup_guide")).guide).toBe(NODE_SETUP_GUIDE);
  });

  it("connects lazily with the env key", async () => {
    const c = mockClient();
    const prev = process.env.DOMINUSNODE_API_KEY;
    process.env.DOMINUSNODE_API_KEY = KEY;
    try {
      const t = new DominusNodeTools();
      const h = createDominusNodeFunctionHandler({ client: c as unknown as SdkClient, connect: true });
      await h("dominusnode_network_pricing", {});
      expect(c.connectWithKey).toHaveBeenCalledWith(KEY);
      expect(String(t)).not.toContain(KEY);
      expect(JSON.stringify(t)).not.toContain(KEY);
    } finally {
      if (prev === undefined) delete process.env.DOMINUSNODE_API_KEY; else process.env.DOMINUSNODE_API_KEY = prev;
    }
  });
});

describe("scrubbing", () => {
  it("scrubs credentials from errors", async () => {
    const c = mockClient();
    c.wallet.getBalance.mockRejectedValue(new Error(`boom ${KEY} dn_test_${"c".repeat(64)} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc`));
    const raw = await tools(c).call("balance");
    expect(raw).not.toMatch(/dn_live_|dn_test_|eyJ/);
    expect(JSON.parse(raw).error).toBeTruthy();
  });
  it("scrubs the key from outputs", async () => {
    const c = mockClient();
    c.network.stats.mockResolvedValue({ echo: KEY });
    expect(await tools(c).call("network_stats")).not.toContain(KEY);
  });
  it("rejects unknown tools and extra args", async () => {
    const c = mockClient();
    expect(JSON.parse(await tools(c).call("topup_stripe")).error).toBeTruthy();
    expect(JSON.parse(await tools(c).call("balance", { api_key: KEY })).error).toBeTruthy();
  });
  it("reports a missing key", async () => {
    const prev = process.env.DOMINUSNODE_API_KEY;
    delete process.env.DOMINUSNODE_API_KEY;
    try {
      expect(JSON.parse(await new DominusNodeTools().call("balance")).error).toContain("DOMINUSNODE_API_KEY");
    } finally {
      if (prev !== undefined) process.env.DOMINUSNODE_API_KEY = prev;
    }
  });
});
