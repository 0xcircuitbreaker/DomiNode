import { describe, it, expect, vi, beforeEach } from "vitest";
import * as crypto from "node:crypto";

const mockQuery = vi.fn();
const mockFindInvoice = vi.fn();
const mockCreateInvoice = vi.fn();
const mockFailInvoice = vi.fn();
const mockCredit = vi.fn();

vi.mock("@dominusnode/shared", async () => {
  const frame = await vi.importActual<typeof import("../../../../shared/src/tunnel/frame.js")>("../../../../shared/src/tunnel/frame.js");
  return {
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    query: (...a: unknown[]) => mockQuery(...a),
    stripDangerousKeys: frame.stripDangerousKeys,
    invoiceRepo: {
      findInvoice: (...a: unknown[]) => mockFindInvoice(...a),
      createInvoice: (...a: unknown[]) => mockCreateInvoice(...a),
      failInvoice: (...a: unknown[]) => mockFailInvoice(...a),
    },
    walletRepo: { atomicCompleteInvoiceAndCredit: (...a: unknown[]) => mockCredit(...a) },
  };
});

import { createHmacMppVerifier, createMppRail, type MppStore } from "./mpp-rail.js";
import { createTempoRail, verifyTempoSignature, TEMPO_MAX_BODY_BYTES } from "./tempo.js";
import { x402Rail, usdStringToMusd } from "./x402-rail.js";
import { nowpaymentsRail } from "./nowpayments.js";

const SECRET = "s".repeat(40);
const PAYER = "0x" + "a".repeat(40);
const NOW = 1_800_000_000;

function mppCred(body: Record<string, unknown> | string, secret = SECRET): string {
  const b64 = Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64url");
  return `${b64}.${crypto.createHmac("sha256", secret).update(b64).digest("hex")}`;
}
const goodBody = { payer: PAYER, amountMusd: "5000", resource: "relay", expiresAt: NOW + 60, nonce: "n1" };
const REQ = { amountMusd: 5000n, resource: "relay" };

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockReset();
  mockFindInvoice.mockReset();
  mockCredit.mockReset();
});

describe("MPP HMAC verifier", () => {
  const v = createHmacMppVerifier(SECRET);
  it("accepts a valid credential", () => {
    expect(v.verify(mppCred(goodBody), REQ, NOW)).toEqual({ ok: true, payer: PAYER, amountMusd: 5000n });
  });
  it("rejects a credential signed with another key", () => {
    expect(v.verify(mppCred(goodBody, "x".repeat(40)), REQ, NOW)).toMatchObject({ ok: false, reason: "bad signature" });
  });
  it("rejects a tampered body", () => {
    const c = mppCred(goodBody);
    const tampered = Buffer.from(JSON.stringify({ ...goodBody, amountMusd: "999999" })).toString("base64url") + c.slice(c.indexOf("."));
    expect(v.verify(tampered, REQ, NOW).ok).toBe(false);
  });
  it("rejects malformed, expired, underpaid and wrong-resource credentials", () => {
    expect(v.verify("nodot", REQ, NOW).ok).toBe(false);
    expect(v.verify("abc.zz", REQ, NOW).ok).toBe(false);
    expect(v.verify(mppCred({ ...goodBody, expiresAt: NOW - 1 }), REQ, NOW).reason).toBe("expired");
    expect(v.verify(mppCred({ ...goodBody, amountMusd: "4999" }), REQ, NOW).reason).toBe("amount insufficient");
    expect(v.verify(mppCred({ ...goodBody, resource: "other" }), REQ, NOW).reason).toBe("resource mismatch");
  });
  it("rejects far-future expiry, out-of-range amounts and array bodies", () => {
    expect(v.verify(mppCred({ ...goodBody, expiresAt: NOW + 3601 }), REQ, NOW).ok).toBe(false);
    expect(v.verify(mppCred({ ...goodBody, expiresAt: NOW + 3600 }), REQ, NOW).ok).toBe(true);
    // above the mpp_transactions CHECK: rejected instead of a DB error at claim time
    expect(v.verify(mppCred({ ...goodBody, amountMusd: "10000000001" }), REQ, NOW).reason).toBe("amount too large");
    expect(v.verify(mppCred("[1,2]"), REQ, NOW).ok).toBe(false);
  });
  it("strips prototype-pollution keys", () => {
    const raw = JSON.stringify(goodBody).replace(/}$/, ',"__proto__":{"admin":true}}');
    const r = v.verify(mppCred(raw), REQ, NOW);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
  });
  it("requires a long secret", () => {
    expect(() => createHmacMppVerifier("short")).toThrow();
  });
});

describe("MPP rail", () => {
  function store(claimed = true): MppStore {
    return { claim: vi.fn().mockResolvedValue(claimed), mark: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) };
  }
  it("is disabled without verifier/payTo", () => {
    expect(createMppRail({ verifier: null, payTo: null, store: store() }).enabled()).toBe(false);
  });
  it("verifies, claims and settles", async () => {
    const s = store();
    const rail = createMppRail({ verifier: createHmacMppVerifier(SECRET), payTo: PAYER, store: s, now: () => NOW });
    const v = await rail.verify(mppCred(goodBody), REQ);
    expect(v.ok).toBe(true);
    expect(s.claim).toHaveBeenCalledWith(v.paymentHash, 5000n);
    expect((await rail.settle("", REQ, v)).ok).toBe(true);
  });
  it("rejects a replayed credential", async () => {
    const rail = createMppRail({ verifier: createHmacMppVerifier(SECRET), payTo: PAYER, store: store(false), now: () => NOW });
    expect(await rail.verify(mppCred(goodBody), REQ)).toMatchObject({ ok: false, reason: "Payment already used" });
  });
  it("never claims on a bad signature", async () => {
    const s = store();
    const rail = createMppRail({ verifier: createHmacMppVerifier(SECRET), payTo: PAYER, store: s, now: () => NOW });
    expect((await rail.verify(mppCred(goodBody, "y".repeat(40)), REQ)).ok).toBe(false);
    expect(s.claim).not.toHaveBeenCalled();
  });
});

function tempoSig(body: Buffer, t: number, secret = SECRET): string {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex")}`;
}
const CHARGE = "tempo_" + "1".repeat(8) + "-1111-1111-1111-" + "1".repeat(12);
const TX = "0x" + "e".repeat(64);
const tempoBody = (o: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({ memo: CHARGE, status: "paid", amountCents: 500, txHash: TX, ...o }));

describe("Tempo prepaid rail", () => {
  const rail = createTempoRail({ webhookSecret: SECRET, payTo: PAYER }, () => NOW);
  const invoice = { id: "inv1", user_id: "u1", amount_cents: 500, status: "pending" };

  it("credits a correctly signed paid callback via atomicCompleteInvoiceAndCredit", async () => {
    mockFindInvoice.mockResolvedValue(invoice);
    mockCredit.mockResolvedValue({ claimed: true });
    const b = tempoBody();
    const r = await rail.handleCallback(b, { "x-tempo-signature": tempoSig(b, NOW) });
    expect(r).toMatchObject({ status: "paid", amountCents: 500, userId: "u1" });
    expect(mockCredit).toHaveBeenCalledWith("inv1", "u1", 500, "tempo", TX, expect.any(String));
  });

  it("rejects a wrong signature, missing signature and stale timestamp without touching the DB", async () => {
    const b = tempoBody();
    expect(await rail.handleCallback(b, { "x-tempo-signature": tempoSig(b, NOW, "z".repeat(40)) })).toBeNull();
    expect(await rail.handleCallback(b, {})).toBeNull();
    expect(await rail.handleCallback(b, { "x-tempo-signature": tempoSig(b, NOW - 301) })).toBeNull();
    expect(mockFindInvoice).not.toHaveBeenCalled();
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("rejects a body signed for different bytes", async () => {
    const b = tempoBody();
    const other = tempoBody({ amountCents: 100000 });
    expect(await rail.handleCallback(other, { "x-tempo-signature": tempoSig(b, NOW) })).toBeNull();
  });

  it("enforces the body size limit", async () => {
    const big = Buffer.alloc(TEMPO_MAX_BODY_BYTES + 1, 0x20);
    expect(await rail.handleCallback(big, { "x-tempo-signature": tempoSig(big, NOW) })).toBeNull();
  });

  it("refuses an amount mismatch", async () => {
    mockFindInvoice.mockResolvedValue(invoice);
    const b = tempoBody({ amountCents: 501 });
    expect(await rail.handleCallback(b, { "x-tempo-signature": tempoSig(b, NOW) })).toBeNull();
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("is inert when not configured", async () => {
    const off = createTempoRail(null);
    const b = tempoBody();
    expect(await off.handleCallback(b, { "x-tempo-signature": tempoSig(b, NOW) })).toBeNull();
    await expect(off.createCharge("u1", 500)).rejects.toThrow(/not configured/);
  });

  it("verifyTempoSignature rejects malformed headers", () => {
    const b = tempoBody();
    expect(verifyTempoSignature(b, "garbage", SECRET, NOW)).toBe(false);
    expect(verifyTempoSignature(b, `t=${NOW},v1=zz`, SECRET, NOW)).toBe(false);
  });
});

describe("x402 rail", () => {
  it("parses USD strings into µUSD exactly", () => {
    expect(usdStringToMusd("0.005000")).toBe(5000n);
    expect(usdStringToMusd("1")).toBe(1_000_000n);
    expect(usdStringToMusd("1.2345678")).toBeNull();
    expect(usdStringToMusd("-1")).toBeNull();
    expect(usdStringToMusd("NaN")).toBeNull();
  });

  it("caps the header size", () => {
    expect(x402Rail.parseHeader({ "x-payment": "a".repeat(10_001) })).toBeNull();
    expect(x402Rail.parseHeader({ "x-payment": "abc" })).toBe("abc");
    expect(x402Rail.parseHeader({})).toBeNull();
  });

  it("rejects a replayed payment before any facilitator call", async () => {
    process.env["X402_RECEIVING_ADDRESS"] = PAYER;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockQuery.mockResolvedValue({ rowCount: 0, rows: [] }); // claimPaymentHash → conflict
    const r = await x402Rail.verify(JSON.stringify({ network: "base", payload: { signature: "s" } }), { amountMusd: 5000n, resource: "relay" });
    expect(r).toMatchObject({ ok: false, reason: "Payment already used" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    delete process.env["X402_RECEIVING_ADDRESS"];
  });
});

describe("NOWPayments prepaid rail", () => {
  it("rejects oversized or unsigned bodies before signature work", async () => {
    expect(await nowpaymentsRail.handleCallback(Buffer.alloc(16 * 1024 + 1), { "x-nowpayments-sig": "x" })).toBeNull();
    expect(await nowpaymentsRail.handleCallback(Buffer.from("{}"), {})).toBeNull();
    expect(await nowpaymentsRail.handleCallback(Buffer.from("not json"), { "x-nowpayments-sig": "x" })).toBeNull();
  });
});
