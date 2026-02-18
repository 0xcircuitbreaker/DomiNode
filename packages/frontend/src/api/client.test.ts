import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the real client module — mock global fetch instead
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Dynamically import the module AFTER stubbing fetch so the module picks it up
let get: typeof import("./client").get;
let post: typeof import("./client").post;
let put: typeof import("./client").put;
let del: typeof import("./client").del;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./client");
  get = mod.get;
  post = mod.post;
  put = mod.put;
  del = mod.del;
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("API client", () => {
  it("get() calls fetch with credentials: include", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ balance: 100 })),
    });

    const result = await get("/api/wallet");
    expect(result).toEqual({ balance: 100 });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/wallet",
      expect.objectContaining({
        credentials: "include",
      }),
    );
  });

  it("post() sends JSON body with Content-Type header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ id: "123" })),
    });

    const result = await post("/api/keys", { label: "Test" });
    expect(result).toEqual({ id: "123" });

    const [path, options] = mockFetch.mock.calls[0];
    expect(path).toBe("/api/keys");
    expect(options.method).toBe("POST");
    expect(options.body).toBe(JSON.stringify({ label: "Test" }));
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(options.credentials).toBe("include");
  });

  it("put() sends PUT method with JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ ok: true })),
    });

    await put("/api/plans/user/plan", { planId: "vol100" });

    const [, options] = mockFetch.mock.calls[0];
    expect(options.method).toBe("PUT");
    expect(options.body).toBe(JSON.stringify({ planId: "vol100" }));
  });

  it("del() sends DELETE method", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 204,
    });

    await del("/api/keys/abc");

    const [path, options] = mockFetch.mock.calls[0];
    expect(path).toBe("/api/keys/abc");
    expect(options.method).toBe("DELETE");
  });

  it("throws on non-ok response with error body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ error: "Invalid email" })),
    });

    await expect(get("/api/auth/me")).rejects.toThrow("Invalid email");
  });

  it("handles 429 Too Many Requests with Retry-After", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: {
        get: (name: string) => (name === "Retry-After" ? "30" : null),
      },
    });

    await expect(get("/api/something")).rejects.toThrow(
      "Too many requests. Please try again in 30 seconds.",
    );
  });

  it("attempts silent refresh on 401 then retries", async () => {
    // First call returns 401
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    // Silent refresh succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
    });

    // Retry original request succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify({ user: { id: "1" } })),
    });

    const result = await get("/api/auth/me");
    expect(result).toEqual({ user: { id: "1" } });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
