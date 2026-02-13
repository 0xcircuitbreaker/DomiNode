import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpClient } from "../src/http-client.js";
import { TokenManager } from "../src/token-manager.js";

function makeJwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp, sub: "user1" })).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

describe("HttpClient", () => {
  let httpClient: HttpClient;
  let tokenManager: TokenManager;
  const originalFetch = globalThis.fetch;
  const token = makeJwt(Math.floor(Date.now() / 1000) + 600);

  beforeEach(async () => {
    tokenManager = new TokenManager("http://localhost:3000");
    // Initialize with a valid token
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ accessToken: token, refreshToken: "rt_1" })),
    } as unknown as Response);
    await tokenManager.initialize("dn_live_test");

    httpClient = new HttpClient("http://localhost:3000", tokenManager);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("makes GET request with auth header", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ balance_cents: 500 })),
      headers: new Headers(),
    } as unknown as Response);

    const result = await httpClient.get<{ balance_cents: number }>("/api/wallet");
    expect(result.balance_cents).toBe(500);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/wallet",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Bearer ${token}`,
        }),
      }),
    );
  });

  it("makes POST request with body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ id: "key1", key: "dn_live_new" })),
      headers: new Headers(),
    } as unknown as Response);

    const result = await httpClient.post<{ id: string; key: string }>("/api/keys", { label: "test" });
    expect(result.key).toBe("dn_live_new");
  });

  it("makes unauthenticated request when requiresAuth=false", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ ok: true })),
      headers: new Headers(),
    } as unknown as Response);

    await httpClient.post("/api/auth/register", { email: "a@b.com" }, false);
    const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(callHeaders.Authorization).toBeUndefined();
  });

  it("throws on non-OK response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve(JSON.stringify({ error: "Not found" })),
      headers: new Headers(),
    } as unknown as Response);

    await expect(httpClient.get("/api/nothing")).rejects.toThrow("API error 404: Not found");
  });

  it("retries on 429 with delay", async () => {
    const headers429 = new Headers({ "retry-after": "1" });

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limited"),
        headers: headers429,
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true })),
        headers: new Headers(),
      } as unknown as Response);

    const result = await httpClient.get<{ ok: boolean }>("/api/test");
    expect(result.ok).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("retries on 401 with force refresh", async () => {
    const freshToken = makeJwt(Math.floor(Date.now() / 1000) + 600);

    globalThis.fetch = vi.fn()
      // First call: 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Unauthorized"),
        headers: new Headers(),
      } as unknown as Response)
      // Refresh token call
      .mockResolvedValueOnce({
        ok: true,
        text: () => Promise.resolve(JSON.stringify({ accessToken: freshToken, refreshToken: "rt_2" })),
      } as unknown as Response)
      // Retry call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true })),
        headers: new Headers(),
      } as unknown as Response);

    const result = await httpClient.get<{ ok: boolean }>("/api/test");
    expect(result.ok).toBe(true);
  });

  it("strips prototype pollution keys from response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"data":"ok","__proto__":{"admin":true},"constructor":{"x":1}}'),
      headers: new Headers(),
    } as unknown as Response);

    const result = await httpClient.get<Record<string, unknown>>("/api/test");
    expect(result.data).toBe("ok");
    expect(Object.prototype.hasOwnProperty.call(result, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "prototype")).toBe(false);
  });

  it("strips nested prototype pollution keys recursively", async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"data":{"nested":{"__proto__":{"admin":true},"safe":"value"},"constructor":{"x":1}}}'),
      headers: new Headers(),
    } as unknown as Response);

    const result = await httpClient.get<{ data: { nested: Record<string, unknown> } }>("/api/test");
    expect(result.data.nested.safe).toBe("value");
    expect(Object.prototype.hasOwnProperty.call(result.data.nested, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result.data, "constructor")).toBe(false);
  });

  it("throws network error on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(httpClient.get("/api/test")).rejects.toThrow("Network error: ECONNREFUSED");
  });
});
