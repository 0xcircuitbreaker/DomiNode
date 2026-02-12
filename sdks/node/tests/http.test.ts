import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpClient } from "../src/http.js";
import { TokenManager } from "../src/token-manager.js";
import {
  ValidationError,
  AuthenticationError,
  InsufficientBalanceError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ServerError,
  NetworkError,
} from "../src/errors.js";

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

describe("HttpClient", () => {
  let tokenManager: TokenManager;
  let http: HttpClient;

  beforeEach(() => {
    vi.restoreAllMocks();
    tokenManager = new TokenManager();
    tokenManager.setTokens(makeJwt(900), makeJwt(7 * 86400));
    tokenManager.setRefreshFunction(async () => ({
      accessToken: makeJwt(900),
      refreshToken: makeJwt(7 * 86400),
    }));
    http = new HttpClient("http://localhost:3000", tokenManager);
  });

  it("sends GET request with Authorization header", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const result = await http.get<{ ok: boolean }>("/api/test");
    expect(result.ok).toBe(true);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:3000/api/test");
    expect((opts as RequestInit).method).toBe("GET");
    expect((opts as RequestInit).headers).toHaveProperty("Authorization");
  });

  it("sends POST request with JSON body", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "new-123" }), { status: 200 }),
    );

    const result = await http.post<{ id: string }>("/api/test", { name: "test" });
    expect(result.id).toBe("new-123");

    const [, opts] = mockFetch.mock.calls[0];
    expect((opts as RequestInit).body).toBe(JSON.stringify({ name: "test" }));
  });

  it("skips auth header when requiresAuth is false", async () => {
    const mockFetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    await http.post<unknown>("/api/auth/login", { email: "a", password: "b" }, false);

    const [, opts] = mockFetch.mock.calls[0];
    const headers = (opts as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("throws ValidationError on 400 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid input" }), { status: 400 }),
    );

    await expect(http.get("/api/test")).rejects.toThrow(ValidationError);
  });

  it("throws AuthenticationError on 401 and retries with token refresh", async () => {
    // First call returns 401, force refresh also fails
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "Still unauthorized" }), { status: 401 }),
      );

    await expect(http.get("/api/test")).rejects.toThrow(AuthenticationError);
    // Should have attempted 2 fetches: original + retry after force refresh
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws InsufficientBalanceError on 402 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Insufficient balance" }), { status: 402 }),
    );

    await expect(http.get("/api/test")).rejects.toThrow(InsufficientBalanceError);
  });

  it("throws ServerError on 500 response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Internal server error" }), { status: 500 }),
    );

    await expect(http.get("/api/test")).rejects.toThrow(ServerError);
  });

  it("throws NetworkError on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(http.get("/api/test")).rejects.toThrow(NetworkError);
  });

  it("retries once on 429 rate limit with Retry-After header", async () => {
    vi.useFakeTimers();
    // Pin Math.random to 0.5 so addJitter produces zero jitter (delay = exactly 1000ms)
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const promise = http.get<{ ok: boolean }>("/api/test");

    // Advance timers past the 1000ms delay (jitter pinned to zero)
    await vi.advanceTimersByTimeAsync(1100);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("returns empty object for empty 200 response body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 200 }),
    );

    const result = await http.get<Record<string, never>>("/api/test");
    expect(result).toEqual({});
  });
});
