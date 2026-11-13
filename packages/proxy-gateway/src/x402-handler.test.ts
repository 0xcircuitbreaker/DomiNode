import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";

// Mock @dominusnode/billing
const mockIsX402Enabled = vi.fn();
const mockBuildX402Requirements = vi.fn();
const mockVerifyX402Payment = vi.fn();
const mockSettleX402Payment = vi.fn();
const mockUpdateX402Transaction = vi.fn();
const mockReleasePaymentHash = vi.fn();
const mockHashPaymentHeader = vi.fn();
const mockGetX402MaxResponseBytes = vi.fn();

vi.mock("@dominusnode/billing", () => ({
  isX402Enabled: (...args: unknown[]) => mockIsX402Enabled(...args),
  buildX402Requirements: (...args: unknown[]) => mockBuildX402Requirements(...args),
  verifyX402Payment: (...args: unknown[]) => mockVerifyX402Payment(...args),
  settleX402Payment: (...args: unknown[]) => mockSettleX402Payment(...args),
  updateX402Transaction: (...args: unknown[]) => mockUpdateX402Transaction(...args),
  releasePaymentHash: (...args: unknown[]) => mockReleasePaymentHash(...args),
  hashPaymentHeader: (...args: unknown[]) => mockHashPaymentHeader(...args),
  getX402MaxResponseBytes: (...args: unknown[]) => mockGetX402MaxResponseBytes(...args),
  mppRailFromEnv: () => ({ id: "mpp", enabled: () => false, challenge: () => null, parseHeader: () => null }),
  usdStringToMusd: (v: string) => {
    const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(v);
    return m ? BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0")) : null;
  },
}));

const mockFindOrCreateX402User = vi.fn();
const mockGetPricing = vi.fn();
vi.mock("@dominusnode/shared", () => ({
  EXIT_CLASSES: ["residential", "mobile", "dc", "masked"],
  isExitClass: (c: unknown) => ["residential", "mobile", "dc", "masked"].includes(c as string),
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  RELAY_BYTES_PER_GB: 1_000_000_000, BYTES_PER_GIB: 1_073_741_824,
  DEFAULT_PRICE_PER_GB_MUSD: { residential: 500_000, mobile: 500_000, dc: 200_000, masked: 100_000 },
  userRepo: { findOrCreateX402User: (...a: unknown[]) => mockFindOrCreateX402User(...a) },
  policyRepo: { getPricing: (...a: unknown[]) => mockGetPricing(...a) },
  walletRepo: {
    getWallet: (...a: unknown[]) => mockGetWallet(...a),
    createWallet: (...a: unknown[]) => mockCreateWallet(...a),
    creditWallet: (...a: unknown[]) => mockCreditWallet(...a),
  },
  payerRefundRepo: { recordOwed: (...a: unknown[]) => mockRecordOwed(...a) },
}));
const mockRecordOwed = vi.fn();
const mockGetWallet = vi.fn();
const mockCreateWallet = vi.fn();
const mockCreditWallet = vi.fn();

const origEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["X402_RATE_LIMIT_MAX"];
  mockHashPaymentHeader.mockReturnValue("fakehash123");
  mockUpdateX402Transaction.mockResolvedValue(undefined);
  mockReleasePaymentHash.mockResolvedValue(undefined);
  mockGetX402MaxResponseBytes.mockReturnValue(10_485_760);
  // $0.05/GB → 10 MiB quote = ceil(50000 * 10485760 / 2^30) = 525 µUSD (< "0.001")
  mockGetPricing.mockResolvedValue(50_000n);
  mockFindOrCreateX402User.mockResolvedValue({ id: "user-x402", status: "active", created: false });
  mockGetWallet.mockResolvedValue({ id: "w1" });
  mockCreditWallet.mockResolvedValue({ id: "tx1" });
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in origEnv)) delete process.env[key];
  }
  Object.assign(process.env, origEnv);
});

import {
  handleX402Http,
  handleX402Connect,
  settleX402HttpRequest,
  settleX402ConnectRequest,
  build402ResponseBody,
  build402ConnectResponse,
  isX402Verified,
  getX402Data,
  settleX402Pending,
  releaseX402Pending,
  refundX402Payer,
  setMppRailForTest,
  paymentChallengeHeaders,
  normalizePayer,
  checkX402RateLimitForTest,
  resetX402RateLimitsForTest,
} from "./x402-handler.js";
import { configurePayerScreening } from "./payer-screening.js";

// ─── Helpers ─────────────────────────────────────────────────────────

function makeRequest(headers: Record<string, string> = {}): http.IncomingMessage {
  const req = new http.IncomingMessage(null as any);
  for (const [k, v] of Object.entries(headers)) {
    req.headers[k.toLowerCase()] = v;
  }
  return req;
}

function makeResponse(): http.ServerResponse & { _written: string; _statusCode: number; _headers: Record<string, string> } {
  const res = {
    _written: "",
    _statusCode: 200,
    _headers: {} as Record<string, string>,
    writeHead(status: number, headers?: Record<string, string>) {
      res._statusCode = status;
      Object.assign(res._headers, headers ?? {});
      return res;
    },
    end(data?: string) {
      if (data) res._written += data;
    },
    headersSent: false,
  } as any;
  return res;
}

function makeSocket(): net.Socket & { _written: string; _ended: boolean } {
  const socket = {
    _written: "",
    _ended: false,
    destroyed: false,
    write(data: string) {
      socket._written += data;
      return true;
    },
    end() {
      socket._ended = true;
    },
  } as any;
  return socket;
}

const mockRequirements = {
  version: "1",
  accepts: [{ scheme: "exact", network: "base-sepolia", maxAmountRequired: "1000", payTo: "0xAddr", extra: { facilitator: "coinbase" } }],
};

// ─── handleX402Http ──────────────────────────────────────────────────

describe("handleX402Http", () => {
  it("returns false when x402 is disabled", async () => {
    mockIsX402Enabled.mockReturnValue(false);
    const req = makeRequest({ "x-payment": "data" });
    const res = makeResponse();
    const handled = await handleX402Http(req, res);
    expect(handled).toBe(false);
  });

  it("returns false when no X-PAYMENT header", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    const req = makeRequest({});
    const res = makeResponse();
    const handled = await handleX402Http(req, res);
    expect(handled).toBe(false);
  });

  it("returns 402 with requirements on invalid payment", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Bad payment" });

    const req = makeRequest({ "x-payment": "invalid-data" });
    const res = makeResponse();
    const handled = await handleX402Http(req, res);

    expect(handled).toBe(true);
    expect(isX402Verified(req)).toBe(false);
    expect(res._statusCode).toBe(402);
    expect(res._written).toContain("X402_PAYMENT_INVALID");
  });

  it("verifies without settling and attaches a pending payment", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xPayer123", amountUsd: "0.001", facilitator: "coinbase" });
    mockSettleX402Payment.mockResolvedValue({ txHash: "0xTx123", amountSettled: "1000", facilitator: "coinbase" });

    const req = makeRequest({ "x-payment": "valid-data" });
    const res = makeResponse();
    const handled = await handleX402Http(req, res);

    expect(handled).toBe(true);
    expect(isX402Verified(req)).toBe(true);
    // Settlement is deferred until the relay stream is open
    expect(mockSettleX402Payment).not.toHaveBeenCalled();

    const data = getX402Data(req);
    expect(data).not.toBeNull();
    expect(data!.payer).toBe("0xPayer123");
    expect(data!.facilitator).toBe("coinbase");
    expect(data!.poolType).toBe("any"); // no class requested: highest price, any node
    expect(data!.maxResponseBytes).toBe(10_485_760);
    expect(data!.pending!.state).toBe("verified");

    expect(await settleX402Pending(data!.pending!)).toBe(true);
    expect(mockSettleX402Payment).toHaveBeenCalledWith("valid-data", "coinbase", mockRequirements);
    expect(mockUpdateX402Transaction).toHaveBeenCalled();
    expect(data!.pending!.paymentHeader).toBe("");
  });
  it("settleX402Pending returns false and releases the hash when settlement fails", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xPayer123", amountUsd: "0.001", facilitator: "coinbase" });
    mockSettleX402Payment.mockRejectedValue(new Error("settlement failed"));

    const req = makeRequest({ "x-payment": "valid-data" });
    await handleX402Http(req, makeResponse());
    const p = getX402Data(req)!.pending!;
    expect(await settleX402Pending(p)).toBe(false);
    expect(mockReleasePaymentHash).toHaveBeenCalledWith("fakehash123");
    expect(mockUpdateX402Transaction).not.toHaveBeenCalled();
    expect(p.state).toBe("released");
  });
  it("uses residential pool type from header", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xP", amountUsd: "0.005", facilitator: "coinbase" });
    mockSettleX402Payment.mockResolvedValue({ txHash: "0xTx", amountSettled: "5000", facilitator: "coinbase" });

    const req = makeRequest({ "x-payment": "data", "x-pool-type": "residential" });
    const res = makeResponse();
    await handleX402Http(req, res);

    const data = getX402Data(req);
    expect(data!.poolType).toBe("residential");
  });
});

// ─── Relay pricing + payer identity (DESIGN.md §7) ──────────────────

describe("x402 relay identity and pricing", () => {
  const valid = { valid: true, payer: "0x" + "a".repeat(40), amountUsd: "0.001", facilitator: "coinbase" };
  beforeEach(() => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockSettleX402Payment.mockResolvedValue({ txHash: "0xTx", amountSettled: "1000", facilitator: "coinbase" });
  });

  it("quotes price_per_gb × X402_BYTES_PER_REQUEST in µUSD", async () => {
    const { x402AmountMusd } = await import("./x402-handler.js");
    expect(x402AmountMusd(500_000n, 10_485_760)).toBe(5243n); // ceil(500000*10485760/1e9)
    expect(x402AmountMusd(1n, 1)).toBe(1n);
    mockVerifyX402Payment.mockResolvedValue(valid);
    await handleX402Http(makeRequest({ "x-payment": "p" }), makeResponse());
    expect(mockBuildX402Requirements).toHaveBeenCalledWith({ amountMusd: 525n });
  });

  it("maps the payer to a wallet-identity user before settling", async () => {
    mockVerifyX402Payment.mockResolvedValue(valid);
    const req = makeRequest({ "x-payment": "p" });
    await handleX402Http(req, makeResponse());
    expect(mockFindOrCreateX402User).toHaveBeenCalledWith(valid.payer);
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
    const d = getX402Data(req)!;
    expect(d.userId).toBe("user-x402");
    // Gross is the verified paid amount (0.001 USD), not the 525 µUSD quote
    expect(d.amountMusd).toBe(1000n);
    expect(d.pricePerGbMusd).toBe(50_000n);
  });

  it("refuses a suspended payer without settling and releases the hash", async () => {
    mockVerifyX402Payment.mockResolvedValue(valid);
    mockFindOrCreateX402User.mockResolvedValue({ id: "u", status: "suspended", created: false });
    const res = makeResponse();
    const req = makeRequest({ "x-payment": "p" });
    await handleX402Http(req, res);
    expect(res._statusCode).toBe(403);
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
    expect(mockReleasePaymentHash).toHaveBeenCalledWith("fakehash123");
    expect(isX402Verified(req)).toBe(false);
  });

  it("refuses a non-EVM payer without settling", async () => {
    mockVerifyX402Payment.mockResolvedValue({ ...valid, payer: "So1anaPayer" });
    mockFindOrCreateX402User.mockRejectedValue(new Error("x402 payer must be an EVM address"));
    const res = makeResponse();
    await handleX402Http(makeRequest({ "x-payment": "p" }), res);
    expect(res._statusCode).toBe(402);
    expect(res._written).toContain("X402_PAYER_UNSUPPORTED");
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
  });

  it("refuses an underpaid payment without settling", async () => {
    mockVerifyX402Payment.mockResolvedValue({ ...valid, amountUsd: "0.000488" });
    const res = makeResponse();
    await handleX402Http(makeRequest({ "x-payment": "p" }), res);
    expect(res._statusCode).toBe(402);
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
    expect(mockFindOrCreateX402User).not.toHaveBeenCalled();
  });

  it("rejects a replayed payment (claimed hash) without identity or settlement", async () => {
    mockVerifyX402Payment.mockResolvedValue({ valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Payment already used" });
    const res = makeResponse();
    await handleX402Http(makeRequest({ "x-payment": "p" }), res);
    expect(res._statusCode).toBe(402);
    expect(res._written).toContain("Payment already used");
    expect(mockFindOrCreateX402User).not.toHaveBeenCalled();
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
  });

  it("settles against the relay-priced requirements", async () => {
    mockVerifyX402Payment.mockResolvedValue(valid);
    const req = makeRequest({ "x-payment": "p" });
    await handleX402Http(req, makeResponse());
    await settleX402Pending(getX402Data(req)!.pending!);
    expect(mockSettleX402Payment).toHaveBeenCalledWith("p", "coinbase", mockRequirements);
  });

  it("rejects a payment above the overpay sanity cap without settling", async () => {
    mockVerifyX402Payment.mockResolvedValue({ ...valid, amountUsd: "1.0" }); // >> 100 × 525 µUSD
    const res = makeResponse();
    const req = makeRequest({ "x-payment": "p" });
    await handleX402Http(req, res);
    expect(res._statusCode).toBe(402);
    expect(isX402Verified(req)).toBe(false);
    expect(mockReleasePaymentHash).toHaveBeenCalledWith("fakehash123");
  });

  it("releaseX402Pending releases a verified payment once and never settles it", async () => {
    mockVerifyX402Payment.mockResolvedValue(valid);
    const req = makeRequest({ "x-payment": "p" });
    await handleX402Http(req, makeResponse());
    const p = getX402Data(req)!.pending!;
    await releaseX402Pending(p);
    await releaseX402Pending(p);
    expect(mockReleasePaymentHash).toHaveBeenCalledTimes(1);
    expect(await settleX402Pending(p)).toBe(false);
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
  });

  it("refundX402Payer credits the payer's wallet once, only after settlement", async () => {
    mockVerifyX402Payment.mockResolvedValue({ ...valid, amountUsd: "0.012345" });
    const req = makeRequest({ "x-payment": "p" });
    await handleX402Http(req, makeResponse());
    const p = getX402Data(req)!.pending!;
    expect(await refundX402Payer(p, "x")).toBe(false); // not settled → nothing taken, nothing refunded
    await settleX402Pending(p);
    mockGetWallet.mockResolvedValueOnce(null);
    mockCreateWallet.mockResolvedValueOnce({ id: "w-new" });
    expect(await refundX402Payer(p, "upstream error")).toBe(true);
    expect(mockCreateWallet).toHaveBeenCalledWith("user-x402");
    // 12345 µUSD → floor to 1 cent (never refund more than was paid)
    expect(mockCreditWallet).toHaveBeenCalledWith("user-x402", 1, "x402", "x402-refund:fakehash123", expect.stringContaining("upstream error"));
    expect(await refundX402Payer(p, "again")).toBe(false);
    expect(mockCreditWallet).toHaveBeenCalledTimes(1);
  });
  it("refundX402Payer records a Solana payer's refund as owed (12,345 µUSD) instead of crediting an unreachable wallet", async () => {
    const SOL = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    mockVerifyX402Payment.mockResolvedValue({ ...valid, payer: SOL, amountUsd: "0.012345" });
    mockRecordOwed.mockResolvedValue(true);
    const req = makeRequest({ "x-payment": "p" });
    await handleX402Http(req, makeResponse());
    const p = getX402Data(req)!.pending!;
    await settleX402Pending(p);
    expect(await refundX402Payer(p, "upstream error")).toBe(true);
    expect(mockRecordOwed).toHaveBeenCalledWith({ payerAddress: SOL, rail: "x402", payHash: "fakehash123", amountMusd: 12_345n, reason: "upstream error" });
    expect(mockCreditWallet).not.toHaveBeenCalled();
  });
  it("CONNECT: suspended payer is refused before settlement", async () => {
    mockVerifyX402Payment.mockResolvedValue(valid);
    mockFindOrCreateX402User.mockResolvedValue({ id: "u", status: "suspended", created: false });
    const socket = makeSocket();
    const r = await handleX402Connect(makeRequest({ "x-payment": "p" }), socket);
    expect(r!.verified).toBe(false);
    expect(socket._written).toContain("ACCOUNT_SUSPENDED");
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
  });

  it("sanctioned payer wallet is refused before settlement and its payment hash released", async () => {
    configurePayerScreening({ path: "/x", required: true, load: async () => new Set(["0x" + "a".repeat(40)]) });
    try {
      mockVerifyX402Payment.mockResolvedValue({ ...valid, payer: "0x" + "A".repeat(40) });
      const socket = makeSocket();
      const r = await handleX402Connect(makeRequest({ "x-payment": "p" }), socket);
      expect(r!.verified).toBe(false);
      expect(socket._written).toContain("PAYER_SANCTIONED");
      expect(mockSettleX402Payment).not.toHaveBeenCalled();
      expect(mockFindOrCreateX402User).not.toHaveBeenCalled();
      expect(mockReleasePaymentHash).toHaveBeenCalled();
    } finally {
      configurePayerScreening({ path: undefined, required: false });
    }
  });

  it("fails closed (503) when screening is required and the list is missing", async () => {
    configurePayerScreening({ path: undefined, required: true, load: async () => { throw new Error("missing"); } });
    try {
      mockVerifyX402Payment.mockResolvedValue(valid);
      const socket = makeSocket();
      await handleX402Connect(makeRequest({ "x-payment": "p" }), socket);
      expect(socket._written).toContain("PAYER_SCREENING_UNAVAILABLE");
      expect(mockSettleX402Payment).not.toHaveBeenCalled();
    } finally {
      configurePayerScreening({ path: undefined, required: false });
    }
  });

  it("returns 503 when pricing is unavailable (no verify, no charge)", async () => {
    mockGetPricing.mockRejectedValue(new Error("db down"));
    const res = makeResponse();
    await handleX402Http(makeRequest({ "x-payment": "p" }), res);
    expect(res._statusCode).toBe(503);
    expect(mockVerifyX402Payment).not.toHaveBeenCalled();
  });
});

// ─── handleX402Connect ───────────────────────────────────────────────

describe("handleX402Connect", () => {
  it("returns null when x402 disabled", async () => {
    mockIsX402Enabled.mockReturnValue(false);
    const req = makeRequest({ "x-payment": "data" });
    const socket = makeSocket();
    const result = await handleX402Connect(req, socket);
    expect(result).toBeNull();
  });

  it("returns null when no X-PAYMENT header", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    const req = makeRequest({});
    const socket = makeSocket();
    const result = await handleX402Connect(req, socket);
    expect(result).toBeNull();
  });

  it("sends 402 on invalid payment and returns handled", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: false, payer: "", amountUsd: "0", facilitator: "coinbase", error: "Invalid" });

    const req = makeRequest({ "x-payment": "bad" });
    const socket = makeSocket();
    const result = await handleX402Connect(req, socket);

    expect(result).not.toBeNull();
    expect(result!.handled).toBe(true);
    expect(result!.verified).toBe(false);
    expect(socket._written).toContain("402");
    expect(socket._written).toContain("X402_PAYMENT_INVALID");
  });

  it("verifies without settling and returns a pending payment", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xPayer", amountUsd: "0.001", facilitator: "coinbase" });

    const req = makeRequest({ "x-payment": "good" });
    const socket = makeSocket();
    const result = await handleX402Connect(req, socket);

    expect(result).not.toBeNull();
    expect(result!.verified).toBe(true);
    expect(result!.payer).toBe("0xPayer");
    expect(result!.facilitator).toBe("coinbase");
    expect(result!.maxResponseBytes).toBe(10_485_760);
    expect(result!.amountMusd).toBe(1000n);
    expect(result!.pending!.state).toBe("verified");
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
    expect(socket._written).toBe("");
  });
  it("CONNECT pending settles later and releases on failure", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xPayer", amountUsd: "0.001", facilitator: "coinbase" });
    mockSettleX402Payment.mockRejectedValue(new Error("settlement failed"));

    const result = await handleX402Connect(makeRequest({ "x-payment": "good" }), makeSocket());
    expect(await settleX402Pending(result!.pending!)).toBe(false);
    expect(mockReleasePaymentHash).toHaveBeenCalledWith("fakehash123");
    expect(mockUpdateX402Transaction).not.toHaveBeenCalled();
  });
});

// ─── settleX402HttpRequest (no-op, kept for API compat) ─────────────

describe("settleX402HttpRequest", () => {
  it("is a no-op — settlement already done in handleX402Http", async () => {
    const req = makeRequest({});
    await settleX402HttpRequest(req, "example.com");
    // C-2: settle-before-proxy — these functions are now no-ops
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
    expect(mockUpdateX402Transaction).not.toHaveBeenCalled();
  });

  it("is a no-op even for verified x402 requests", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xP", amountUsd: "0.001", facilitator: "coinbase" });
    mockSettleX402Payment.mockResolvedValue({ txHash: "0xTx", amountSettled: "1000", facilitator: "coinbase" });

    const req = makeRequest({ "x-payment": "valid" });
    const res = makeResponse();
    await handleX402Http(req, res);

    vi.clearAllMocks();
    await settleX402HttpRequest(req, "target.com");

    // No additional settle/record calls from the no-op
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
    expect(mockUpdateX402Transaction).not.toHaveBeenCalled();
  });
});

// ─── settleX402ConnectRequest (no-op, kept for API compat) ──────────

describe("settleX402ConnectRequest", () => {
  it("is a no-op — settlement already done in handleX402Connect", async () => {
    await settleX402ConnectRequest(
      { handled: true, verified: false, payer: "", facilitator: "coinbase", poolType: "dc", paymentHeader: "", amountUsd: "0", maxResponseBytes: 0 },
      "target.com",
    );
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
    expect(mockUpdateX402Transaction).not.toHaveBeenCalled();
  });

  it("is a no-op even for verified CONNECT results", async () => {
    await settleX402ConnectRequest(
      { handled: true, verified: true, payer: "0xP", facilitator: "coinbase", poolType: "dc", paymentHeader: "data", amountUsd: "0.001", maxResponseBytes: 10_485_760 },
      "target.com",
    );
    expect(mockSettleX402Payment).not.toHaveBeenCalled();
    expect(mockUpdateX402Transaction).not.toHaveBeenCalled();
  });
});

// ─── build402ResponseBody ────────────────────────────────────────────

describe("build402ResponseBody", () => {
  it("returns plain text when x402 disabled", () => {
    mockIsX402Enabled.mockReturnValue(false);
    const body = build402ResponseBody("dc");
    expect(body).toContain("Insufficient balance");
    expect(body).not.toContain("x402");
  });

  it("returns JSON with x402 requirements when enabled", () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    const body = build402ResponseBody("dc");
    const parsed = JSON.parse(body);
    expect(parsed.error).toBe("INSUFFICIENT_BALANCE");
    expect(parsed.x402).toBeDefined();
    expect(parsed.x402.version).toBe("1");
  });
});

// ─── build402ConnectResponse ─────────────────────────────────────────

describe("build402ConnectResponse", () => {
  it("returns simple 402 response when x402 disabled", () => {
    mockIsX402Enabled.mockReturnValue(false);
    const response = build402ConnectResponse("dc");
    expect(response).toContain("402 Payment Required");
    expect(response).toContain("INSUFFICIENT_BALANCE");
    expect(response).not.toContain("x402");
  });

  it("includes x402 JSON body when enabled", () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    const response = build402ConnectResponse("dc");
    expect(response).toContain("402 Payment Required");
    expect(response).toContain("application/json");
    expect(response).toContain("INSUFFICIENT_BALANCE");
  });
});

// ─── isX402Verified / getX402Data ────────────────────────────────────

describe("isX402Verified / getX402Data", () => {
  it("returns false for plain request", () => {
    const req = makeRequest({});
    expect(isX402Verified(req)).toBe(false);
    expect(getX402Data(req)).toBeNull();
  });
});

// ─── MPP ─────────────────────────────────────────────────────────────

describe("MPP on the gateway", () => {
  const MPP_PAYER = "0x" + "4".repeat(40);
  const rail = {
    id: "mpp" as const,
    enabled: () => true,
    challenge: vi.fn((amt: bigint) => ({ id: "cid", realm: "dn", method: "tempo", intent: "charge", request: `r${amt}`, expires: "2027-01-01T00:00:00Z", header: `Payment id="cid", request="r${amt}"` })),
    requirements: vi.fn(),
    parseHeader: (h: http.IncomingHttpHeaders) => {
      const v = String(h["authorization"] ?? h["proxy-authorization"] ?? "");
      return /^Payment /.test(v) ? v.slice(8) : null;
    },
    verify: vi.fn(),
    settle: vi.fn(),
    release: vi.fn(async () => {}),
    recordRefund: vi.fn(async () => {}),
    unclaim: vi.fn(async () => true),
  };
  const okVerify = (amountMusd = 525n) => ({ ok: true, payer: MPP_PAYER, paymentHash: "h".repeat(64), amountMusd, txRef: "tempo:1:0xabc" });

  beforeEach(() => {
    setMppRailForTest(rail as any);
    rail.verify.mockReset();
    rail.settle.mockReset();
    rail.release.mockClear();
    rail.recordRefund.mockClear();
    rail.unclaim.mockClear();
  });

  it("credits a paid challenge below the live quote (524 µUSD paid, quote 525) and does not serve it", async () => {
    rail.verify.mockResolvedValue(okVerify(524n));
    const res = makeResponse();
    const req = makeRequest({ authorization: "Payment tok" });
    await handleX402Http(req, res);
    expect(res._statusCode).toBe(402);
    expect(getX402Data(req)).toBeNull();
    expect(rail.release).toHaveBeenCalledWith("h".repeat(64));
    expect(rail.recordRefund).toHaveBeenCalledWith("h".repeat(64), expect.objectContaining({ userId: "user-x402", refundMusd: 524n, reason: "payment below current quote" }));
  });

  it("records and credits a verifier refusal (source mismatch) instead of dropping it: 1,000,000 µUSD -> 100 cents", async () => {
    rail.verify.mockResolvedValue({ ...okVerify(1_000_000n), refuse: "verification-failed: source mismatch" });
    mockCreditWallet.mockClear();
    const res = makeResponse();
    await handleX402Http(makeRequest({ authorization: "Payment tok" }), res);
    expect(res._statusCode).toBe(402);
    expect(mockCreditWallet).toHaveBeenCalledWith("user-x402", 100, "mpp", `mpp-refund:${"h".repeat(64)}`, expect.any(String));
    expect(rail.recordRefund).toHaveBeenCalledWith("h".repeat(64), expect.objectContaining({ refundMusd: 1_000_000n, creditedCents: 100 }));
  });

  it("transient payer-identity outage drops the uncredited claim so the same transfer can be retried", async () => {
    rail.verify.mockResolvedValue(okVerify());
    mockFindOrCreateX402User.mockRejectedValueOnce(new Error("db down"));
    const res = makeResponse();
    await handleX402Http(makeRequest({ authorization: "Payment tok" }), res);
    expect(res._statusCode).toBe(503);
    expect(rail.unclaim).toHaveBeenCalledWith("h".repeat(64));
    expect(rail.release).not.toHaveBeenCalled();
    expect(rail.recordRefund).not.toHaveBeenCalled();
  });
  afterEach(() => setMppRailForTest(null));

  it("HTTP: verifies (no settle yet), maps the payer and marks rail mpp", async () => {
    rail.verify.mockResolvedValue(okVerify());
    const req = makeRequest({ authorization: "Payment tok" });
    expect(await handleX402Http(req, makeResponse())).toBe(true);
    const d = getX402Data(req)!;
    expect(d).toMatchObject({ rail: "mpp", payer: MPP_PAYER, userId: "user-x402", amountMusd: 525n });
    expect(rail.verify).toHaveBeenCalledWith("tok", { amountMusd: 525n, resource: "relay" });
    expect(rail.settle).not.toHaveBeenCalled();
    expect(mockFindOrCreateX402User).toHaveBeenCalledWith(MPP_PAYER);
  });

  it("HTTP: invalid credential → 402 with a fresh WWW-Authenticate challenge and no-store", async () => {
    rail.verify.mockResolvedValue({ ok: false, paymentHash: "x", reason: "invalid-challenge" });
    const res = makeResponse();
    await handleX402Http(makeRequest({ authorization: "Payment tok" }), res);
    expect(res._statusCode).toBe(402);
    expect(res._headers["WWW-Authenticate"]).toMatch(/^Payment id="cid"/);
    expect(res._headers["Cache-Control"]).toBe("no-store");
    expect(mockFindOrCreateX402User).not.toHaveBeenCalled();
  });

  it("keeps the claim of a refused payer (funds moved) and credits nobody when the payer is suspended", async () => {
    rail.verify.mockResolvedValue(okVerify());
    mockFindOrCreateX402User.mockResolvedValueOnce({ id: "u", status: "suspended", created: false });
    const res = makeResponse();
    await handleX402Http(makeRequest({ authorization: "Payment tok" }), res);
    expect(res._statusCode).toBe(403);
    expect(rail.release).toHaveBeenCalledWith("h".repeat(64)); // -> refund_due, never deleted
    expect(rail.recordRefund).toHaveBeenCalledWith("h".repeat(64), expect.objectContaining({ userId: null, refundMusd: 525n, creditedCents: 0 }));
    expect(mockCreditWallet).not.toHaveBeenCalled();
    expect(rail.settle).not.toHaveBeenCalled();
  });

  it("serves an overpayment at the 100x cap and credits the excess (2,052,500 paid on a 525 quote -> 200 cents)", async () => {
    rail.verify.mockResolvedValue(okVerify(2_052_500n));
    const req = makeRequest({ authorization: "Payment tok" });
    await handleX402Http(req, makeResponse());
    expect(getX402Data(req)).toMatchObject({ rail: "mpp", amountMusd: 52_500n });
    expect(mockCreditWallet).toHaveBeenCalledWith("user-x402", 200, "mpp", `mpp-excess:${"h".repeat(64)}`, expect.any(String));
    expect(rail.recordRefund).toHaveBeenCalledWith("h".repeat(64), expect.objectContaining({ refundMusd: 2_000_000n, creditedCents: 200, closeClaim: false }));
    expect(rail.release).not.toHaveBeenCalled();
  });

  it("CONNECT: Proxy-Authorization Payment → verified mpp result; settle after, refund to identity user as provider mpp", async () => {
    rail.verify.mockResolvedValue(okVerify());
    rail.settle.mockResolvedValue({ ok: true, txRef: "tempo:1:0xabc" });
    const r = (await handleX402Connect(makeRequest({ "proxy-authorization": "Payment tok" }), makeSocket()))!;
    expect(r).toMatchObject({ rail: "mpp", verified: true, userId: "user-x402", amountMusd: 525n });
    expect(rail.settle).not.toHaveBeenCalled();
    expect(await settleX402Pending(r.pending!)).toBe(true);
    expect(await settleX402Pending(r.pending!)).toBe(true); // idempotent
    expect(rail.settle).toHaveBeenCalledTimes(1);
    // 525 µUSD paid → floor 0 cents: nothing minted, sub-cent remainder stays with the platform
    expect(await refundX402Payer(r.pending!, "upstream failed")).toBe(true);
    expect(mockCreditWallet).not.toHaveBeenCalled();
    expect(await refundX402Payer(r.pending!, "again")).toBe(false); // once
  });

  it("CONNECT: a refusal after verify keeps the claim and credits the payer (52,499 µUSD -> 5 cents)", async () => {
    rail.verify.mockResolvedValue(okVerify(52_499n));
    rail.settle.mockResolvedValue({ ok: false });
    const r = (await handleX402Connect(makeRequest({ "proxy-authorization": "Payment tok" }), makeSocket()))!;
    expect(await settleX402Pending(r.pending!)).toBe(false);
    expect(rail.release).toHaveBeenCalledWith("h".repeat(64));
    expect(mockCreditWallet).toHaveBeenCalledWith("user-x402", 5, "mpp", `mpp-refund:${"h".repeat(64)}`, expect.any(String));
    expect(rail.recordRefund).toHaveBeenCalledWith("h".repeat(64), expect.objectContaining({ userId: "user-x402", refundMusd: 52_499n, creditedCents: 5, closeClaim: true }));
  });

  it("CONNECT: rejection writes a 402 with the challenge", async () => {
    rail.verify.mockResolvedValue({ ok: false, paymentHash: "x", reason: "payment-expired" });
    const sock = makeSocket();
    const r = (await handleX402Connect(makeRequest({ "proxy-authorization": "Payment tok" }), sock))!;
    expect(r.verified).toBe(false);
    expect(sock._written).toMatch(/^HTTP\/1\.1 402 [\s\S]*WWW-Authenticate: Payment id="cid"/);
  });

  it("402 builders advertise MPP alongside x402", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue({ accepts: [] });
    build402ResponseBody("dc"); // warms the quote
    await new Promise((r) => setTimeout(r, 0));
    const body = JSON.parse(build402ResponseBody("dc"));
    expect(body.x402).toBeDefined();
    expect(body.mpp.wwwAuthenticate).toMatch(/^Payment /);
    expect(paymentChallengeHeaders("dc")["WWW-Authenticate"]).toMatch(/^Payment /);
    expect(build402ConnectResponse("dc")).toMatch(/WWW-Authenticate: Payment /);
  });

  it("x402AmountMusd quotes 10 MiB at the decimal-GB price: 5243 / 2098 / 1049 µUSD", async () => {
    const { x402AmountMusd } = await import("./x402-handler.js");
    expect(x402AmountMusd(500_000n)).toBe(5243n);
    expect(x402AmountMusd(200_000n)).toBe(2098n);
    expect(x402AmountMusd(100_000n)).toBe(1049n);
  });

  it("advertises the default class price before the first quote is cached (masked: 1049 µUSD, not the env price)", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue({ accepts: [] });
    mockGetPricing.mockReturnValue(new Promise(() => undefined)); // quote never resolves
    build402ResponseBody("masked");
    expect(mockBuildX402Requirements).toHaveBeenCalledWith({ amountMusd: 1049n });
  });

  it("normalizePayer keeps Solana case, lowercases EVM", () => {
    expect(normalizePayer("0xABC")).toBe("0xabc");
    expect(normalizePayer("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")).toBe("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
  });
});

describe("x402 exit class (same username flags as API-key auth)", () => {
  const req = (headers: Record<string, string>) => ({ headers } as unknown as http.IncomingMessage);
  const basic = (user: string) => "Basic " + Buffer.from(`${user}:`).toString("base64");

  it("parses class-* flags from a Basic username, incl. mobile", async () => {
    const { getPoolTypeFromRequest } = await import("./x402-handler.js");
    expect(getPoolTypeFromRequest(req({ "proxy-authorization": basic("country-US-class-mobile") }))).toBe("mobile");
    expect(getPoolTypeFromRequest(req({ "proxy-authorization": basic("class-residential-session-x") }))).toBe("residential");
    expect(getPoolTypeFromRequest(req({ "proxy-authorization": basic("dc-country-DE") }))).toBe("dc");
  });

  it("falls back to X-Pool-Type, then 'any' (never defaults to the cheap dc class)", async () => {
    const { getPoolTypeFromRequest } = await import("./x402-handler.js");
    expect(getPoolTypeFromRequest(req({ "x-pool-type": "mobile" }))).toBe("mobile");
    expect(getPoolTypeFromRequest(req({ "x-pool-type": "bogus" }))).toBe("any");
    expect(getPoolTypeFromRequest(req({}))).toBe("any");
    expect(getPoolTypeFromRequest(req({ "proxy-authorization": basic("relay"), "x-pool-type": "dc" }))).toBe("dc");
  });

  it("node must match the quoted class unless the quote is 'any'", async () => {
    const { nodeMatchesQuotedClass, selectClassFor, toX402Class } = await import("./x402-handler.js");
    expect(nodeMatchesQuotedClass("residential", "residential")).toBe(true);
    expect(nodeMatchesQuotedClass("residential", "dc")).toBe(false);
    expect(nodeMatchesQuotedClass("mobile", "residential")).toBe(false);
    expect(nodeMatchesQuotedClass("any", "dc")).toBe(true);
    expect(selectClassFor("any")).toBeUndefined();
    expect(toX402Class("unknown")).toBe("any");
  });
});

describe("x402 rate limiter when the map is full", () => {
  it("keeps serving existing payers and refuses only new keys", () => {
    resetX402RateLimitsForTest();
    expect(checkX402RateLimitForTest("existing")).toBe(true);
    for (let i = 0; i < 100_000; i++) checkX402RateLimitForTest(`spam-${i}`);
    expect(checkX402RateLimitForTest("brand-new")).toBe(false);
    expect(checkX402RateLimitForTest("existing")).toBe(true);
    resetX402RateLimitsForTest();
  });
});
