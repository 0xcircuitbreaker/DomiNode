import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager } from "../src/token-manager.js";
import { AuthenticationError } from "../src/errors.js";

function makeJwt(expSeconds: number = 900): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      userId: "test-user",
      exp: Math.floor(Date.now() / 1000) + expSeconds,
      iat: Math.floor(Date.now() / 1000),
    }),
  ).toString("base64url");
  const sig = Buffer.from("fake-sig").toString("base64url");
  return `${header}.${payload}.${sig}`;
}

describe("TokenManager", () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  it("starts with no tokens", () => {
    expect(tm.getAccessToken()).toBeNull();
    expect(tm.getRefreshToken()).toBeNull();
  });

  it("stores and retrieves tokens after setTokens", () => {
    const access = makeJwt(900);
    const refresh = makeJwt(7 * 86400);
    tm.setTokens(access, refresh);
    expect(tm.getAccessToken()).toBe(access);
    expect(tm.getRefreshToken()).toBe(refresh);
  });

  it("clears all tokens and pending refresh", () => {
    tm.setTokens(makeJwt(900), makeJwt(7 * 86400));
    tm.clear();
    expect(tm.getAccessToken()).toBeNull();
    expect(tm.getRefreshToken()).toBeNull();
  });

  it("isExpired returns false for a valid token with 15min expiry", () => {
    const token = makeJwt(900);
    expect(tm.isExpired(token)).toBe(false);
  });

  it("isExpired returns true for an expired token", () => {
    const token = makeJwt(-300);
    expect(tm.isExpired(token)).toBe(true);
  });

  it("isExpired returns true for a token within the 60s refresh buffer", () => {
    const token = makeJwt(30); // expires in 30s, within 60s buffer
    expect(tm.isExpired(token)).toBe(true);
  });

  it("isExpired returns true for a malformed token", () => {
    expect(tm.isExpired("not-a-jwt")).toBe(true);
    expect(tm.isExpired("")).toBe(true);
    expect(tm.isExpired("a.b")).toBe(true);
  });

  it("getValidToken returns token directly when not expired", async () => {
    const access = makeJwt(900);
    tm.setTokens(access, makeJwt(7 * 86400));
    const result = await tm.getValidToken();
    expect(result).toBe(access);
  });

  it("getValidToken triggers refresh when token is expired", async () => {
    const expiredAccess = makeJwt(-300);
    const refresh = makeJwt(7 * 86400);
    const newAccess = makeJwt(900);
    const newRefresh = makeJwt(7 * 86400);

    tm.setTokens(expiredAccess, refresh);
    tm.setRefreshFunction(async (rt) => ({
      accessToken: newAccess,
      refreshToken: newRefresh,
    }));

    const result = await tm.getValidToken();
    expect(result).toBe(newAccess);
    expect(tm.getRefreshToken()).toBe(newRefresh);
  });

  it("getValidToken throws AuthenticationError when no refresh token is available", async () => {
    const expiredAccess = makeJwt(-300);
    tm.setTokens(expiredAccess);

    await expect(tm.getValidToken()).rejects.toThrow(AuthenticationError);
  });

  it("getValidToken clears tokens on refresh failure", async () => {
    const expiredAccess = makeJwt(-300);
    const refresh = makeJwt(7 * 86400);
    tm.setTokens(expiredAccess, refresh);
    tm.setRefreshFunction(async () => {
      throw new Error("Refresh failed");
    });

    await expect(tm.getValidToken()).rejects.toThrow();
    expect(tm.getAccessToken()).toBeNull();
    expect(tm.getRefreshToken()).toBeNull();
  });

  it("forceRefresh refreshes even with a valid token", async () => {
    const validAccess = makeJwt(900);
    const refresh = makeJwt(7 * 86400);
    const newAccess = makeJwt(900);
    const newRefresh = makeJwt(7 * 86400);

    tm.setTokens(validAccess, refresh);
    tm.setRefreshFunction(async (rt) => ({
      accessToken: newAccess,
      refreshToken: newRefresh,
    }));

    const result = await tm.forceRefresh();
    expect(result).toBe(newAccess);
  });

  it("forceRefresh throws AuthenticationError without refresh token", async () => {
    await expect(tm.forceRefresh()).rejects.toThrow(AuthenticationError);
  });

  it("deduplicates concurrent refresh calls (singleton pattern)", async () => {
    const expiredAccess = makeJwt(-300);
    const refresh = makeJwt(7 * 86400);
    const newAccess = makeJwt(900);
    let callCount = 0;

    tm.setTokens(expiredAccess, refresh);
    tm.setRefreshFunction(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return { accessToken: newAccess, refreshToken: makeJwt(7 * 86400) };
    });

    const [r1, r2] = await Promise.all([tm.getValidToken(), tm.getValidToken()]);
    expect(r1).toBe(newAccess);
    expect(r2).toBe(newAccess);
    expect(callCount).toBe(1); // Only one actual refresh call
  });
});
