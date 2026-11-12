import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as crypto from "node:crypto";
import { coinbaseFacilitator, buildCdpJwt, decodeExactPayload } from "./coinbase.js";
import { FACILITATOR_URLS } from "./urls.js";

const PAY_TO = "0x1234567890abcdef1234567890abcdef12345678";
const PAYER = "0x857b06519E91e3A54538791bDbb0E22373e36b66";
const TX = "0x" + "ab".repeat(32);

const accept = {
  scheme: "exact", network: "base", maxAmountRequired: "1000",
  resource: "https://proxy.example", payTo: PAY_TO, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  description: "relay", mimeType: "application/octet-stream", maxTimeoutSeconds: 60,
  extra: { facilitator: "coinbase" as const, name: "USD Coin", version: "2" },
};
const requirements = { version: "1", accepts: [accept] };

/** PaymentPayload shaped like the x402 v1 exact/EVM spec (EIP-3009 authorization). */
function paymentPayload(o: { value?: string; to?: string; network?: string } = {}) {
  return {
    x402Version: 1, scheme: "exact", network: o.network ?? "base",
    payload: {
      signature: "0x" + "1b".repeat(65),
      authorization: {
        from: PAYER, to: o.to ?? PAY_TO, value: o.value ?? "1500",
        validAfter: "0", validBefore: "9999999999", nonce: "0x" + "cd".repeat(32),
      },
    },
  };
}
const header = (o?: Parameters<typeof paymentPayload>[0]) => Buffer.from(JSON.stringify(paymentPayload(o))).toString("base64");

// Documented CDP response shapes
const VERIFY_OK = { isValid: true, payer: PAYER };
const VERIFY_BAD = { isValid: false, invalidReason: "insufficient_funds", invalidMessage: "x", payer: PAYER };
const SETTLE_OK = { success: true, transaction: TX, network: "base", payer: PAYER };
const SETTLE_BAD = { success: false, errorReason: "invalid_exact_evm_payload_signature", transaction: "", network: "base", payer: PAYER };

const ed = crypto.generateKeyPairSync("ed25519");
const edSecret = Buffer.concat([
  ed.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32),
  ed.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
]).toString("base64");

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env["CDP_API_KEY_ID"] = "organizations/o/apiKeys/k1";
  process.env["CDP_API_KEY_SECRET"] = edSecret;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  delete process.env["CDP_API_KEY_ID"];
  delete process.env["CDP_API_KEY_SECRET"];
  vi.unstubAllGlobals();
});

function decodeJwt(jwt: string) {
  const [h, c] = jwt.split(".");
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(c, "base64url").toString()) };
}

describe("CDP JWT", () => {
  it("signs EdDSA with the documented header and claims", () => {
    const jwt = buildCdpJwt("kid-1", edSecret, "POST", FACILITATOR_URLS.coinbase.verify, 1_700_000_000);
    const { header: h, claims } = decodeJwt(jwt);
    expect(h).toMatchObject({ alg: "EdDSA", kid: "kid-1", typ: "JWT" });
    expect(h.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(claims).toEqual({
      sub: "kid-1", iss: "cdp", aud: ["cdp_service"], nbf: 1_700_000_000, exp: 1_700_000_120,
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/verify",
    });
    const [a, b, s] = jwt.split(".");
    expect(crypto.verify(null, Buffer.from(`${a}.${b}`), ed.publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("signs ES256 for a PEM EC key", () => {
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem = ec.privateKey.export({ format: "pem", type: "sec1" }).toString();
    const jwt = buildCdpJwt("kid-2", pem, "POST", FACILITATOR_URLS.coinbase.settle);
    expect(decodeJwt(jwt).header.alg).toBe("ES256");
    const [a, b, s] = jwt.split(".");
    expect(crypto.verify("sha256", Buffer.from(`${a}.${b}`), { key: ec.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("rejects a malformed secret", () => {
    expect(() => buildCdpJwt("k", "dG9vc2hvcnQ=", "POST", FACILITATOR_URLS.coinbase.verify)).toThrow(/64 bytes/);
  });
});

describe("coinbase facilitator wire format", () => {
  it("verify posts {x402Version, paymentPayload, paymentRequirements} with a Bearer JWT and takes the amount from the signed authorization", async () => {
    fetchMock.mockResolvedValueOnce(res(VERIFY_OK));
    const r = await coinbaseFacilitator.verify(header(), requirements);
    expect(r).toEqual({ valid: true, payer: PAYER, amountUsd: "0.001500", facilitator: "coinbase" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cdp.coinbase.com/platform/v2/x402/verify");
    expect((init.headers as Record<string, string>)["Authorization"]).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["paymentPayload", "paymentRequirements", "x402Version"]);
    expect(body.x402Version).toBe(1);
    expect(body.paymentPayload).toEqual(paymentPayload());
    expect(body.paymentRequirements).toMatchObject({ scheme: "exact", network: "base", maxAmountRequired: "1000", payTo: PAY_TO, maxTimeoutSeconds: 60 });
    expect(body.paymentRequirements.extra).toEqual({ name: "USD Coin", version: "2" });
  });

  it("verify fails closed on isValid:false, payer mismatch, bad payloads and HTTP errors", async () => {
    fetchMock.mockResolvedValueOnce(res(VERIFY_BAD));
    expect((await coinbaseFacilitator.verify(header(), requirements)).valid).toBe(false);
    fetchMock.mockResolvedValueOnce(res({ isValid: true, payer: "0x" + "9".repeat(40) }));
    expect((await coinbaseFacilitator.verify(header(), requirements)).error).toBe("Payer mismatch");
    fetchMock.mockResolvedValueOnce(res({ error: "x" }, 401));
    expect((await coinbaseFacilitator.verify(header(), requirements)).valid).toBe(false);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve("x".repeat(10_001)) });
    expect((await coinbaseFacilitator.verify(header(), requirements)).valid).toBe(false);

    // Rejected locally, before any facilitator call
    fetchMock.mockClear();
    expect((await coinbaseFacilitator.verify(header({ value: "999" }), requirements)).error).toBe("Payment amount insufficient");
    expect((await coinbaseFacilitator.verify(header({ to: "0x" + "1".repeat(40) }), requirements)).error).toBe("Payment recipient mismatch");
    expect((await coinbaseFacilitator.verify(header({ network: "base-sepolia" }), requirements)).error).toBe("Network mismatch");
    expect((await coinbaseFacilitator.verify("not-a-payload", requirements)).valid).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verify without CDP credentials is unavailable", async () => {
    delete process.env["CDP_API_KEY_SECRET"];
    expect((await coinbaseFacilitator.verify(header(), requirements)).error).toBe("Facilitator unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settle reads {success, transaction, network, payer} and reports the signed amount", async () => {
    fetchMock.mockResolvedValueOnce(res(SETTLE_OK));
    const s = await coinbaseFacilitator.settle(header(), accept);
    expect(s).toEqual({ txHash: TX, amountSettled: "1500", facilitator: "coinbase" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.cdp.coinbase.com/platform/v2/x402/settle");
    expect(decodeJwt((init.headers as Record<string, string>)["Authorization"].slice(7)).claims.uri)
      .toBe("POST api.cdp.coinbase.com/platform/v2/x402/settle");
  });

  it("settle throws on failure, missing transaction, wrong network or missing requirements", async () => {
    fetchMock.mockResolvedValueOnce(res(SETTLE_BAD));
    await expect(coinbaseFacilitator.settle(header(), accept)).rejects.toThrow(/not successful/);
    fetchMock.mockResolvedValueOnce(res({ success: true, network: "base", payer: PAYER }));
    await expect(coinbaseFacilitator.settle(header(), accept)).rejects.toThrow(/transaction/);
    fetchMock.mockResolvedValueOnce(res({ ...SETTLE_OK, network: "base-sepolia" }));
    await expect(coinbaseFacilitator.settle(header(), accept)).rejects.toThrow(/network/);
    await expect(coinbaseFacilitator.settle(header())).rejects.toThrow(/requirements/);
    await expect(coinbaseFacilitator.settle(header({ value: "1" }), accept)).rejects.toThrow(/insufficient/);
  });

  it("decodes base64 and raw JSON payloads and strips prototype keys", () => {
    expect(decodeExactPayload(header())?.payload.authorization.value).toBe("1500");
    expect(decodeExactPayload(JSON.stringify(paymentPayload()))?.network).toBe("base");
    const evil = JSON.stringify({ ...paymentPayload(), __proto__: { polluted: true } });
    expect(decodeExactPayload(evil)).not.toBeNull();
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});
