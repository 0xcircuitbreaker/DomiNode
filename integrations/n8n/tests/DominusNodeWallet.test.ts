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

import { DominusNodeWallet } from "../src/nodes/DominusNodeWallet/DominusNodeWallet.node";

// ---------------------------------------------------------------------------
// Helpers — mock IExecuteFunctions
// ---------------------------------------------------------------------------

function createMockExecuteFunctions(overrides: {
  operation: string;
  params?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  continueOnFail?: boolean;
  mockApiResponse?: unknown;
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
    getNode: () => ({ name: "DomiNode Wallet" }),
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
    // Default: mock API call success
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"success": true}'),
      headers: new Headers({ "content-length": "20" }),
    });
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DominusNodeWallet - metadata", () => {
  it("has correct description metadata", () => {
    const node = new DominusNodeWallet();
    expect(node.description.name).toBe("dominusNodeWallet");
    expect(node.description.displayName).toBe("DomiNode Wallet");
    expect(node.description.credentials).toEqual([
      { name: "dominusNodeApi", required: true },
    ]);
  });

  it("has 20 operations", () => {
    const node = new DominusNodeWallet();
    const opProp = node.description.properties.find((p) => p.name === "operation");
    expect(opProp).toBeDefined();
    expect((opProp as any).options).toHaveLength(20);
  });
});

describe("DominusNodeWallet.execute - checkBalance", () => {
  it("returns balance on success", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({ operation: "checkBalance" });

    const result = await node.execute.call(mockFns as any);
    expect(result[0]).toHaveLength(1);
    expect(result[0][0].json).toHaveProperty("success", true);
  });
});

describe("DominusNodeWallet.execute - topUpStripe validation", () => {
  it("rejects amountCents below 100", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "topUpStripe",
      params: { amountCents: 50 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/amountCents/);
  });

  it("rejects amountCents above 1,000,000", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "topUpStripe",
      params: { amountCents: 1_000_001 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/amountCents/);
  });

  it("accepts valid amountCents", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "topUpStripe",
      params: { amountCents: 500 },
    });

    const result = await node.execute.call(mockFns as any);
    expect(result[0][0].json).toHaveProperty("success", true);
  });
});

describe("DominusNodeWallet.execute - topUpCrypto validation", () => {
  it("rejects amountUsd below $5", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "topUpCrypto",
      params: { amountUsd: 3, currency: "btc" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/amountUsd/);
  });

  it("rejects invalid cryptocurrency", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "topUpCrypto",
      params: { amountUsd: 10, currency: "doge" },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/Invalid currency/);
  });

  it("accepts valid crypto top-up", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "topUpCrypto",
      params: { amountUsd: 10, currency: "eth" },
    });

    const result = await node.execute.call(mockFns as any);
    expect(result[0][0].json).toHaveProperty("success", true);
  });
});

describe("DominusNodeWallet.execute - topUpPaypal validation", () => {
  it("rejects amountCents below 100", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "topUpPaypal",
      params: { amountCents: 50 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/amountCents/);
  });

  it("accepts valid PayPal top-up", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "topUpPaypal",
      params: { amountCents: 1000 },
    });

    const result = await node.execute.call(mockFns as any);
    expect(result[0][0].json).toHaveProperty("success", true);
  });
});

describe("DominusNodeWallet.execute - agentic wallet validation", () => {
  it("createAgenticWallet rejects missing label", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createAgenticWallet",
      params: { agenticLabel: "", spendingLimitCents: 100 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/Label is required/);
  });

  it("createAgenticWallet rejects label over 100 chars", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createAgenticWallet",
      params: { agenticLabel: "a".repeat(101), spendingLimitCents: 100 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/100 characters/);
  });

  it("createAgenticWallet rejects control characters in label", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createAgenticWallet",
      params: { agenticLabel: "test\x00label", spendingLimitCents: 100 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/control characters/);
  });

  it("createAgenticWallet rejects invalid spending limit", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createAgenticWallet",
      params: { agenticLabel: "test", spendingLimitCents: -5 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/positive integer/);
  });

  it("fundAgenticWallet rejects invalid UUID", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "fundAgenticWallet",
      params: { walletId: "not-a-uuid", fundAmountCents: 100 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/valid UUID/);
  });

  it("fundAgenticWallet rejects negative amount", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "fundAgenticWallet",
      params: {
        walletId: "550e8400-e29b-41d4-a716-446655440000",
        fundAmountCents: -100,
      },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/positive integer/);
  });
});

describe("DominusNodeWallet.execute - team validation", () => {
  it("createTeam rejects missing name", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createTeam",
      params: { teamName: "", maxMembers: 10 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/Team name is required/);
  });

  it("createTeam rejects name over 100 chars", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createTeam",
      params: { teamName: "a".repeat(101), maxMembers: 10 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/100 characters/);
  });

  it("createTeam rejects control chars in name", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createTeam",
      params: { teamName: "team\x07name", maxMembers: 10 },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/control characters/);
  });

  it("fundTeam rejects amount below 100", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "fundTeam",
      params: {
        teamId: "550e8400-e29b-41d4-a716-446655440000",
        teamFundAmountCents: 50,
      },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/amountCents/);
  });

  it("fundTeam rejects amount above 1,000,000", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "fundTeam",
      params: {
        teamId: "550e8400-e29b-41d4-a716-446655440000",
        teamFundAmountCents: 1_000_001,
      },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/amountCents/);
  });

  it("createTeamKey rejects missing label", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createTeamKey",
      params: {
        teamId: "550e8400-e29b-41d4-a716-446655440000",
        keyLabel: "",
      },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/Key label is required/);
  });

  it("createTeamKey rejects control chars in label", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "createTeamKey",
      params: {
        teamId: "550e8400-e29b-41d4-a716-446655440000",
        keyLabel: "key\x01label",
      },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/control characters/);
  });

  it("updateTeam rejects when no fields provided", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "updateTeam",
      params: {
        teamId: "550e8400-e29b-41d4-a716-446655440000",
        updateTeamName: "",
        updateMaxMembers: 0,
      },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/At least one/);
  });

  it("updateTeamMemberRole rejects invalid role", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "updateTeamMemberRole",
      params: {
        teamId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "660e8400-e29b-41d4-a716-446655440000",
        role: "owner",
      },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/member.*admin/);
  });

  it("updateTeamMemberRole rejects invalid userId UUID", async () => {
    const node = new DominusNodeWallet();
    const mockFns = createMockExecuteFunctions({
      operation: "updateTeamMemberRole",
      params: {
        teamId: "550e8400-e29b-41d4-a716-446655440000",
        userId: "not-a-uuid",
        role: "admin",
      },
    });

    await expect(node.execute.call(mockFns as any)).rejects.toThrow(/valid UUID/);
  });
});
