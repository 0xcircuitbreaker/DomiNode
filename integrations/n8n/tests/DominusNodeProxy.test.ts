import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock n8n-workflow before importing the node
// ---------------------------------------------------------------------------

vi.mock("n8n-workflow", () => ({
  NodeOperationError: class NodeOperationError extends Error {
    constructor(node: unknown, message: string, extra?: unknown) {
      super(message);
      this.name = "NodeOperationError";
    }
  },
}));

// Mock dns/promises for DNS rebinding tests
vi.mock("dns/promises", () => ({
  default: {
    resolve4: vi.fn().mockResolvedValue(["93.184.216.34"]),
    resolve6: vi.fn().mockRejectedValue(new Error("no AAAA")),
  },
}));

import { DominusNodeProxy } from "../src/nodes/DominusNodeProxy/DominusNodeProxy.node";

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
    method: "GET",
    proxyType: "dc",
    country: "",
    headers: {},
    ...overrides.params,
  };

  const creds = {
    apiKey: "dn_test_abc123",
    baseUrl: "https://api.dominusnode.com",
    proxyHost: "proxy.dominusnode.com",
    proxyPort: 8080,
    ...overrides.credentials,
  };

  return {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name: string, _index: number, fallback?: unknown) => {
      return params[name] ?? fallback;
    },
    getCredentials: vi.fn().mockResolvedValue(creds),
    getNode: () => ({ name: "Dominus Node Proxy" }),
    continueOnFail: () => overrides.continueOnFail ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DominusNodeProxy", () => {
  const node = new DominusNodeProxy();

  it("has correct description metadata", () => {
    expect(node.description.name).toBe("dominusNodeProxy");
    expect(node.description.displayName).toBe("Dominus Node Proxy");
    expect(node.description.credentials).toEqual([
      { name: "dominusNodeApi", required: true },
    ]);
  });

  it("has four operations", () => {
    const opProp = node.description.properties.find((p) => p.name === "operation");
    expect(opProp).toBeDefined();
    expect((opProp as any).options).toHaveLength(4);
  });
});

describe("DominusNodeProxy.execute - proxied fetch validation", () => {
  let node: DominusNodeProxy;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    node = new DominusNodeProxy();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("rejects empty URL", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/URL is required/);
  });

  it("rejects localhost URL (SSRF)", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "http://localhost/admin" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/localhost/);
  });

  it("rejects private IP (192.168.x.x)", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "http://192.168.1.1/admin" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/private/i);
  });

  it("rejects cloud metadata endpoint (169.254.169.254)", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "http://169.254.169.254/latest/meta-data/" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/blocked/i);
  });

  it("rejects hex-encoded loopback (0x7f000001)", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "http://0x7f000001/" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/private/i);
  });

  it("rejects decimal-encoded loopback (2130706433)", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "http://2130706433/" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/private/i);
  });

  it("rejects .localhost TLD", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "http://evil.localhost/" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/localhost/);
  });

  it("rejects .internal hostname", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "http://db.internal/" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/internal/);
  });

  it("rejects embedded credentials in URL", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "http://user:pass@example.com/" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/credentials/);
  });

  it("rejects file:// protocol", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "file:///etc/passwd" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/protocols/);
  });

  it("rejects OFAC sanctioned country (IR)", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "https://example.com", country: "IR" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/OFAC/);
  });

  it("rejects OFAC sanctioned country (KP)", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "https://example.com", country: "KP" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/OFAC/);
  });

  it("rejects OFAC sanctioned country (RU)", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "https://example.com", country: "RU" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/OFAC/);
  });

  it("sanitizes credentials in error messages with continueOnFail", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "" },
      continueOnFail: true,
    });

    const result = await node.execute.call(mockFns as any);
    // Should not throw, but return error in json
    expect(result[0][0].json).toHaveProperty("error");
    // Make sure no raw API key appears
    const errorMsg = result[0][0].json.error as string;
    expect(errorMsg).not.toContain("dn_test_abc123");
  });

  it("rejects missing API key", async () => {
    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "https://example.com" },
      credentials: { apiKey: "" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/API Key is required/);
  });
});

describe("DominusNodeProxy.execute - DNS rebinding protection", () => {
  let node: DominusNodeProxy;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    node = new DominusNodeProxy();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("blocks hostname resolving to private IP", async () => {
    // Override the dns mock for this test
    const dnsModule = await import("dns/promises");
    vi.mocked(dnsModule.default.resolve4).mockResolvedValueOnce(["127.0.0.1"]);

    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "https://evil-rebind.example.com/" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/private IP/);
  });

  it("blocks hostname resolving to private IPv6", async () => {
    const dnsModule = await import("dns/promises");
    vi.mocked(dnsModule.default.resolve4).mockResolvedValueOnce(["93.184.216.34"]);
    vi.mocked(dnsModule.default.resolve6).mockResolvedValueOnce(["::1"]);

    const mockFns = createMockExecuteFunctions({
      operation: "proxiedFetch",
      params: { url: "https://evil-rebind6.example.com/" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/private IPv6/);
  });
});
