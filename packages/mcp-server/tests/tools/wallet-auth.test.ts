import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HttpClient } from "../../src/http-client.js";
import { TokenManager } from "../../src/token-manager.js";
import { registerWalletAuthTools, _resetWalletAuthLimits, isSignInMessage } from "../../src/tools/wallet-auth.js";
import { Wallet, verifyMessage } from "ethers";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpConfig } from "../../src/config.js";

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

  const ok = (body: unknown, status = 200) => ({
    ok: true, status, text: () => Promise.resolve(JSON.stringify(body)), headers: new Headers(),
  } as unknown as Response);
  const fail = (status = 401) => ({
    ok: false, status, text: () => Promise.resolve(JSON.stringify({ error: "Signature verification failed" })), headers: new Headers(),
  } as unknown as Response);
  const verifyBody = (addr: string) => ({
    token: makeJwt(Math.floor(Date.now() / 1000) + 600), refreshToken: "rt",
    user: { id: "u1", email: "x", wallet_address: addr, isNewUser: false },
  });

  it("challenge points to dominusnode_wallet_setup", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce(ok({ message: "m", nonce: "n" }));
    const r = await (server as any)._registeredTools["dominusnode_wallet_challenge"].handler({ address: VALID_ADDRESS }, {} as never);
    expect(r.content[0].text).toContain("call dominusnode_wallet_setup");
  });

  it("successful verifications do not count toward the rate limit; failures do", async () => {
    const tools = (server as any)._registeredTools;
    for (let i = 0; i < 8; i++) {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(ok(verifyBody(VALID_ADDRESS)));
      const r = await tools["dominusnode_register_wallet"].handler({ address: VALID_ADDRESS, signature: VALID_SIGNATURE }, {} as never);
      expect(r.isError).toBeFalsy();
    }
    for (let i = 0; i < 5; i++) {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(fail());
      const r = await tools["dominusnode_register_wallet"].handler({ address: VALID_ADDRESS, signature: VALID_SIGNATURE }, {} as never);
      expect(r.content[0].text).toContain("Verification error");
    }
    globalThis.fetch = vi.fn();
    const r = await tools["dominusnode_register_wallet"].handler({ address: VALID_ADDRESS, signature: VALID_SIGNATURE }, {} as never);
    expect(r.content[0].text).toMatch(/Too many failed/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  describe("wallet_setup with DOMINUSNODE_WALLET_KEY_FILE", () => {
    const wallet = Wallet.createRandom();
    let dir: string;
    let keyFile: string;
    const signIn = (addr: string, nonce: string) => [
      "api.example.com wants you to sign in with your Ethereum account:", addr, "",
      "Sign in to Dominus Node proxy service", "", "URI: https://api.example.com",
      `Nonce: ${nonce}`, "Issued At: 2026-11-12T00:00:00.000Z",
    ].join("\n");

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-wa-"));
      keyFile = path.join(dir, "wallet.key");
      fs.writeFileSync(keyFile, wallet.privateKey, { mode: 0o600 });
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("signs the standard sign-in message, creates a key and unlocks tools", async () => {
      const s2 = new McpServer({ name: "t", version: "1" });
      const unlocked: string[] = [];
      registerWalletAuthTools(s2, httpClient, {
        config: { walletKeyFile: keyFile } as McpConfig,
        onAuthenticated: (k) => { unlocked.push(k); return true; },
      });
      const msg = signIn(wallet.address, "n1");
      const f = vi.fn()
        .mockResolvedValueOnce(ok({ message: msg, nonce: "n1" }))
        .mockResolvedValueOnce(ok(verifyBody(wallet.address)))
        .mockResolvedValueOnce(ok({ id: "k", key: "dn_live_newkey", label: "l" }));
      globalThis.fetch = f as never;
      const r = await (s2 as any)._registeredTools["dominusnode_wallet_setup"].handler({ key_label: "l" }, {} as never);
      expect(r.isError).toBeFalsy();
      expect(r.content[0].text).toContain("now available in this session");
      expect(unlocked).toEqual(["dn_live_newkey"]);
      const sent = JSON.parse(f.mock.calls[1][1].body);
      expect(verifyMessage(msg, sent.signature)).toBe(wallet.address);
    });

    it("refuses to sign a non-sign-in message", async () => {
      const s2 = new McpServer({ name: "t", version: "1" });
      registerWalletAuthTools(s2, httpClient, { config: { walletKeyFile: keyFile } as McpConfig });
      const f = vi.fn().mockResolvedValueOnce(ok({ message: "Withdraw 100 USDC to 0xabc\nNonce: n1", nonce: "n1" }));
      globalThis.fetch = f as never;
      const r = await (s2 as any)._registeredTools["dominusnode_wallet_setup"].handler({ key_label: "l" }, {} as never);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Refusing to sign");
      expect(f).toHaveBeenCalledTimes(1);
    });

    it("requires a signature when no key file is configured", async () => {
      const r = await (server as any)._registeredTools["dominusnode_wallet_setup"].handler({ address: VALID_ADDRESS, key_label: "l" }, {} as never);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("DOMINUSNODE_WALLET_KEY_FILE");
    });

    it("isSignInMessage checks address and nonce", () => {
      expect(isSignInMessage(signIn(wallet.address, "n"), wallet.address, "n")).toBe(true);
      expect(isSignInMessage(signIn(wallet.address, "n"), VALID_ADDRESS, "n")).toBe(false);
      expect(isSignInMessage(signIn(wallet.address, "n"), wallet.address, "x")).toBe(false);
    });
  });
});
