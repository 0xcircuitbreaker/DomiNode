import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAtomic = vi.fn();
const mockFindInvoice = vi.fn();

vi.mock("@dominusnode/shared", () => ({
  walletRepo: { atomicCompleteInvoiceAndCredit: (...a: unknown[]) => mockAtomic(...a) },
  invoiceRepo: {
    findInvoice: (...a: unknown[]) => mockFindInvoice(...a),
    failInvoice: vi.fn(),
    markCreditFailed: vi.fn(),
    createInvoice: vi.fn(),
  },
  referralRepo: { recordAffiliateCommission: vi.fn().mockResolvedValue(undefined) },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { capturePaypalOrder } from "./paypal.js";

function captureResponse(captureStatus: string, currency = "USD") {
  return {
    ok: true,
    status: 201,
    text: () =>
      Promise.resolve(
        JSON.stringify({
          id: "ORDER12345",
          status: "COMPLETED",
          purchase_units: [{ payments: { captures: [{ status: captureStatus, amount: { value: "10.00", currency_code: currency } }] } }],
        }),
      ),
  };
}

describe("capturePaypalOrder capture status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    process.env["PAYPAL_CLIENT_ID"] = "id";
    process.env["PAYPAL_CLIENT_SECRET"] = "secret";
    mockFindInvoice.mockResolvedValue({ id: "inv1", user_id: "u1", amount_cents: 1000, status: "pending" });
    mockAtomic.mockResolvedValue({ claimed: true });
    // OAuth token response (may be cached after first test)
    mockFetch.mockImplementation((url: string) =>
      url.includes("oauth2/token")
        ? Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(JSON.stringify({ access_token: "tok", expires_in: 3600 })),
            json: () => Promise.resolve({ access_token: "tok", expires_in: 3600 }),
          })
        : Promise.reject(new Error("unexpected")),
    );
  });

  function withCapture(resp: ReturnType<typeof captureResponse>) {
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((url: string, init?: unknown) =>
      url.includes("/capture") ? Promise.resolve(resp) : base(url, init),
    );
  }

  it("credits when capture is COMPLETED in USD", async () => {
    withCapture(captureResponse("COMPLETED"));
    await expect(capturePaypalOrder("ORDER12345", "u1")).resolves.toEqual({ userId: "u1", amountCents: 1000 });
    expect(mockAtomic).toHaveBeenCalledOnce();
  });

  it("does not credit when capture is PENDING", async () => {
    withCapture(captureResponse("PENDING"));
    await expect(capturePaypalOrder("ORDER12345", "u1")).resolves.toBeNull();
    expect(mockAtomic).not.toHaveBeenCalled();
  });

  it("does not credit non-USD capture", async () => {
    withCapture(captureResponse("COMPLETED", "EUR"));
    await expect(capturePaypalOrder("ORDER12345", "u1")).resolves.toBeNull();
    expect(mockAtomic).not.toHaveBeenCalled();
  });
});
