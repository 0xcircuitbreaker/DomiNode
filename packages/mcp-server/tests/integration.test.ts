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

  it("registers all authenticated-mode tools", async () => {
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
    // check_payment re-enabled — backend endpoint exists at /api/wallet/crypto/status/:invoiceId
    expect(toolNames).toContain("dominusnode_check_payment");
    expect(toolNames).toContain("dominusnode_x402_info");
    expect(toolNames).toContain("dominusnode_agent_wallet_create");
    expect(toolNames).toContain("dominusnode_agent_wallet_balance");
    expect(toolNames).toContain("dominusnode_agent_wallet_fund");
    expect(toolNames).toContain("dominusnode_agent_wallet_list");
    expect(toolNames).toContain("dominusnode_agent_wallet_transactions");

    // Teams tools (17: 15 original + 2 new update tools)
    expect(toolNames).toContain("dominusnode_create_team");
    expect(toolNames).toContain("dominusnode_list_teams");
    expect(toolNames).toContain("dominusnode_team_details");
    expect(toolNames).toContain("dominusnode_team_update");
    expect(toolNames).toContain("dominusnode_team_update_member_role");
    expect(toolNames).toContain("dominusnode_team_add_member");
    expect(toolNames).toContain("dominusnode_team_remove_member");
    expect(toolNames).toContain("dominusnode_team_fund");
    expect(toolNames).toContain("dominusnode_team_create_key");
    expect(toolNames).toContain("dominusnode_team_revoke_key");
    expect(toolNames).toContain("dominusnode_team_usage");
    expect(toolNames).toContain("dominusnode_team_list_members");
    expect(toolNames).toContain("dominusnode_team_invite_member");
    expect(toolNames).toContain("dominusnode_team_list_invites");
    expect(toolNames).toContain("dominusnode_team_cancel_invite");
    expect(toolNames).toContain("dominusnode_team_list_keys");
    expect(toolNames).toContain("dominusnode_team_delete");

    // Wallet auth tools (3)
    expect(toolNames).toContain("dominusnode_wallet_challenge");
    expect(toolNames).toContain("dominusnode_register_wallet");
    expect(toolNames).toContain("dominusnode_wallet_setup");

    // Slots tools (3)
    expect(toolNames).toContain("dominusnode_check_slots");
    expect(toolNames).toContain("dominusnode_join_waitlist");
    expect(toolNames).toContain("dominusnode_get_waitlist_count");

    // Email verification tools (2)
    expect(toolNames).toContain("dominusnode_verify_email");
    expect(toolNames).toContain("dominusnode_resend_verification");

    // Account management tool (1)
    expect(toolNames).toContain("dominusnode_update_password");

    // Agent wallet freeze/unfreeze/delete tools (3)
    expect(toolNames).toContain("dominusnode_agent_wallet_freeze");
    expect(toolNames).toContain("dominusnode_agent_wallet_unfreeze");
    expect(toolNames).toContain("dominusnode_agent_wallet_delete");
    expect(toolNames).toContain("dominusnode_update_wallet_policy");

    // Total: 57 tools (54 + team_update + team_update_member_role + update_wallet_policy)
    expect(toolNames.length).toBe(57);
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

    // Bootstrap mode registers account + crypto + wallet-auth + slots tools
    // Agent-wallet tools are NOT registered in bootstrap mode (require auth).
    registerAccountTools(server, httpClient);
    registerCryptoTools(server, httpClient);
    registerWalletAuthTools(server, httpClient);
    registerSlotsTools(server, httpClient);

    const tools = (server as any)._registeredTools;
    const toolNames = Object.keys(tools);

    // account(7) + crypto(2, check_payment re-enabled) + wallet-auth(3) + slots(3) = 15
    expect(toolNames).toContain("dominusnode_get_account_info");
    expect(toolNames).toContain("dominusnode_register");
    expect(toolNames).toContain("dominusnode_login");
    expect(toolNames).toContain("dominusnode_setup");
    expect(toolNames).toContain("dominusnode_update_password");
    expect(toolNames).toContain("dominusnode_verify_email");
    expect(toolNames).toContain("dominusnode_resend_verification");
    expect(toolNames).toContain("dominusnode_pay_crypto");
    // check_payment re-enabled
    expect(toolNames).toContain("dominusnode_check_payment");
    // agent-wallet tools should NOT be present in bootstrap mode
    expect(toolNames).not.toContain("dominusnode_agent_wallet_create");
    expect(toolNames).not.toContain("dominusnode_agent_wallet_fund");
    expect(toolNames).not.toContain("dominusnode_agent_wallet_list");
    expect(toolNames).toContain("dominusnode_wallet_challenge");
    expect(toolNames).toContain("dominusnode_register_wallet");
    expect(toolNames).toContain("dominusnode_wallet_setup");
    expect(toolNames).toContain("dominusnode_check_slots");
    expect(toolNames).toContain("dominusnode_join_waitlist");
    expect(toolNames).toContain("dominusnode_get_waitlist_count");
    expect(toolNames.length).toBe(15);
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
