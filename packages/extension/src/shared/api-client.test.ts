import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiGet, apiPost, setApiBase, getApiBase } from "./api-client.js";

describe("api-client", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset API base to default for each test
    setApiBase("http://localhost:3000");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("setApiBase / getApiBase", () => {
    it("sets and retrieves the API base URL", () => {
      setApiBase("https://api.example.com");
      expect(getApiBase()).toBe("https://api.example.com");
    });

    it("trims trailing slash", () => {
      setApiBase("https://api.example.com/");
      expect(getApiBase()).toBe("https://api.example.com");
    });

    it("rejects non-HTTPS for non-local hosts", () => {
      expect(() => setApiBase("http://api.example.com")).toThrow(
        "API base URL must use HTTPS for non-local hosts",
      );
    });

    it("allows HTTP for localhost", () => {
      setApiBase("http://localhost:3000");
      expect(getApiBase()).toBe("http://localhost:3000");
    });

    it("allows HTTP for 127.0.0.1", () => {
      setApiBase("http://127.0.0.1:3000");
      expect(getApiBase()).toBe("http://127.0.0.1:3000");
    });
  });

  describe("apiPost", () => {
    it("sends POST with correct headers and JSON body", async () => {
      const mockResponse = { token: "abc123", userId: "u1" };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await apiPost<typeof mockResponse>("/api/auth/login", {
        email: "test@example.com",
        password: "secret",
      });

      expect(result).toEqual(mockResponse);
      expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.com", password: "secret" }),
      });
    });

    it("includes Authorization header when token is provided", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true }),
      });

      await apiPost("/api/auth/logout", {}, "my-jwt-token");

      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:3000/api/auth/logout",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer my-jwt-token",
          },
        }),
      );
    });

    it("returns undefined for 204 No Content responses", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 204,
        json: () => Promise.resolve(null),
      });

      const result = await apiPost("/api/auth/logout", {});
      expect(result).toBeUndefined();
    });

    it("throws error with message from error response body", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: () => Promise.resolve({ error: "Invalid credentials" }),
      });

      await expect(apiPost("/api/auth/login", {})).rejects.toThrow("Invalid credentials");
    });

    it("throws statusText when error response body cannot be parsed", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.reject(new Error("not JSON")),
      });

      await expect(apiPost("/api/test", {})).rejects.toThrow("Internal Server Error");
    });
  });

  describe("apiGet", () => {
    it("sends GET with Authorization header when token provided", async () => {
      const mockData = { balance: 5000 };
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
      });

      const result = await apiGet<typeof mockData>("/api/wallet", "jwt-token-123");

      expect(result).toEqual(mockData);
      expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/wallet", {
        headers: { Authorization: "Bearer jwt-token-123" },
      });
    });

    it("sends GET without Authorization header when no token", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "ok" }),
      });

      await apiGet("/api/health");

      expect(fetch).toHaveBeenCalledWith("http://localhost:3000/api/health", {
        headers: {},
      });
    });

    it("throws on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Failed to fetch"));

      await expect(apiGet("/api/wallet", "token")).rejects.toThrow("Failed to fetch");
    });
  });
});
