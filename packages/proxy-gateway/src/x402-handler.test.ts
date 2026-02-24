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
}));

vi.mock("@dominusnode/shared", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const origEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["X402_RATE_LIMIT_MAX"];
  mockHashPaymentHeader.mockReturnValue("fakehash123");
  mockUpdateX402Transaction.mockResolvedValue(undefined);
  mockReleasePaymentHash.mockResolvedValue(undefined);
  mockGetX402MaxResponseBytes.mockReturnValue(10_485_760);
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
} from "./x402-handler.js";

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

  it("settles before proxy and marks request as verified on valid payment", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xPayer123", amountUsd: "0.001", facilitator: "coinbase" });
    mockSettleX402Payment.mockResolvedValue({ txHash: "0xTx123", amountSettled: "1000", facilitator: "coinbase" });

    const req = makeRequest({ "x-payment": "valid-data" });
    const res = makeResponse();
    const handled = await handleX402Http(req, res);

    expect(handled).toBe(true);
    expect(isX402Verified(req)).toBe(true);
    // Settlement happened inside handleX402Http (settle-before-proxy)
    expect(mockSettleX402Payment).toHaveBeenCalledOnce();
    expect(mockUpdateX402Transaction).toHaveBeenCalled();

    const data = getX402Data(req);
    expect(data).not.toBeNull();
    expect(data!.payer).toBe("0xPayer123");
    expect(data!.facilitator).toBe("coinbase");
    expect(data!.poolType).toBe("dc");
    expect(data!.maxResponseBytes).toBe(10_485_760);
  });

  it("returns 402 when settlement fails", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xPayer123", amountUsd: "0.001", facilitator: "coinbase" });
    mockSettleX402Payment.mockRejectedValue(new Error("settlement failed"));

    const req = makeRequest({ "x-payment": "valid-data" });
    const res = makeResponse();
    const handled = await handleX402Http(req, res);

    expect(handled).toBe(true);
    expect(isX402Verified(req)).toBe(false);
    expect(res._statusCode).toBe(402);
    expect(res._written).toContain("X402_SETTLEMENT_FAILED");
    // C-3: Should release pending hash on failure (not record failed tx)
    expect(mockReleasePaymentHash).toHaveBeenCalledWith("fakehash123");
    expect(mockUpdateX402Transaction).not.toHaveBeenCalled();
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

  it("settles before tunnel and returns verified result on valid payment", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xPayer", amountUsd: "0.001", facilitator: "coinbase" });
    mockSettleX402Payment.mockResolvedValue({ txHash: "0xTx", amountSettled: "1000", facilitator: "coinbase" });

    const req = makeRequest({ "x-payment": "good" });
    const socket = makeSocket();
    const result = await handleX402Connect(req, socket);

    expect(result).not.toBeNull();
    expect(result!.verified).toBe(true);
    expect(result!.payer).toBe("0xPayer");
    expect(result!.facilitator).toBe("coinbase");
    expect(result!.maxResponseBytes).toBe(10_485_760);
    // Settlement happened inside handleX402Connect (settle-before-tunnel)
    expect(mockSettleX402Payment).toHaveBeenCalledOnce();
    expect(mockUpdateX402Transaction).toHaveBeenCalled();
  });

  it("sends 402 when settlement fails", async () => {
    mockIsX402Enabled.mockReturnValue(true);
    mockBuildX402Requirements.mockReturnValue(mockRequirements);
    mockVerifyX402Payment.mockResolvedValue({ valid: true, payer: "0xPayer", amountUsd: "0.001", facilitator: "coinbase" });
    mockSettleX402Payment.mockRejectedValue(new Error("settlement failed"));

    const req = makeRequest({ "x-payment": "good" });
    const socket = makeSocket();
    const result = await handleX402Connect(req, socket);

    expect(result).not.toBeNull();
    expect(result!.handled).toBe(true);
    expect(result!.verified).toBe(false);
    expect(socket._written).toContain("402");
    expect(socket._written).toContain("X402_SETTLEMENT_FAILED");
    // C-3: Should release pending hash on failure (not record failed tx)
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
