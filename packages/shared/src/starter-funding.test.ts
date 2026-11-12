import { describe, it, expect, vi, beforeEach } from "vitest";
import { getBaseTxCount, rpcUrlFromEnv, rpcTimeoutFromEnv, clearNonceCache } from "./starter-funding.js";

const ADDR = "0x1111111111111111111111111111111111111111";
const URL_OK = new URL("https://base.example/rpc");

function reply(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, text: async () => JSON.stringify(body) }) as unknown as Response);
}

beforeEach(() => clearNonceCache());

describe("starter-credit RPC config", () => {
  it("accepts only https URLs", () => {
    expect(rpcUrlFromEnv({ STARTER_CREDIT_RPC_URL: "https://mainnet.base.org" })?.host).toBe("mainnet.base.org");
    expect(rpcUrlFromEnv({ STARTER_CREDIT_RPC_URL: "http://mainnet.base.org" })).toBeNull();
    expect(rpcUrlFromEnv({ STARTER_CREDIT_RPC_URL: "not a url" })).toBeNull();
    expect(rpcUrlFromEnv({})).toBeNull();
  });
  it("bounds the timeout and guards NaN", () => {
    expect(rpcTimeoutFromEnv({})).toBe(3000);
    expect(rpcTimeoutFromEnv({ STARTER_CREDIT_RPC_TIMEOUT_MS: "abc" })).toBe(3000);
    expect(rpcTimeoutFromEnv({ STARTER_CREDIT_RPC_TIMEOUT_MS: "99999" })).toBe(3000);
    expect(rpcTimeoutFromEnv({ STARTER_CREDIT_RPC_TIMEOUT_MS: "1500" })).toBe(1500);
  });
});

describe("getBaseTxCount", () => {
  it("reads eth_getTransactionCount and caches the answer", async () => {
    const f = reply({ jsonrpc: "2.0", id: 1, result: "0x2" });
    expect(await getBaseTxCount(ADDR, { url: URL_OK, fetchImpl: f as never })).toBe(2);
    expect(await getBaseTxCount(ADDR.toUpperCase().replace("0X", "0x"), { url: URL_OK, fetchImpl: f as never })).toBe(2);
    expect(f).toHaveBeenCalledTimes(1);
    const init = (f.mock.calls[0] as unknown as [URL, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toMatchObject({ method: "eth_getTransactionCount", params: [ADDR, "latest"] });
    expect(init.redirect).toBe("error");
  });
  it("re-checks a zero nonce after the short negative TTL", async () => {
    const f = reply({ result: "0x0" });
    expect(await getBaseTxCount(ADDR, { url: URL_OK, fetchImpl: f as never, now: 0 })).toBe(0);
    await getBaseTxCount(ADDR, { url: URL_OK, fetchImpl: f as never, now: 60_000 });
    expect(f).toHaveBeenCalledTimes(1);
    await getBaseTxCount(ADDR, { url: URL_OK, fetchImpl: f as never, now: 10 * 60_000 });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("returns null (fail closed) without an https RPC, on errors and bad replies", async () => {
    const f = reply({ result: "0x1" });
    expect(await getBaseTxCount(ADDR, { url: null, fetchImpl: f as never })).toBeNull();
    expect(await getBaseTxCount(ADDR, { url: new URL("http://x.example"), fetchImpl: f as never })).toBeNull();
    expect(await getBaseTxCount("0xnope", { url: URL_OK, fetchImpl: f as never })).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(await getBaseTxCount(ADDR, { url: URL_OK, fetchImpl: reply({}, false) as never })).toBeNull();
    expect(await getBaseTxCount(ADDR, { url: URL_OK, fetchImpl: reply({ error: { code: -32000 } }) as never })).toBeNull();
    expect(await getBaseTxCount(ADDR, { url: URL_OK, fetchImpl: vi.fn(async () => { throw new Error("timeout"); }) as never })).toBeNull();
  });
});
