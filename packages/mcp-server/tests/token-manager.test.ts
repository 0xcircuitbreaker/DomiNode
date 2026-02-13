import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TokenManager } from "../src/token-manager.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "user1" })).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

describe("TokenManager", () => {
  let tm: TokenManager;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    tm = new TokenManager("http://localhost:3000");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("isExpired", () => {
    it("returns true for malformed tokens", () => {
      expect(tm.isExpired("not.a.jwt")).toBe(true);
      expect(tm.isExpired("")).toBe(true);
      expect(tm.isExpired("one.two")).toBe(true);
    });

    it("returns false for token expiring far in the future", () => {
      const futureExp = Math.floor(Date.now() / 1000) + 600; // 10 min from now
      expect(tm.isExpired(makeJwt(futureExp))).toBe(false);
    });

    it("returns true for token expiring within buffer", () => {
      const soonExp = Math.floor(Date.now() / 1000) + 30; // 30s, within 60s buffer
      expect(tm.isExpired(makeJwt(soonExp))).toBe(true);
    });

    it("returns true for expired token", () => {
      const pastExp = Math.floor(Date.now() / 1000) - 100;
      expect(tm.isExpired(makeJwt(pastExp))).toBe(true);
    });
  });

  describe("initialize", () => {
    it("fetches tokens via verify-key endpoint", async () => {
      const accessToken = makeJwt(Math.floor(Date.now() / 1000) + 600);
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ accessToken, refreshToken: "rt_123" })),
      } as unknown as Response);

      await tm.initialize("dn_live_test");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/auth/verify-key",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ apiKey: "dn_live_test" }),
        }),
      );

      const token = await tm.getValidToken();
      expect(token).toBe(accessToken);
    });

    it("throws on non-OK response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Invalid API key"),
      } as unknown as Response);

      await expect(tm.initialize("dn_live_bad")).rejects.toThrow("Failed to verify API key (HTTP 401)");
    });
  });

  describe("getValidToken", () => {
    it("returns cached token if not expired", async () => {
      const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt_1" })),
      } as unknown as Response);

      await tm.initialize("dn_live_test");
      const result = await tm.getValidToken();
      expect(result).toBe(token);
      // fetch called only once (for initialize)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it("auto-refreshes expired token", async () => {
      const expiredToken = makeJwt(Math.floor(Date.now() / 1000) - 100);
      const freshToken = makeJwt(Math.floor(Date.now() / 1000) + 600);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ accessToken: expiredToken, refreshToken: "rt_1" })),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ accessToken: freshToken, refreshToken: "rt_2" })),
        } as unknown as Response);

      await tm.initialize("dn_live_test");
      const result = await tm.getValidToken();
      expect(result).toBe(freshToken);
    });
  });

  describe("forceRefresh", () => {
    it("throws when no refresh token", async () => {
      await expect(tm.forceRefresh()).rejects.toThrow("No refresh token or API key available");
    });

    it("deduplicates concurrent refresh calls", async () => {
      const token1 = makeJwt(Math.floor(Date.now() / 1000) + 600);
      const token2 = makeJwt(Math.floor(Date.now() / 1000) + 600);

      globalThis.fetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ accessToken: token1, refreshToken: "rt_1" })),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          text: () => Promise.resolve(JSON.stringify({ accessToken: token2, refreshToken: "rt_2" })),
        } as unknown as Response);

      await tm.initialize("dn_live_test");

      // Fire two concurrent refreshes
      const [r1, r2] = await Promise.all([tm.forceRefresh(), tm.forceRefresh()]);
      expect(r1).toBe(r2); // same promise
      // Only 2 fetch calls total: 1 init + 1 refresh (deduplicated)
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("clear", () => {
    it("clears all tokens", async () => {
      const token = makeJwt(Math.floor(Date.now() / 1000) + 600);
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt_1" })),
      } as unknown as Response);

      await tm.initialize("dn_live_test");
      tm.clear();
      await expect(tm.forceRefresh()).rejects.toThrow("No refresh token or API key available");
    });
  });
});
