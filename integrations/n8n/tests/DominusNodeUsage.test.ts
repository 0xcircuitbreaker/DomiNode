import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock n8n-workflow
// ---------------------------------------------------------------------------

vi.mock("n8n-workflow", () => ({
  NodeOperationError: class NodeOperationError extends Error {
    constructor(node: unknown, message: string, extra?: unknown) {
      super(message);
      this.name = "NodeOperationError";
    }
  },
}));

import { DominusNodeUsage } from "../src/nodes/DominusNodeUsage/DominusNodeUsage.node";

// ---------------------------------------------------------------------------
// Helpers — mock IExecuteFunctions
// ---------------------------------------------------------------------------

function createMockExecuteFunctions(overrides: {
  operation: string;
  params?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  continueOnFail?: boolean;
}) {
  const params: Record<string, unknown> = {
    operation: overrides.operation,
    ...overrides.params,
  };

  const creds = {
    apiKey: "dn_test_abc123",
    baseUrl: "http://localhost:3000",
    ...overrides.credentials,
  };

  return {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name: string, _index: number, fallback?: unknown) => {
      return params[name] ?? fallback;
    },
    getCredentials: vi.fn().mockResolvedValue(creds),
    getNode: () => ({ name: "Dominus Node Usage" }),
    continueOnFail: () => overrides.continueOnFail ?? false,
  };
}

// ---------------------------------------------------------------------------
// Mocked fetch for API calls
// ---------------------------------------------------------------------------

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/api/auth/verify-key")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"token": "jwt-mock-token"}'),
        headers: new Headers({ "content-length": "30" }),
      });
    }
    // Default: mock API call success with usage data
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          '{"totalBytes": 1073741824, "totalCostCents": 300, "records": []}',
        ),
      headers: new Headers({ "content-length": "60" }),
    });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DominusNodeUsage - metadata", () => {
  it("has correct description metadata", () => {
    const node = new DominusNodeUsage();
    expect(node.description.name).toBe("dominusNodeUsage");
    expect(node.description.displayName).toBe("Dominus Node Usage");
    expect(node.description.credentials).toEqual([
      { name: "dominusNodeApi", required: true },
    ]);
  });

  it("has three operations", () => {
    const node = new DominusNodeUsage();
    const opProp = node.description.properties.find((p) => p.name === "operation");
    expect(opProp).toBeDefined();
    expect((opProp as any).options).toHaveLength(3);
  });

  it("has period options: day, week, month", () => {
    const node = new DominusNodeUsage();
    const periodProp = node.description.properties.find((p) => p.name === "period");
    expect(periodProp).toBeDefined();
    const values = (periodProp as any).options.map((o: any) => o.value);
    expect(values).toEqual(["day", "week", "month"]);
  });
});

describe("DominusNodeUsage.execute - checkUsage", () => {
  it("returns usage data for month period", async () => {
    const node = new DominusNodeUsage();
    const mockFns = createMockExecuteFunctions({
      operation: "checkUsage",
      params: { period: "month" },
    });

    const result = await node.execute.call(mockFns as any);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json).toHaveProperty("totalBytes", 1073741824);
    expect(result[0][0].json).toHaveProperty("totalCostCents", 300);
  });

  it("returns usage data for day period", async () => {
    const node = new DominusNodeUsage();
    const mockFns = createMockExecuteFunctions({
      operation: "checkUsage",
      params: { period: "day" },
    });

    const result = await node.execute.call(mockFns as any);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json).toHaveProperty("totalBytes");
  });

  it("returns usage data for week period", async () => {
    const node = new DominusNodeUsage();
    const mockFns = createMockExecuteFunctions({
      operation: "checkUsage",
      params: { period: "week" },
    });

    const result = await node.execute.call(mockFns as any);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json).toHaveProperty("totalBytes");
  });

  it("passes since/until ISO dates (not days integer)", async () => {
    const node = new DominusNodeUsage();
    const mockFns = createMockExecuteFunctions({
      operation: "checkUsage",
      params: { period: "week" },
    });

    await node.execute.call(mockFns as any);

    // Verify that the fetch call included since/until params
    const fetchCalls = (globalThis.fetch as any).mock.calls;
    const usageCall = fetchCalls.find(
      (call: any) => typeof call[0] === "string" && call[0].includes("/api/usage"),
    );
    expect(usageCall).toBeDefined();
    const url = usageCall[0] as string;
    expect(url).toContain("since=");
    expect(url).toContain("until=");
    // Verify ISO date format
    const params = new URLSearchParams(url.split("?")[1]);
    const since = params.get("since");
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("rejects missing API key", async () => {
    const node = new DominusNodeUsage();
    const mockFns = createMockExecuteFunctions({
      operation: "checkUsage",
      params: { period: "month" },
      credentials: { apiKey: "" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/API Key is required/);
  });

  it("returns error in json when continueOnFail is true", async () => {
    // Make the API call fail
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/auth/verify-key")) {
        return Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve('{"error": "Invalid API key dn_live_secret123"}'),
          headers: new Headers({ "content-length": "50" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('{"error": "Internal error"}'),
        headers: new Headers({ "content-length": "30" }),
      });
    });

    const node = new DominusNodeUsage();
    const mockFns = createMockExecuteFunctions({
      operation: "checkUsage",
      params: { period: "month" },
      continueOnFail: true,
    });

    const result = await node.execute.call(mockFns as any);
    expect(result[0][0].json).toHaveProperty("error");
    // Ensure credentials are sanitized
    const errorMsg = result[0][0].json.error as string;
    expect(errorMsg).not.toContain("dn_live_secret123");
  });

  it("handles API error with credential sanitization", async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/api/auth/verify-key")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('{"token": "jwt-mock-token"}'),
          headers: new Headers({ "content-length": "30" }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        text: () => Promise.resolve('{"error": "dn_live_abc123 unauthorized"}'),
        headers: new Headers({ "content-length": "50" }),
      });
    });

    const node = new DominusNodeUsage();
    const mockFns = createMockExecuteFunctions({
      operation: "checkUsage",
      params: { period: "month" },
      continueOnFail: true,
    });

    const result = await node.execute.call(mockFns as any);
    const errorMsg = result[0][0].json.error as string;
    expect(errorMsg).not.toContain("dn_live_abc123");
    expect(errorMsg).toContain("***");
  });
});
