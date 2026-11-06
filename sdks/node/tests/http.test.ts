import { describe, it, expect } from "vitest";
import { HttpClient, retryDelayMs, safeJsonParse } from "../src/http.js";
import { TokenManager } from "../src/token-manager.js";
import {
  ValidationError, AuthenticationError, AuthorizationError, NotFoundError, ConflictError, RateLimitError, ServerError,
  NetworkError, InsufficientBalanceError,
} from "../src/errors.js";
import { mockFetch, makeJwt, API_KEY } from "./helpers.js";

function client(m: ReturnType<typeof mockFetch>, opts: { key?: string | null; jwt?: boolean } = {}) {
  const tm = new TokenManager();
  if (opts.jwt !== false) tm.setTokens(makeJwt(), makeJwt(86400));
  tm.setRefreshFunction(async () => ({ accessToken: "fresh." + makeJwt().split(".").slice(1).join("."), refreshToken: makeJwt(86400) }));
  const key = opts.key === undefined ? API_KEY : opts.key;
  return { http: new HttpClient("http://api.test/", { tokens: tm, apiKey: () => key }, m.fn), tm };
}

describe("HttpClient", () => {
  it("jwt mode sends the access JWT; never follows redirects", async () => {
    const m = mockFetch([200, { ok: true }]);
    const { http } = client(m);
    expect(await http.get("/api/x")).toEqual({ ok: true });
    expect(m.calls[0].url).toBe("http://api.test/api/x");
    expect(m.calls[0].headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(m.calls[0].redirect).toBe("error");
  });

  it("agent mode sends the raw API key", async () => {
    const m = mockFetch([200, {}]);
    await client(m).http.get("/v1/credits", "agent");
    expect(m.calls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it("agent mode falls back to the JWT when no key is held (wallet sign-in)", async () => {
    const m = mockFetch([200, {}]);
    await client(m, { key: null }).http.get("/v1/credits", "agent");
    expect(m.calls[0].headers.Authorization).toMatch(/^Bearer eyJ/);
  });

  it("none mode sends no Authorization", async () => {
    const m = mockFetch([200, {}]);
    await client(m).http.get("/v1/policy", "none");
    expect(m.calls[0].headers.Authorization).toBeUndefined();
  });

  it("throws AuthenticationError when not connected", async () => {
    const m = mockFetch();
    await expect(client(m, { key: null, jwt: false }).http.get("/api/x")).rejects.toBeInstanceOf(AuthenticationError);
  });

  it.each([
    [400, ValidationError], [401, AuthenticationError], [402, InsufficientBalanceError], [403, AuthorizationError],
    [404, NotFoundError], [409, ConflictError], [500, ServerError], [503, ServerError],
  ])("maps %i", async (status, cls) => {
    const m = mockFetch([status as number, { error: "nope", code: "SOME_CODE" }]);
    const err = await client(m, { key: API_KEY }).http.get("/v1/x", "agent").catch((e) => e);
    expect(err).toBeInstanceOf(cls);
    expect(err.code).toBe("SOME_CODE");
    expect(err.statusCode).toBe(status);
  });

  it("carries numeric details (CAP_ABOVE_DEFAULT max)", async () => {
    const m = mockFetch([400, { error: "too high", code: "CAP_ABOVE_DEFAULT", max: 8 }]);
    const err = await client(m).http.get("/v1/x", "agent").catch((e) => e);
    expect(err.details).toEqual({ max: 8 });
  });

  it("scrubs credentials from error messages", async () => {
    const m = mockFetch([400, { error: `bad key ${API_KEY} and dn_node_${"0".repeat(64)} and ${makeJwt()}` }]);
    const err = await client(m).http.get("/v1/x", "agent").catch((e) => e);
    expect(err.message).not.toMatch(/dn_live_a|dn_node_0|eyJ/);
    expect(err.message).toContain("[REDACTED]");
  });

  it("retries 429 once after Retry-After (cancelling the body) then succeeds", async () => {
    const m = mockFetch([429, "x", { "retry-after": "0" }], [200, { ok: 1 }]);
    expect(await client(m).http.get("/api/x")).toEqual({ ok: 1 });
    expect(m.calls).toHaveLength(2);
  });

  it("raises RateLimitError when the retry is also 429", async () => {
    const m = mockFetch([429, "x", { "retry-after": "0" }], [429, { error: "slow", code: "RATE_LIMITED" }, { "retry-after": "7" }]);
    const err = await client(m).http.get("/api/x").catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSeconds).toBe(7);
    expect(err.code).toBe("RATE_LIMITED");
  });

  it("retry delay: capped at 10s, +/-10% jitter, floor 100ms", () => {
    for (let i = 0; i < 200; i++) {
      const d = retryDelayMs(60);
      expect(d).toBeGreaterThanOrEqual(9000);
      expect(d).toBeLessThanOrEqual(11000);
      expect(retryDelayMs(0)).toBe(100);
      const s = retryDelayMs(1);
      expect(s).toBeGreaterThanOrEqual(900);
      expect(s).toBeLessThanOrEqual(1100);
    }
  });

  it("refreshes the JWT once on 401 and retries", async () => {
    const m = mockFetch([401, { error: "expired" }], [200, { ok: true }]);
    const { http } = client(m);
    expect(await http.get("/api/x")).toEqual({ ok: true });
    expect(m.calls[1].headers.Authorization).toMatch(/^Bearer fresh\./);
  });

  it("does not refresh on 401 for API-key auth", async () => {
    const m = mockFetch([401, { error: "Invalid API key" }]);
    await expect(client(m).http.get("/v1/x", "agent")).rejects.toBeInstanceOf(AuthenticationError);
    expect(m.calls).toHaveLength(1);
  });

  it("rejects bodies over 10MB by content-length", async () => {
    const m = mockFetch([200, "{}", { "content-length": String(11 * 1024 * 1024) }]);
    await expect(client(m).http.get("/api/x")).rejects.toThrow(/too large/);
  });

  it("rejects bodies over 10MB by actual size", async () => {
    const m = mockFetch([200, "x".repeat(10 * 1024 * 1024 + 1)]);
    await expect(client(m).http.get("/api/x")).rejects.toThrow(/size limit/);
  });

  it("wraps fetch failures in NetworkError without leaking keys", async () => {
    const tm = new TokenManager();
    const http = new HttpClient("http://api.test", { tokens: tm, apiKey: () => API_KEY },
      (async () => { throw new Error(`boom ${API_KEY}`); }) as unknown as typeof fetch);
    const err = await http.get("/v1/x", "agent").catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.message).not.toContain(API_KEY);
  });

  it("strips prototype-pollution keys recursively", () => {
    const o = safeJsonParse<Record<string, any>>('{"a":{"__proto__":{"x":1},"constructor":2,"b":[{"prototype":3,"ok":4}]}}');
    expect(Object.keys(o.a)).toEqual(["b"]);
    expect(o.a.b[0]).toEqual({ ok: 4 });
  });

  it("raw mode returns text", async () => {
    const m = mockFetch([200, "a,b\n1,2\n"]);
    expect(await client(m).http.request({ method: "GET", path: "/api/usage/export", raw: true })).toBe("a,b\n1,2\n");
  });

  it("refuses a baseUrl with credentials", () => {
    expect(() => new HttpClient("http://u:p@x", { tokens: new TokenManager(), apiKey: () => null })).toThrow(ValidationError);
  });

  it("redacts itself", () => {
    const { http } = client(mockFetch());
    expect(JSON.stringify({ http })).not.toContain("dn_live");
    expect(String(http)).toBe("HttpClient(http://api.test)");
  });
});
