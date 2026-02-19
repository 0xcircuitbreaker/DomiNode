import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TokenManager } from "../src/token-manager.js";
import { HttpClient } from "../src/http-client.js";
import type { McpConfig } from "../src/config.js";
import { registerFetchTools } from "../src/tools/fetch.js";
import { registerProxyTools } from "../src/tools/proxy.js";
import { registerWalletTools } from "../src/tools/wallet.js";
import { registerUsageTools } from "../src/tools/usage.js";
import { registerKeysTools } from "../src/tools/keys.js";
import { registerPlansTools } from "../src/tools/plans.js";
import { registerSessionsTools } from "../src/tools/sessions.js";
import { registerAccountTools } from "../src/tools/account.js";
import { registerCryptoTools } from "../src/tools/crypto.js";
import { registerAgentWalletTools } from "../src/tools/agent-wallet.js";
import { registerTeamsTools } from "../src/tools/teams.js";
import { registerWalletAuthTools } from "../src/tools/wallet-auth.js";
import { registerSlotsTools } from "../src/tools/slots.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("MCP Server Integration", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("registers all 41 tools in authenticated mode", async () => {
    const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
    const tm = new TokenManager("http://localhost:3000");
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt" })),
    } as unknown as Response);
    await tm.initialize("dn_live_test");

    const httpClient = new HttpClient("http://localhost:3000", tm);
    const config: McpConfig = {
      apiKey: "dn_live_test",
      apiUrl: "http://localhost:3000",
      proxyHost: "localhost",
      httpProxyPort: 8080,
      socks5ProxyPort: 1080,
      fetchTimeoutMs: 30000,
      fetchMaxResponseBytes: 5 * 1024 * 1024,
    };

    const server = new McpServer({ name: "dominusnode", version: "1.0.0" });

    registerFetchTools(server, config);
    registerProxyTools(server, httpClient);
    registerWalletTools(server, httpClient);
    registerUsageTools(server, httpClient);
    registerKeysTools(server, httpClient);
    registerPlansTools(server, httpClient);
    registerSessionsTools(server, httpClient);
    registerAccountTools(server, httpClient);
    registerCryptoTools(server, httpClient);
    registerAgentWalletTools(server, httpClient, config);
    registerTeamsTools(server, httpClient);
    registerWalletAuthTools(server, httpClient);
    registerSlotsTools(server, httpClient);

    const tools = (server as any)._registeredTools;
    const toolNames = Object.keys(tools);

    // Original 19 tools
    expect(toolNames).toContain("dominusnode_fetch");
    expect(toolNames).toContain("dominusnode_get_balance");
    expect(toolNames).toContain("dominusnode_get_forecast");
    expect(toolNames).toContain("dominusnode_get_transactions");
    expect(toolNames).toContain("dominusnode_get_usage");
    expect(toolNames).toContain("dominusnode_get_daily_usage");
    expect(toolNames).toContain("dominusnode_get_top_hosts");
    expect(toolNames).toContain("dominusnode_list_keys");
    expect(toolNames).toContain("dominusnode_create_key");
    expect(toolNames).toContain("dominusnode_revoke_key");
    expect(toolNames).toContain("dominusnode_get_proxy_config");
    expect(toolNames).toContain("dominusnode_get_proxy_status");
    expect(toolNames).toContain("dominusnode_get_plan");
    expect(toolNames).toContain("dominusnode_list_plans");
    expect(toolNames).toContain("dominusnode_get_active_sessions");
    expect(toolNames).toContain("dominusnode_get_account_info");
    expect(toolNames).toContain("dominusnode_register");
    expect(toolNames).toContain("dominusnode_login");
    expect(toolNames).toContain("dominusnode_setup");

    // New crypto + agent wallet tools
    expect(toolNames).toContain("dominusnode_pay_crypto");
    // dominusnode_check_payment commented out — backend endpoint doesn't exist yet
    expect(toolNames).toContain("dominusnode_x402_info");
    expect(toolNames).toContain("dominusnode_agent_wallet_create");
    expect(toolNames).toContain("dominusnode_agent_wallet_balance");
    expect(toolNames).toContain("dominusnode_agent_wallet_fund");
    expect(toolNames).toContain("dominusnode_agent_wallet_list");
    expect(toolNames).toContain("dominusnode_agent_wallet_transactions");

    // Teams tools (8)
    expect(toolNames).toContain("dominusnode_create_team");
    expect(toolNames).toContain("dominusnode_list_teams");
    expect(toolNames).toContain("dominusnode_team_details");
    expect(toolNames).toContain("dominusnode_team_add_member");
    expect(toolNames).toContain("dominusnode_team_remove_member");
    expect(toolNames).toContain("dominusnode_team_fund");
    expect(toolNames).toContain("dominusnode_team_create_key");
    expect(toolNames).toContain("dominusnode_team_usage");

    // Wallet auth tools (3)
    expect(toolNames).toContain("dominusnode_wallet_challenge");
    expect(toolNames).toContain("dominusnode_register_wallet");
    expect(toolNames).toContain("dominusnode_wallet_setup");

    // Slots tools (3)
    expect(toolNames).toContain("dominusnode_check_slots");
    expect(toolNames).toContain("dominusnode_join_waitlist");
    expect(toolNames).toContain("dominusnode_get_waitlist_count");

    expect(toolNames.length).toBe(40);
  });

  it("registers only bootstrap tools when no API key", async () => {
    const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
    const tm = new TokenManager("http://localhost:3000");
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt" })),
    } as unknown as Response);
    await tm.initialize("dn_live_test");

    const httpClient = new HttpClient("http://localhost:3000", tm);
    const config: McpConfig = {
      apiKey: null,
      apiUrl: "http://localhost:3000",
      proxyHost: "localhost",
      httpProxyPort: 8080,
      socks5ProxyPort: 1080,
      fetchTimeoutMs: 30000,
      fetchMaxResponseBytes: 5 * 1024 * 1024,
    };

    const server = new McpServer({ name: "dominusnode", version: "1.0.0" });

    // Bootstrap mode registers account + crypto + agent wallet + wallet-auth + slots tools
    registerAccountTools(server, httpClient);
    registerCryptoTools(server, httpClient);
    registerAgentWalletTools(server, httpClient, config);
    registerWalletAuthTools(server, httpClient);
    registerSlotsTools(server, httpClient);

    const tools = (server as any)._registeredTools;
    const toolNames = Object.keys(tools);

    // account(4) + crypto(2) + agent-wallet(6) + wallet-auth(3) + slots(3) = 18
    expect(toolNames).toContain("dominusnode_register");
    expect(toolNames).toContain("dominusnode_login");
    expect(toolNames).toContain("dominusnode_setup");
    expect(toolNames).toContain("dominusnode_pay_crypto");
    expect(toolNames).toContain("dominusnode_x402_info");
    expect(toolNames).toContain("dominusnode_agent_wallet_create");
    expect(toolNames).toContain("dominusnode_agent_wallet_fund");
    expect(toolNames).toContain("dominusnode_agent_wallet_list");
    expect(toolNames).toContain("dominusnode_wallet_challenge");
    expect(toolNames).toContain("dominusnode_register_wallet");
    expect(toolNames).toContain("dominusnode_wallet_setup");
    expect(toolNames).toContain("dominusnode_check_slots");
    expect(toolNames).toContain("dominusnode_join_waitlist");
    expect(toolNames).toContain("dominusnode_get_waitlist_count");
    expect(toolNames.length).toBe(17);
  });

  it("tool error handling returns isError without throwing", async () => {
    const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
    const tm = new TokenManager("http://localhost:3000");
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt" })),
    } as unknown as Response);
    await tm.initialize("dn_live_test");

    const httpClient = new HttpClient("http://localhost:3000", tm);
    const server = new McpServer({ name: "test", version: "1.0.0" });
    registerWalletTools(server, httpClient);

    // Mock a network failure
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_get_balance"].handler({}, { sessionId: "" } as never);
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toContain("ECONNREFUSED");
  });
});
