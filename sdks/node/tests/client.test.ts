import { describe, it, expect } from "vitest";
import { inspect } from "node:util";
import { DominusNodeClient } from "../src/client.js";
import { TokenManager } from "../src/token-manager.js";
import { Secret } from "../src/secret.js";
import { ValidationError, AuthenticationError } from "../src/errors.js";
import { mockFetch, makeJwt, API_KEY, USER_ID, connected } from "./helpers.js";

describe("DominusNodeClient", () => {
  it("connectWithKey stores key + JWT", async () => {
    const { client, calls } = await connected([200, { user: { id: USER_ID } }], [200, {}]);
    expect(client.isConnected).toBe(true);
    await client.auth.me();
    expect(calls[0].headers.Authorization).toMatch(/^Bearer eyJ/);
    await client.credits.balance();
    expect(calls[1].headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("connectWithKey rejects malformed keys before any request", async () => {
    const m = mockFetch();
    await expect(new DominusNodeClient({ fetch: m.fn }).connectWithKey("sk_bad")).rejects.toBeInstanceOf(ValidationError);
    expect(m.calls).toHaveLength(0);
  });

  it("connectWithKey surfaces mfaRequired and keeps the key for /v1 routes", async () => {
    const m = mockFetch([403, { valid: false, error: "MFA is enabled.", mfaRequired: true }], [200, { pending: {} }]);
    const c = new DominusNodeClient({ baseUrl: "http://api.test", fetch: m.fn });
    expect(await c.connectWithKey(API_KEY)).toEqual({ mfaRequired: true });
    await c.credits.balance();
    expect(m.calls[1].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    await expect(c.auth.me()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("connectWithKey propagates other errors", async () => {
    const m = mockFetch([401, { error: "Invalid API key" }]);
    const c = new DominusNodeClient({ baseUrl: "http://api.test", fetch: m.fn });
    await expect(c.connectWithKey(API_KEY)).rejects.toBeInstanceOf(AuthenticationError);
    expect(c.isConnected).toBe(false);
  });

  it("disconnect revokes and clears every credential", async () => {
    const { client, calls } = await connected([200, {}]);
    await client.disconnect();
    expect(calls[0].url).toBe("http://api.test/api/auth/logout");
    expect(client.isConnected).toBe(false);
    await expect(client.credits.balance()).rejects.toBeInstanceOf(AuthenticationError);
    expect(() => client.proxy.buildUrl()).toThrow(AuthenticationError);
  });

  it("disconnect succeeds when logout fails", async () => {
    const { client } = await connected([500, { error: "down" }]);
    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it("can reconnect after disconnect (refreshFn survives clear)", async () => {
    const { client } = await connected([200, {}]);
    await client.disconnect();
    expect(client.isConnected).toBe(false);
  });

  it("accepts tokens via config", async () => {
    const m = mockFetch([200, { user: {} }]);
    const c = new DominusNodeClient({ baseUrl: "http://api.test", fetch: m.fn, accessToken: makeJwt(), refreshToken: makeJwt(86400) });
    await c.auth.me();
    expect(m.calls[0].headers.Authorization).toMatch(/^Bearer eyJ/);
  });

  it("never prints credentials", async () => {
    const { client } = await connected();
    for (const s of [String(client), JSON.stringify(client), inspect(client, { depth: 10, showHidden: true })]) {
      expect(s).not.toContain("dn_live_");
      expect(s).not.toContain("eyJ");
    }
  });
});

describe("TokenManager", () => {
  it("clear() keeps refreshFn", () => {
    const tm = new TokenManager();
    tm.setRefreshFunction(async () => ({ accessToken: "a" }));
    tm.setTokens("x", "y");
    tm.clear();
    expect(tm.getAccessToken()).toBeNull();
    expect(tm.getRefreshToken()).toBeNull();
    expect(tm.hasRefreshFunction()).toBe(true);
  });

  it("refreshes expired tokens once for concurrent callers", async () => {
    const tm = new TokenManager();
    let n = 0;
    tm.setRefreshFunction(async () => { n++; return { accessToken: makeJwt(), refreshToken: "r2" }; });
    tm.setTokens(makeJwt(-10), "r1");
    const [a, b] = await Promise.all([tm.getValidToken(), tm.getValidToken()]);
    expect(a).toBe(b);
    expect(n).toBe(1);
    expect(tm.getRefreshToken()).toBe("r2");
  });

  it("drops tokens when refresh fails", async () => {
    const tm = new TokenManager();
    tm.setRefreshFunction(async () => { throw new Error("no"); });
    tm.setTokens(makeJwt(-10), "r1");
    await expect(tm.getValidToken()).rejects.toThrow();
    expect(tm.hasTokens()).toBe(false);
  });

  it("redacts", () => {
    const tm = new TokenManager();
    tm.setTokens(makeJwt(), "r");
    expect(inspect(tm)).not.toContain("eyJ");
    expect(JSON.stringify(tm)).toBe('"[REDACTED]"');
  });
});

describe("Secret", () => {
  it("redacts everywhere except reveal()", () => {
    const s = new Secret("dn_node_" + "0".repeat(64));
    expect(String(s)).toBe("[REDACTED]");
    expect(`${s}`).toBe("[REDACTED]");
    expect(JSON.stringify({ s })).toBe('{"s":"[REDACTED]"}');
    expect(inspect({ s })).not.toContain("dn_node_");
    expect(Object.keys(s)).toEqual([]);
    expect(s.reveal()).toBe("dn_node_" + "0".repeat(64));
    expect(s.prefix).toBe("dn_node_");
  });
});
