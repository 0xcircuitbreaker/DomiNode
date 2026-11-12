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

import {
  createTempoMppVerifier, createMppRail, buildMppChallenge, computeChallengeId, parseMppAuthorization, mppPaymentHash, jcs,
  createTempoRpc, type MppStore, type MppConfig, type TempoRpc, type TempoReceipt,
} from "./mpp-rail.js";
import {
  createTempoRail, verifyTempoSignature, TEMPO_MAX_BODY_BYTES, chargeIdToMemo, memoToChargeId, TIP20_TRANSFER_WITH_MEMO_TOPIC,
} from "./tempo.js";
import { x402Rail, usdStringToMusd } from "./x402-rail.js";
import { nowpaymentsRail } from "./nowpayments.js";

const SECRET = "s".repeat(40);
const PAYER = "0x" + "a".repeat(40);
const NOW = 1_800_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  for (const m of [mockQuery, mockFindInvoice, mockCreateInvoice, mockFailInvoice, mockCredit]) m.mockReset();
});

// ─── MPP (Tempo charge) ─────────────────────────────────────────────

const RECIP = "0x" + "b".repeat(40);
const TOKEN = "0x20c0" + "0".repeat(36);
const CFG: MppConfig = { secret: SECRET, realm: "dn", recipient: RECIP, currency: TOKEN, chainId: 42431 };
const REQ = { amountMusd: 5000n, resource: "relay" };
const TXH = "0x" + "c".repeat(64);
const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2);

function challengeFields(amount = 5000n, now = NOW) {
  const { header: _h, ...c } = buildMppChallenge(CFG, amount, now);
  return c;
}
function cred(o: { challenge?: Record<string, unknown>; payload?: Record<string, unknown>; source?: string } = {}): string {
  return Buffer.from(JSON.stringify({
    challenge: o.challenge ?? challengeFields(),
    payload: o.payload ?? { type: "hash", hash: TXH },
    ...(o.source !== undefined ? { source: o.source } : {}),
  })).toString("base64url");
}
function receiptFor(challengeId: string, o: { amount?: bigint; to?: string; token?: string; memo?: string; status?: string; from?: string } = {}): TempoReceipt {
  const memo = o.memo ?? "0x" + crypto.createHash("sha256").update(challengeId).digest("hex");
  return {
    status: o.status ?? "0x1",
    logs: [{
      address: o.token ?? TOKEN,
      topics: [TIP20_TRANSFER_WITH_MEMO_TOPIC, pad(o.from ?? PAYER), pad(o.to ?? RECIP), memo],
      data: "0x" + (o.amount ?? 5000n).toString(16).padStart(64, "0"),
    }],
  };
}
const rpcOf = (r: TempoReceipt | null | Error): TempoRpc => ({
  getTransactionReceipt: vi.fn(async () => { if (r instanceof Error) throw r; return r; }),
});

describe("MPP challenge (draft-ryan-httpauth-payment)", () => {
  it("emits a WWW-Authenticate Payment challenge with a JCS base64url request and HMAC-bound id", () => {
    const c = buildMppChallenge(CFG, 5000n, NOW);
    expect(c.header).toMatch(/^Payment id="[A-Za-z0-9_-]+", realm="dn", method="tempo", intent="charge", expires="[^"]+Z", request="[A-Za-z0-9_-]+"$/);
    expect(JSON.parse(Buffer.from(c.request, "base64url").toString())).toEqual({
      amount: "5000", currency: TOKEN, methodDetails: { chainId: 42431 }, recipient: RECIP,
    });
    expect(Buffer.from(c.request, "base64url").toString()).toBe(jcs({ recipient: RECIP, amount: "5000", methodDetails: { chainId: 42431 }, currency: TOKEN }));
    const input = ["dn", "tempo", "charge", c.request, c.expires, "", ""].join("|");
    expect(c.id).toBe(crypto.createHmac("sha256", SECRET).update(input).digest("base64url"));
    expect(computeChallengeId(SECRET, c)).toBe(c.id);
  });
  it("parses Authorization / Proxy-Authorization Payment credentials, size-capped", () => {
    expect(parseMppAuthorization({ authorization: "Payment abc_-1" })).toBe("abc_-1");
    expect(parseMppAuthorization({ "proxy-authorization": "payment xyz" })).toBe("xyz");
    expect(parseMppAuthorization({ authorization: "Basic abc" })).toBeNull();
    expect(parseMppAuthorization({ authorization: "Payment " + "a".repeat(4097) })).toBeNull();
    expect(parseMppAuthorization({ authorization: "Payment a.b" })).toBeNull();
  });
});

describe("Tempo MPP verifier", () => {
  it("accepts a bound, unexpired challenge paid by a matching TransferWithMemo", async () => {
    const c = challengeFields();
    const rpc = rpcOf(receiptFor(c.id));
    const v = await createTempoMppVerifier(CFG, rpc).verify(cred({ challenge: c }), REQ, NOW);
    expect(v).toEqual({ ok: true, payer: PAYER, amountMusd: 5000n, proofRef: `tempo:42431:${TXH}` });
    expect(rpc.getTransactionReceipt).toHaveBeenCalledWith(TXH);
  });
  it("rejects a forged challenge id or a tampered request without an RPC call", async () => {
    const rpc = rpcOf(null);
    const v = createTempoMppVerifier(CFG, rpc);
    const c = challengeFields();
    expect((await v.verify(cred({ challenge: { ...c, id: "x" + c.id.slice(1) } }), REQ, NOW)).reason).toBe("invalid-challenge");
    const cheaper = challengeFields(1n);
    expect((await v.verify(cred({ challenge: { ...c, request: cheaper.request } }), REQ, NOW)).reason).toBe("invalid-challenge");
    expect((await v.verify(cred({ challenge: challengeFields(5000n) }), REQ, NOW)).ok).toBe(false); // null receipt
    expect(rpc.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it("rejects an expired challenge and a challenge priced below the current quote", async () => {
    const v = createTempoMppVerifier(CFG, rpcOf(null));
    expect((await v.verify(cred({ challenge: challengeFields(5000n, NOW - 301) }), REQ, NOW)).reason).toBe("payment-expired");
    expect((await v.verify(cred({ challenge: challengeFields(4999n) }), REQ, NOW)).reason).toBe("payment-insufficient");
  });
  it("rejects wrong recipient, token, memo, underpayment and reverted tx", async () => {
    const c = challengeFields();
    for (const r of [
      receiptFor(c.id, { to: "0x" + "d".repeat(40) }),
      receiptFor(c.id, { token: "0x" + "e".repeat(40) }),
      receiptFor(c.id, { memo: "0x" + "0".repeat(64) }),
      receiptFor(c.id, { amount: 4999n }),
      receiptFor(c.id, { status: "0x0" }),
    ]) {
      expect((await createTempoMppVerifier(CFG, rpcOf(r)).verify(cred({ challenge: c }), REQ, NOW)).ok).toBe(false);
    }
  });
  it("accepts an overpayment above the cap for the cap and reports the excess", async () => {
    const c = challengeFields();
    const v = await createTempoMppVerifier(CFG, rpcOf(receiptFor(c.id, { amount: 10_000_000_123n }))).verify(cred({ challenge: c }), REQ, NOW);
    expect(v).toEqual({ ok: true, payer: PAYER, amountMusd: 10_000_000_000n, excessMusd: 123n, proofRef: `tempo:42431:${TXH}` });
    const under = await createTempoMppVerifier(CFG, rpcOf(receiptFor(c.id, { amount: 9000n }))).verify(cred({ challenge: c }), REQ, NOW);
    expect(under).toEqual({ ok: true, payer: PAYER, amountMusd: 9000n, proofRef: `tempo:42431:${TXH}` });
  });
  it("refuses pull-mode transaction payloads and other methods", async () => {
    const v = createTempoMppVerifier(CFG, rpcOf(null));
    expect((await v.verify(cred({ payload: { type: "transaction", signature: "0x00" } }), REQ, NOW)).reason).toBe("method-unsupported");
    expect((await v.verify(cred({ challenge: { ...challengeFields(), method: "stripe" } }), REQ, NOW)).reason).toBe("method-unsupported");
  });
  it("binds the presenter when source is given", async () => {
    const c = challengeFields();
    const v = createTempoMppVerifier(CFG, rpcOf(receiptFor(c.id)));
    expect((await v.verify(cred({ challenge: c, source: `did:pkh:eip155:42431:${PAYER}` }), REQ, NOW)).ok).toBe(true);
    expect((await v.verify(cred({ challenge: c, source: `did:pkh:eip155:42431:0x${"f".repeat(40)}` }), REQ, NOW)).ok).toBe(false);
  });
  it("strips prototype-pollution keys and rejects malformed credentials", async () => {
    const v = createTempoMppVerifier(CFG, rpcOf(null));
    expect((await v.verify("!!notbase64", REQ, NOW)).ok).toBe(false);
    const evil = Buffer.from('{"__proto__":{"ok":true},"challenge":{},"payload":{}}').toString("base64url");
    expect((await v.verify(evil, REQ, NOW)).ok).toBe(false);
    expect(({} as Record<string, unknown>)["ok"]).toBeUndefined();
  });
  it("RPC client: https only, size-capped, no redirects", async () => {
    expect(() => createTempoRpc("http://rpc.example")).toThrow(/https/);
    const f = vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1)));
    await expect(createTempoRpc("https://rpc.example", f as unknown as typeof fetch).getTransactionReceipt(TXH)).rejects.toThrow(/too large/);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("manual");
  });
});

describe("MPP rail", () => {
  const store = (claimOk = true): MppStore => ({ claim: vi.fn(async () => claimOk), mark: vi.fn(async () => {}), release: vi.fn(async () => {}) });
  const okVerifier = { verify: vi.fn(async () => ({ ok: true, payer: PAYER, amountMusd: 5000n, proofRef: `tempo:42431:${TXH}` })) };

  it("claims the proof (not the credential bytes) once, then settles", async () => {
    const s = store();
    const rail = createMppRail({ verifier: okVerifier, config: CFG, store: s, now: () => NOW });
    const v = await rail.verify("cred-a", REQ);
    expect(v).toMatchObject({ ok: true, payer: PAYER, amountMusd: 5000n, paymentHash: mppPaymentHash(`tempo:42431:${TXH}`) });
    expect(s.claim).toHaveBeenCalledWith(mppPaymentHash(`tempo:42431:${TXH}`), 5000n);
    expect(await rail.settle("cred-a", REQ, v)).toEqual({ ok: true, txRef: `tempo:42431:${TXH}` });
    expect(s.mark).toHaveBeenLastCalledWith(v.paymentHash, "settled");
  });
  it("records the overpayment excess with the single claim", async () => {
    const s = store();
    const over = { verify: vi.fn(async () => ({ ok: true, payer: PAYER, amountMusd: 10_000_000_000n, excessMusd: 77n, proofRef: `tempo:42431:${TXH}` })) };
    const rail = createMppRail({ verifier: over, config: CFG, store: s, now: () => NOW });
    const v = await rail.verify("cred-x", REQ);
    expect(v).toMatchObject({ ok: true, amountMusd: 10_000_000_000n });
    expect(s.claim).toHaveBeenCalledTimes(1);
    expect(s.claim).toHaveBeenCalledWith(mppPaymentHash(`tempo:42431:${TXH}`), 10_000_000_000n, 77n);
  });
  it("rejects a replayed proof even when re-wrapped in a different credential", async () => {
    const rail = createMppRail({ verifier: okVerifier, config: CFG, store: store(false), now: () => NOW });
    expect(await rail.verify("cred-b-rewrapped", REQ)).toMatchObject({ ok: false, reason: expect.stringMatching(/already used/) });
  });
  it("does not claim when verification fails, and is disabled without config", async () => {
    const s = store();
    const bad = createMppRail({ verifier: { verify: async () => ({ ok: false, reason: "invalid-challenge" }) }, config: CFG, store: s });
    expect((await bad.verify("x", REQ)).ok).toBe(false);
    expect(s.claim).not.toHaveBeenCalled();
    const off = createMppRail({ verifier: null, config: null });
    expect(off.enabled()).toBe(false);
    expect(off.challenge(1n)).toBeNull();
  });
  it("settle refuses an unverified result", async () => {
    const rail = createMppRail({ verifier: okVerifier, config: CFG, store: store() });
    expect((await rail.settle("x", REQ, { ok: false, paymentHash: "h" })).ok).toBe(false);
  });
});

// ─── Tempo prepaid ──────────────────────────────────────────────────

function tempoSig(body: Buffer, t: number, secret = SECRET): string {
  return `t=${t},v1=${crypto.createHmac("sha256", secret).update(`${t}.`).update(body).digest("hex")}`;
}
const CHARGE = "tempo_" + "1".repeat(8) + "-1111-1111-1111-" + "1".repeat(12);
const TX = "0x" + "e".repeat(64);
const TCFG = { webhookSecret: SECRET, payTo: RECIP, token: TOKEN, chainId: 42431 };
const tempoBody = (o: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  status: "paid", chainId: 42431, txHash: TX, token: TOKEN, from: PAYER, to: RECIP, amount: "5000000", memo: chargeIdToMemo(CHARGE), ...o,
}));
const signed = (b: Buffer) => ({ "x-tempo-signature": tempoSig(b, NOW) });

describe("Tempo prepaid rail", () => {
  const rail = createTempoRail(TCFG, () => NOW);
  const invoice = { id: "inv1", user_id: "u1", amount_cents: 500, status: "pending" };

  it("memo round-trips the charge id as bytes32", () => {
    expect(chargeIdToMemo(CHARGE)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(memoToChargeId(chargeIdToMemo(CHARGE))).toBe(CHARGE);
    expect(memoToChargeId("0x" + "f".repeat(64))).toBeNull();
  });

  it("credits a correctly signed paid callback via atomicCompleteInvoiceAndCredit", async () => {
    mockFindInvoice.mockResolvedValue(invoice);
    mockCredit.mockResolvedValue({ claimed: true });
    const b = tempoBody();
    const r = await rail.handleCallback(b, signed(b));
    expect(r).toMatchObject({ status: "paid", amountCents: 500, userId: "u1" });
    expect(mockFindInvoice).toHaveBeenCalledWith("tempo", CHARGE);
    expect(mockCredit).toHaveBeenCalledWith("inv1", "u1", 500, "tempo", TX, expect.any(String), ["pending", "failed"]);
  });

  it("failed-then-paid: credits once via the single-tx claim from failed", async () => {
    mockFindInvoice.mockResolvedValue({ ...invoice, status: "failed" });
    mockCredit.mockResolvedValueOnce({ claimed: true }).mockResolvedValueOnce({ claimed: false });
    const b = tempoBody();
    expect(await rail.handleCallback(b, signed(b))).toMatchObject({ status: "paid" });
    expect(mockCredit).toHaveBeenCalledTimes(1);
    expect(mockCredit.mock.calls[0]![6]).toEqual(["pending", "failed"]);
    const once = await mockCredit.mock.results[0]!.value;
    expect(once).toEqual({ claimed: true });
    // Redelivery: the invoice is completed now; the claim is idempotent (claimed:false).
    mockFindInvoice.mockResolvedValue({ ...invoice, status: "completed" });
    await rail.handleCallback(b, signed(b));
    expect(mockFailInvoice).not.toHaveBeenCalled();
  });

  it("a failed event never downgrades a completed invoice", async () => {
    mockFindInvoice.mockResolvedValue({ ...invoice, status: "completed" });
    const b = tempoBody({ status: "failed" });
    expect(await rail.handleCallback(b, signed(b))).toBeNull();
    expect(mockFailInvoice).not.toHaveBeenCalled();
  });

  it("marks a pending invoice failed on a failed event", async () => {
    mockFindInvoice.mockResolvedValue(invoice);
    const b = tempoBody({ status: "failed" });
    expect(await rail.handleCallback(b, signed(b))).toMatchObject({ status: "failed" });
    expect(mockFailInvoice).toHaveBeenCalledWith("inv1");
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
    expect(await rail.handleCallback(tempoBody({ amount: "100000000" }), signed(b))).toBeNull();
  });

  it("enforces the body size limit", async () => {
    const big = Buffer.alloc(TEMPO_MAX_BODY_BYTES + 1, 0x20);
    expect(await rail.handleCallback(big, signed(big))).toBeNull();
  });

  it("refuses amount mismatch, sub-cent amounts, wrong recipient/token/chain", async () => {
    mockFindInvoice.mockResolvedValue(invoice);
    for (const o of [
      { amount: "5010000" }, { amount: "5000001" }, { to: "0x" + "d".repeat(40) }, { token: "0x" + "d".repeat(40) }, { chainId: 1 },
    ]) {
      const b = tempoBody(o);
      expect(await rail.handleCallback(b, signed(b))).toBeNull();
    }
    expect(mockCredit).not.toHaveBeenCalled();
  });

  it("is inert when not configured", async () => {
    const off = createTempoRail(null);
    const b = tempoBody();
    expect(await off.handleCallback(b, signed(b))).toBeNull();
    await expect(off.createCharge("u1", 500)).rejects.toThrow(/not configured/);
  });

  it("createCharge returns the bytes32 memo and base-unit amount", async () => {
    mockCreateInvoice.mockResolvedValue({});
    const r = await rail.createCharge("u1", 500);
    const i = r.instructions as Record<string, unknown>;
    expect(i).toMatchObject({ chainId: 42431, token: TOKEN, payTo: RECIP, amount: "5000000" });
    expect(memoToChargeId(i["memo"] as string)).toBe(r.chargeId);
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
