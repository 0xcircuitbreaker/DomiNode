import { describe, it, expect } from "vitest";
import { mockClient, provider, TEST_KEY } from "./helpers.js";
import {
  ClientProvider,
  createToolSpecs,
  runTool,
  safeError,
  STANDARD_TOOL_NAMES,
  NODE_SETUP_GUIDE,
} from "../src/core.js";

const UUID = "123e4567-e89b-12d3-a456-426614174000";

const CASES: Array<[string, Record<string, unknown>, (c: ReturnType<typeof mockClient>) => unknown, unknown[]]> = [
  ["fetch", { url: "https://example.com", country: "us", ip_class: "dc", session_id: "s1", allow_http: false }, (c) => c.proxy.fetch,
    ["https://example.com", { method: "GET", country: "US", ipClass: "dc", sessionId: "s1", allowHttp: false }]],
  ["proxy_url", { country: "US", protocol: "socks5" }, (c) => c.proxy.buildUrl,
    [{ country: "US", ipClass: undefined, sessionId: undefined, allowHttp: undefined, protocol: "socks5" }]],
  ["network_policy", {}, (c) => c.network.policy, []],
  ["network_pricing", {}, (c) => c.network.pricing, []],
  ["network_stats", {}, (c) => c.network.stats, []],
  ["balance", {}, (c) => c.wallet.getBalance, []],
  ["transactions", { limit: 5 }, (c) => c.wallet.getTransactions, [{ limit: 5, offset: undefined }]],
  ["topup_crypto", { amount_cents: 2000, currency: "usdc" }, (c) => c.wallet.topUpCrypto, [2000, "usdc"]],
  ["check_payment", { invoice_id: UUID }, (c) => c.wallet.getCryptoStatus, [UUID]],
  ["usage", { from: "2026-01-01", limit: 10 }, (c) => c.usage.get, [{ from: "2026-01-01", to: undefined, limit: 10 }]],
  ["active_sessions", {}, (c) => c.sessions.getActive, []],
  ["report_session", { session_id: UUID, reason: "captcha" }, (c) => c.sessions.report, [UUID, "captcha"]],
  ["node_list", { limit: 3, offset: 1 }, (c) => c.nodes.list, [{ limit: 3, offset: 1 }]],
  ["node_tier", {}, (c) => c.nodes.tier, []],
  ["credits_balance", {}, (c) => c.credits.balance, []],
  ["credits_convert", { amount_musd: "5000000", idempotency_key: "abcdefgh12" }, (c) => c.credits.convert,
    ["5000000", { idempotencyKey: "abcdefgh12" }]],
  ["payouts_list", { limit: 2 }, (c) => c.payouts.list, [{ limit: 2, offset: undefined }]],
  ["x402_info", {}, (c) => c.x402.getInfo, []],
];

describe("core tool specs", () => {
  const specs = createToolSpecs();
  const byName = new Map(specs.map((s) => [s.name, s]));

  it("defines exactly the 19 standard tools", () => {
    expect(specs.map((s) => s.name)).toEqual([...STANDARD_TOOL_NAMES]);
    expect(STANDARD_TOOL_NAMES).toHaveLength(19);
  });

  it.each(CASES)("%s calls the right SDK method", async (name, args, pick, expected) => {
    const { client, provider: p } = provider();
    const out = await runTool(byName.get(name as never)!, p, args);
    expect(out.startsWith("Error")).toBe(false);
    expect(pick(client)).toHaveBeenCalledWith(...expected);
    expect(out).not.toContain(TEST_KEY);
  });

  it("node_setup_guide is static and needs no connection", async () => {
    const { client, provider: p } = provider();
    const out = await runTool(byName.get("node_setup_guide")!, p, {});
    expect(JSON.parse(out).guide).toBe(NODE_SETUP_GUIDE);
    expect(client.connectWithKey).not.toHaveBeenCalled();
  });

  it("public tools do not connect; account tools connect once", async () => {
    const { client, provider: p } = provider();
    await runTool(byName.get("network_pricing")!, p, {});
    expect(client.connectWithKey).not.toHaveBeenCalled();
    await runTool(byName.get("balance")!, p, {});
    await runTool(byName.get("usage")!, p, {});
    expect(client.connectWithKey).toHaveBeenCalledTimes(1);
    expect(client.connectWithKey).toHaveBeenCalledWith(TEST_KEY);
  });

  it("proxy_url never returns the API key", async () => {
    const { provider: p } = provider();
    const out = JSON.parse(await runTool(byName.get("proxy_url")!, p, { country: "US" }));
    expect(out.proxyUrl).toBe("http://country-US:${DOMINUSNODE_API_KEY}@proxy.dominusnode.daedalusdevelopmentgroup.com:8080");
  });

  it("scrubs credentials from errors and results", async () => {
    const { client, provider: p } = provider();
    client.wallet.getBalance.mockRejectedValueOnce(new Error(`bad key ${TEST_KEY} jwt eyJabc.eyJdef.sig node dn_node_${"a".repeat(64)}`));
    const err = await runTool(byName.get("balance")!, p, {});
    expect(err.startsWith("Error:")).toBe(true);
    expect(err).not.toContain(TEST_KEY);
    expect(err).not.toContain("eyJabc");
    expect(err).not.toContain("dn_node_");
    client.network.stats.mockResolvedValueOnce({ note: `leak ${TEST_KEY}` });
    expect(await runTool(byName.get("network_stats")!, p, {})).not.toContain(TEST_KEY);
    expect(safeError("x dn_proxy_abcdef")).toBe("Error: x [REDACTED]");
  });

  it("missing API key gives a clear error and no request", async () => {
    const prev = process.env.DOMINUSNODE_API_KEY;
    delete process.env.DOMINUSNODE_API_KEY;
    const client = mockClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = new ClientProvider({ client: client as any });
    const out = await runTool(byName.get("balance")!, p, {});
    expect(out).toContain("DOMINUSNODE_API_KEY is not set");
    expect(client.wallet.getBalance).not.toHaveBeenCalled();
    if (prev !== undefined) process.env.DOMINUSNODE_API_KEY = prev;
  });

  it("no tool takes an api key argument and schemas contain no key", () => {
    for (const s of specs) {
      expect(Object.keys(s.parameters.properties).some((k) => /key|token|secret|password/i.test(k) && k !== "idempotency_key")).toBe(false);
    }
    expect(JSON.stringify(specs)).not.toMatch(/dn_live_[A-Za-z0-9]/);
  });

  it("descriptions carry no hardcoded prices or legacy features", () => {
    const all = JSON.stringify(specs.map((s) => s.description));
    expect(all).not.toMatch(/\$3|\$5\/GB|stripe|paypal|dc-country|residential-country|\bplan\b/i);
    expect(byName.get("network_pricing")!.description).toMatch(/price/i);
  });

  it("provider never prints the key", () => {
    const { provider: p } = provider();
    expect(String(p)).not.toContain(TEST_KEY);
    expect(JSON.stringify(p)).not.toContain(TEST_KEY);
  });
});
