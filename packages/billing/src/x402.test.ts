import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @dominusnode/shared
const mockQuery = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  query: (...args: unknown[]) => mockQuery(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Save original env
const origEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // Reset env to clean state
  delete process.env["X402_ENABLED"];
  delete process.env["X402_RECEIVING_ADDRESS"];
  delete process.env["X402_RECEIVING_ADDRESS_SOLANA"];
  delete process.env["X402_DC_PRICE_PER_REQUEST_USD"];
  delete process.env["X402_RES_PRICE_PER_REQUEST_USD"];
  delete process.env["X402_MAX_REQUEST_BODY_BYTES"];
  delete process.env["X402_MAX_RESPONSE_BYTES"];
  delete process.env["X402_NETWORK"];
  delete process.env["CDP_API_KEY_ID"];
  delete process.env["CDP_API_KEY_SECRET"];
  delete process.env["PAYAI_API_KEY_ID"];
  delete process.env["PAYAI_API_KEY_SECRET"];
  delete process.env["PROXY_PUBLIC_HOST"];
  // Default: claimPaymentHash succeeds (rowCount=1)
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

afterEach(() => {
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
  }
  Object.assign(process.env, origEnv);
});

import {
  isX402Enabled,
  detectFacilitator,
  buildX402Requirements,
  verifyX402Payment,
  settleX402Payment,
  updateX402Transaction,
  claimPaymentHash,
  releasePaymentHash,
  getDcPricePerRequestUsd,
  getResPricePerRequestUsd,
  getMaxRequestBodyBytes,
  getX402MaxResponseBytes,
  hashPaymentHeader,
} from "./x402.js";

// ─── isX402Enabled ───────────────────────────────────────────────────

describe("isX402Enabled", () => {
  it("returns false by default", () => {
    expect(isX402Enabled()).toBe(false);
  });

  it("returns true when X402_ENABLED=true", () => {
    process.env["X402_ENABLED"] = "true";
    expect(isX402Enabled()).toBe(true);
  });

  it("returns false for non-true values", () => {
    process.env["X402_ENABLED"] = "yes";
    expect(isX402Enabled()).toBe(false);
  });
});

// ─── detectFacilitator ───────────────────────────────────────────────

describe("detectFacilitator", () => {
  it("defaults to coinbase for empty header", () => {
    expect(detectFacilitator("")).toBe("coinbase");
  });

  it("detects coinbase from JSON with EVM address", () => {
    const header = JSON.stringify({ payTo: "0xabc123", network: "base-sepolia" });
    expect(detectFacilitator(header)).toBe("coinbase");
  });

  it("detects payai from JSON with solana network", () => {
    const header = JSON.stringify({ network: "solana", payTo: "So1abc123XYZ" });
    expect(detectFacilitator(header)).toBe("payai");
  });

  it("detects payai from explicit facilitator field", () => {
    const header = JSON.stringify({ facilitator: "payai", payTo: "anything" });
    expect(detectFacilitator(header)).toBe("payai");
  });

  it("detects coinbase from explicit facilitator field", () => {
    const header = JSON.stringify({ facilitator: "coinbase", payTo: "anything" });
    expect(detectFacilitator(header)).toBe("coinbase");
  });

  it("detects payai from Solana base58 address format", () => {
    const header = JSON.stringify({ payTo: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" });
    expect(detectFacilitator(header)).toBe("payai");
  });

  it("detects coinbase from 0x address format", () => {
    const header = JSON.stringify({ payTo: "0x1234567890abcdef1234567890abcdef12345678" });
    expect(detectFacilitator(header)).toBe("coinbase");
  });

  it("detects payai from raw string containing solana indicator", () => {
    expect(detectFacilitator('{"network":"solana","amount":"1000"}')).toBe("payai");
  });

  it("defaults to coinbase for non-JSON non-matching content", () => {
    expect(detectFacilitator("random-garbage")).toBe("coinbase");
  });
});

// ─── buildX402Requirements ───────────────────────────────────────────

describe("buildX402Requirements", () => {
  it("builds requirements for DC pool with both addresses", () => {
    process.env["X402_RECEIVING_ADDRESS"] = "0x1234567890abcdef1234567890abcdef12345678";
    process.env["X402_RECEIVING_ADDRESS_SOLANA"] = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    process.env["X402_DC_PRICE_PER_REQUEST_USD"] = "0.001";

    const req = buildX402Requirements("dc");
    expect(req.version).toBe("1");
    expect(req.accepts).toHaveLength(2);
    expect(req.accepts[0].extra.facilitator).toBe("coinbase");
    expect(req.accepts[0].payTo).toBe("0x1234567890abcdef1234567890abcdef12345678");
    expect(req.accepts[0].maxAmountRequired).toBe("1000"); // $0.001 = 1000 USDC base units
    expect(req.accepts[1].extra.facilitator).toBe("payai");
    expect(req.accepts[1].payTo).toBe("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    expect(req.accepts[1].network).toBe("solana");
  });

  it("builds requirements for residential pool with higher price", () => {
    process.env["X402_RECEIVING_ADDRESS"] = "0x1234567890abcdef1234567890abcdef12345678";
    process.env["X402_RES_PRICE_PER_REQUEST_USD"] = "0.005";

    const req = buildX402Requirements("residential");
    expect(req.accepts).toHaveLength(1); // only coinbase, no solana addr
    expect(req.accepts[0].maxAmountRequired).toBe("5000"); // $0.005 = 5000 USDC base units
  });

  it("builds empty accepts when no addresses configured", () => {
    const req = buildX402Requirements("dc");
    expect(req.accepts).toHaveLength(0);
  });

  it("includes only coinbase when only EVM address set", () => {
    process.env["X402_RECEIVING_ADDRESS"] = "0x1234567890abcdef1234567890abcdef12345678";
    const req = buildX402Requirements("dc");
    expect(req.accepts).toHaveLength(1);
    expect(req.accepts[0].extra.facilitator).toBe("coinbase");
  });

  it("includes only payai when only Solana address set", () => {
    process.env["X402_RECEIVING_ADDRESS_SOLANA"] = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const req = buildX402Requirements("dc");
    expect(req.accepts).toHaveLength(1);
    expect(req.accepts[0].extra.facilitator).toBe("payai");
  });

  it("rejects invalid EVM address format", () => {
    process.env["X402_RECEIVING_ADDRESS"] = "not-a-valid-evm";
    const req = buildX402Requirements("dc");
    expect(req.accepts).toHaveLength(0); // invalid format filtered out
  });

  it("rejects invalid Solana address format", () => {
    process.env["X402_RECEIVING_ADDRESS_SOLANA"] = "too-short";
    const req = buildX402Requirements("dc");
    expect(req.accepts).toHaveLength(0); // invalid format filtered out
  });

  it("uses custom network from env", () => {
    process.env["X402_RECEIVING_ADDRESS"] = "0x1234567890abcdef1234567890abcdef12345678";
    process.env["X402_NETWORK"] = "base";
    const req = buildX402Requirements("dc");
    expect(req.accepts[0].network).toBe("base");
  });

  it("uses custom public host in resource URL", () => {
    process.env["X402_RECEIVING_ADDRESS"] = "0x1234567890abcdef1234567890abcdef12345678";
    process.env["PROXY_PUBLIC_HOST"] = "custom.proxy.io";
    const req = buildX402Requirements("dc");
    expect(req.accepts[0].resource).toBe("https://custom.proxy.io");
  });
});

// ─── hashPaymentHeader / isPaymentReplayed ──────────────────────────

describe("hashPaymentHeader", () => {
  it("returns a deterministic SHA-256 hex hash", () => {
    const hash1 = hashPaymentHeader("test-payment");
    const hash2 = hashPaymentHeader("test-payment");
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
    expect(/^[0-9a-f]{64}$/.test(hash1)).toBe(true);
  });

  it("produces different hashes for different inputs", () => {
    const hash1 = hashPaymentHeader("payment-a");
    const hash2 = hashPaymentHeader("payment-b");
    expect(hash1).not.toBe(hash2);
  });
});

// ─── verifyX402Payment ───────────────────────────────────────────────

describe("verifyX402Payment", () => {
  const mockRequirements = {
    version: "1",
    accepts: [
      {
        scheme: "exact",
        network: "base-sepolia",
        maxAmountRequired: "1000",
        resource: "https://proxy.dominusnode.com",
        payTo: "0x1234567890abcdef1234567890abcdef12345678",
        extra: { facilitator: "coinbase" as const },
      },
    ],
  };

  it("rejects empty payment header", async () => {
    const result = await verifyX402Payment("", mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Empty");
  });

  it("rejects oversized payment header", async () => {
    const result = await verifyX402Payment("x".repeat(10001), mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("too large");
  });

  it("rejects when no accepts configured", async () => {
    const result = await verifyX402Payment("data", { version: "1", accepts: [] });
    expect(result.valid).toBe(false);
    expect(result.error).toContain("No payment facilitators");
  });

  it("rejects replayed payments", async () => {
    // claimPaymentHash returns rowCount=0 when hash already exists (replay)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await verifyX402Payment("replayed-data", mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("already used");
  });

  it("returns invalid when CDP credentials not configured (coinbase)", async () => {
    const header = JSON.stringify({ payTo: "0xABC", network: "base-sepolia" });
    const result = await verifyX402Payment(header, mockRequirements);
    expect(result.valid).toBe(false);
    // H-2: Generic error to client
    expect(result.error).toContain("Facilitator unavailable");
  });

  it("verifies with Coinbase facilitator successfully", async () => {
    process.env["CDP_API_KEY_ID"] = "test-key";
    process.env["CDP_API_KEY_SECRET"] = "test-secret";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ valid: true, payer: "0xPayer123", amount: "1000" })),
    });

    const header = JSON.stringify({ payTo: "0xABC", network: "base-sepolia" });
    const result = await verifyX402Payment(header, mockRequirements);
    expect(result.valid).toBe(true);
    expect(result.payer).toBe("0xPayer123");
    expect(result.amountUsd).toBe("0.001000");
    expect(result.facilitator).toBe("coinbase");
  });

  it("rejects invalid payment from Coinbase", async () => {
    process.env["CDP_API_KEY_ID"] = "test-key";
    process.env["CDP_API_KEY_SECRET"] = "test-secret";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ valid: false, payer: "" })),
    });

    const header = JSON.stringify({ payTo: "0xABC" });
    const result = await verifyX402Payment(header, mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("invalid");
  });

  it("handles Coinbase API error", async () => {
    process.env["CDP_API_KEY_ID"] = "test-key";
    process.env["CDP_API_KEY_SECRET"] = "test-secret";

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    const header = JSON.stringify({ payTo: "0xABC" });
    const result = await verifyX402Payment(header, mockRequirements);
    expect(result.valid).toBe(false);
    // H-2: Generic error message (specific error logged server-side)
    expect(result.error).toContain("Payment verification failed");
  });

  it("rejects insufficient payment amount", async () => {
    process.env["CDP_API_KEY_ID"] = "test-key";
    process.env["CDP_API_KEY_SECRET"] = "test-secret";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ valid: true, payer: "0xPayer", amount: "500" })), // only 500 but 1000 required
    });

    const header = JSON.stringify({ payTo: "0xABC" });
    const result = await verifyX402Payment(header, mockRequirements);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("insufficient");
  });

  it("verifies with PayAI facilitator successfully", async () => {
    process.env["PAYAI_API_KEY_ID"] = "payai-key";
    process.env["PAYAI_API_KEY_SECRET"] = "payai-secret";

    const payaiRequirements = {
      version: "1",
      accepts: [{
        scheme: "exact",
        network: "solana",
        maxAmountRequired: "5000",
        resource: "https://proxy.dominusnode.com",
        payTo: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        extra: { facilitator: "payai" as const },
      }],
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ valid: true, payer: "SolPayer456", amount: "5000" })),
    });

    const header = JSON.stringify({ network: "solana", payTo: "SolAddr123" });
    const result = await verifyX402Payment(header, payaiRequirements);
    expect(result.valid).toBe(true);
    expect(result.payer).toBe("SolPayer456");
    expect(result.facilitator).toBe("payai");
  });

  it("returns invalid when PayAI credentials not configured", async () => {
    const payaiRequirements = {
      version: "1",
      accepts: [{
        scheme: "exact",
        network: "solana",
        maxAmountRequired: "5000",
        resource: "https://proxy.dominusnode.com",
        payTo: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        extra: { facilitator: "payai" as const },
      }],
    };

    const header = JSON.stringify({ network: "solana", payTo: "SolAddr" });
    const result = await verifyX402Payment(header, payaiRequirements);
    expect(result.valid).toBe(false);
    // H-2: Generic error to client
    expect(result.error).toContain("Facilitator unavailable");
  });

  it("handles network errors gracefully", async () => {
    process.env["CDP_API_KEY_ID"] = "test-key";
    process.env["CDP_API_KEY_SECRET"] = "test-secret";

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const header = JSON.stringify({ payTo: "0xABC" });
    const result = await verifyX402Payment(header, mockRequirements);
    expect(result.valid).toBe(false);
    // H-2: Generic error
    expect(result.error).toContain("Payment verification failed");
  });
});

// ─── settleX402Payment ───────────────────────────────────────────────

describe("settleX402Payment", () => {
  it("settles with Coinbase successfully", async () => {
    process.env["CDP_API_KEY_ID"] = "test-key";
    process.env["CDP_API_KEY_SECRET"] = "test-secret";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ txHash: "0xTxHash123", amount: "1000" })),
    });

    const result = await settleX402Payment("payment-data", "coinbase");
    expect(result.txHash).toBe("0xTxHash123");
    expect(result.facilitator).toBe("coinbase");
  });

  it("settles with PayAI successfully", async () => {
    process.env["PAYAI_API_KEY_ID"] = "key";
    process.env["PAYAI_API_KEY_SECRET"] = "secret";

    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ txHash: "SolTxHash456", amount: "5000" })),
    });

    const result = await settleX402Payment("payment-data", "payai");
    expect(result.txHash).toBe("SolTxHash456");
    expect(result.facilitator).toBe("payai");
  });

  it("throws when Coinbase CDP credentials missing", async () => {
    await expect(settleX402Payment("data", "coinbase")).rejects.toThrow("credentials not configured");
  });

  it("throws on Coinbase settle failure", async () => {
    process.env["CDP_API_KEY_ID"] = "test-key";
    process.env["CDP_API_KEY_SECRET"] = "test-secret";

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve("Bad request"),
    });

    await expect(settleX402Payment("bad-data", "coinbase")).rejects.toThrow("Coinbase settlement failed");
  });

  it("throws when PayAI credentials missing", async () => {
    await expect(settleX402Payment("data", "payai")).rejects.toThrow("credentials not configured");
  });

  it("throws on PayAI settle failure", async () => {
    process.env["PAYAI_API_KEY_ID"] = "key";
    process.env["PAYAI_API_KEY_SECRET"] = "secret";

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Server error"),
    });

    await expect(settleX402Payment("bad-data", "payai")).rejects.toThrow("PayAI settlement failed");
  });
});

// ─── Config getters ──────────────────────────────────────────────────

describe("config getters", () => {
  it("getDcPricePerRequestUsd defaults to 0.001", () => {
    expect(getDcPricePerRequestUsd()).toBe("0.001");
  });

  it("getResPricePerRequestUsd defaults to 0.005", () => {
    expect(getResPricePerRequestUsd()).toBe("0.005");
  });

  it("getDcPricePerRequestUsd reads from env", () => {
    process.env["X402_DC_PRICE_PER_REQUEST_USD"] = "0.002";
    expect(getDcPricePerRequestUsd()).toBe("0.002");
  });

  it("getResPricePerRequestUsd reads from env", () => {
    process.env["X402_RES_PRICE_PER_REQUEST_USD"] = "0.01";
    expect(getResPricePerRequestUsd()).toBe("0.01");
  });

  it("getMaxRequestBodyBytes defaults to 10MB", () => {
    expect(getMaxRequestBodyBytes()).toBe(10485760);
  });

  it("getMaxRequestBodyBytes reads from env", () => {
    process.env["X402_MAX_REQUEST_BODY_BYTES"] = "5242880";
    expect(getMaxRequestBodyBytes()).toBe(5242880);
  });

  it("getMaxRequestBodyBytes throws on invalid value", () => {
    process.env["X402_MAX_REQUEST_BODY_BYTES"] = "abc";
    expect(() => getMaxRequestBodyBytes()).toThrow("must be between");
  });

  it("getX402MaxResponseBytes defaults to 10MB", () => {
    expect(getX402MaxResponseBytes()).toBe(10_485_760);
  });

  it("getX402MaxResponseBytes reads from env", () => {
    process.env["X402_MAX_RESPONSE_BYTES"] = "5242880";
    expect(getX402MaxResponseBytes()).toBe(5_242_880);
  });

  it("getX402MaxResponseBytes throws on invalid value", () => {
    process.env["X402_MAX_RESPONSE_BYTES"] = "abc";
    expect(() => getX402MaxResponseBytes()).toThrow("must be between");
  });

  it("getX402MaxResponseBytes throws when below minimum", () => {
    process.env["X402_MAX_RESPONSE_BYTES"] = "100";
    expect(() => getX402MaxResponseBytes()).toThrow("must be between");
  });
});

// ─── releasePaymentHash ─────────────────────────────────────────────

describe("releasePaymentHash", () => {
  it("deletes pending row by payment hash", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await releasePaymentHash("hash123");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain("DELETE");
    expect(mockQuery.mock.calls[0][0]).toContain("status = 'pending'");
    expect(mockQuery.mock.calls[0][1]).toEqual(["hash123"]);
  });

  it("does not throw when no rows match", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(releasePaymentHash("nonexistent")).resolves.toBeUndefined();
  });
});

// ─── updateX402Transaction ──────────────────────────────────────────

describe("updateX402Transaction", () => {
  it("updates pending transaction with settlement result", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateX402Transaction("hash123", "coinbase", "0xPayer", "0.001", "0xTx", "dc", "example.com", "settled");

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain("UPDATE");
    expect(mockQuery.mock.calls[0][1]).toEqual(["coinbase", "0xPayer", "0.001", "0xTx", "dc", "example.com", "settled", "hash123"]);
  });

  it("updates with failed status and null tx hash", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateX402Transaction("hash456", "payai", "SolPayer", "0.005", null, "residential", "target.com", "failed");

    expect(mockQuery.mock.calls[0][1]).toEqual(["payai", "SolPayer", "0.005", null, "residential", "target.com", "failed", "hash456"]);
  });

  it("truncates long inputs to safe lengths", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateX402Transaction("hash", "coinbase", "x".repeat(500), "0.001", "z".repeat(500), "dc", "h".repeat(500), "settled");

    const args = mockQuery.mock.calls[0][1] as string[];
    expect(args[1].length).toBe(255); // payer
    expect((args[3] as string).length).toBe(255); // txHash
    expect(args[5].length).toBe(255); // targetHost
  });

  it("sanitizes non-numeric amount to '0'", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await updateX402Transaction("hash", "coinbase", "0xP", "not-a-number", "0xTx", "dc", "host", "settled");

    const args = mockQuery.mock.calls[0][1] as string[];
    expect(args[2]).toBe("0");
  });
});

// ─── claimPaymentHash ───────────────────────────────────────────────

describe("claimPaymentHash", () => {
  it("returns true when hash is successfully claimed", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await claimPaymentHash("newhash");
    expect(result).toBe(true);
    expect(mockQuery.mock.calls[0][0]).toContain("INSERT");
    expect(mockQuery.mock.calls[0][0]).toContain("ON CONFLICT");
  });

  it("returns false when hash already exists (replay)", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await claimPaymentHash("existinghash");
    expect(result).toBe(false);
  });
});
