import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http-client.js";
import { TokenManager } from "../../src/token-manager.js";
import { registerWalletAuthTools, _resetWalletAuthLimits } from "../../src/tools/wallet-auth.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "u1" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("wallet-auth tools", () => {
  let server: McpServer;
  let httpClient: HttpClient;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    _resetWalletAuthLimits();
    const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
    const tm = new TokenManager("http://localhost:3000");
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt" })),
    } as unknown as Response);
    await tm.initialize("dn_live_test");

    httpClient = new HttpClient("http://localhost:3000", tm);
    server = new McpServer({ name: "test", version: "1.0.0" });
    registerWalletAuthTools(server, httpClient);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const VALID_ADDRESS = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  const VALID_SIGNATURE = "0x" + "a".repeat(128) + "1b";

  it("dominusnode_wallet_challenge returns challenge message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        message: "Sign in to Dominus Node",
        nonce: "abc123",
      })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_wallet_challenge"].handler(
      { address: VALID_ADDRESS },
      { sessionId: "" } as never,
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Wallet Challenge Issued");
    expect(text).toContain("Sign this message");
    expect(text).toContain("abc123");
  });

  it("dominusnode_wallet_challenge handles error", async () => {
    const errorResponse = {
      ok: false,
      status: 400,
      text: () => Promise.resolve(JSON.stringify({ error: "Invalid address" })),
      headers: new Headers(),
    } as unknown as Response;
    globalThis.fetch = vi.fn().mockResolvedValueOnce(errorResponse);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_wallet_challenge"].handler(
      { address: VALID_ADDRESS },
      { sessionId: "" } as never,
    );
    expect(result.isError).toBe(true);
  });

  it("dominusnode_register_wallet returns account info for new user", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: () => Promise.resolve(JSON.stringify({
        token: "at",
        refreshToken: "rt",
        user: {
          id: "u-new",
          email: `${VALID_ADDRESS}@wallet.dominusnode.com`,
          wallet_address: VALID_ADDRESS,
          isNewUser: true,
        },
      })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_register_wallet"].handler(
      { address: VALID_ADDRESS, signature: VALID_SIGNATURE },
      { sessionId: "" } as never,
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Wallet Authentication Successful");
    expect(text).toContain("Account created");
    expect(text).toContain(VALID_ADDRESS);
  });

  it("dominusnode_register_wallet shows login for existing user", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({
        token: "at",
        refreshToken: "rt",
        user: {
          id: "u-existing",
          email: `${VALID_ADDRESS}@wallet.dominusnode.com`,
          wallet_address: VALID_ADDRESS,
          isNewUser: false,
        },
      })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_register_wallet"].handler(
      { address: VALID_ADDRESS, signature: VALID_SIGNATURE },
      { sessionId: "" } as never,
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Logged in");
  });

  it("dominusnode_wallet_setup returns full config", async () => {
    // First call: verify wallet
    // Second call: create API key
    const validJwt = makeJwt(Math.floor(Date.now() / 1000) + 600);
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: () => Promise.resolve(JSON.stringify({
          token: validJwt,
          refreshToken: "rt-wallet",
          user: {
            id: "u-new",
            email: `${VALID_ADDRESS}@wallet.dominusnode.com`,
            wallet_address: VALID_ADDRESS,
            isNewUser: true,
          },
        })),
        headers: new Headers(),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({
          id: "key-1",
          key: "dn_live_testkey",
          label: "ai-agent-wallet",
        })),
        headers: new Headers(),
      } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_wallet_setup"].handler(
      { address: VALID_ADDRESS, signature: VALID_SIGNATURE, key_label: "ai-agent-wallet" },
      { sessionId: "" } as never,
    );
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Wallet Setup Complete");
    expect(text).toContain("dn_live_testkey");
    expect(text).toContain("ai-agent-wallet");
    expect(text).toContain(VALID_ADDRESS);
  });

  it("dominusnode_wallet_setup handles verify error", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: () => Promise.resolve(JSON.stringify({ error: "Signature verification failed" })),
      headers: new Headers(),
    } as unknown as Response);

    const tools = (server as any)._registeredTools;
    const result = await tools["dominusnode_wallet_setup"].handler(
      { address: VALID_ADDRESS, signature: VALID_SIGNATURE, key_label: "test" },
      { sessionId: "" } as never,
    );
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain("Wallet setup error");
  });
});
