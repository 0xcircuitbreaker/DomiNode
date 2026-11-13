import { describe, it, expect, afterEach } from "vitest";
import * as crypto from "node:crypto";
import { apiKeyPepper, apiKeyLookup, hashApiKeyV1, hashApiKeyV2, hashApiKeyForStorage, hashEquals, _setApiKeyPepperForTest } from "./api-key-hash.js";
import { generateApiKey, hashApiKey } from "./auth.js";

afterEach(() => _setApiKeyPepperForTest(undefined));

describe("api-key-hash", () => {
  it("v1 is SHA-256 hex and matches hashApiKey", () => {
    expect(hashApiKeyV1("dn_live_x")).toBe(crypto.createHash("sha256").update("dn_live_x").digest("hex"));
    expect(hashApiKey("dn_live_x")).toBe(hashApiKeyV1("dn_live_x"));
  });

  it("v2 is HMAC-SHA256 with the pepper", () => {
    const p = Buffer.alloc(32, 1);
    expect(hashApiKeyV2("dn_live_x", p)).toBe(crypto.createHmac("sha256", p).update("dn_live_x").digest("hex"));
    expect(hashApiKeyV2("dn_live_x", p)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("without a pepper: v1 only", () => {
    _setApiKeyPepperForTest(null);
    expect(apiKeyLookup("dn_live_x")).toEqual({ candidates: [hashApiKeyV1("dn_live_x")], current: hashApiKeyV1("dn_live_x") });
    const k = generateApiKey();
    expect(k.hash).toBe(hashApiKeyV1(k.raw));
  });

  it("with a pepper: new keys are stored as v2, lookup tries v2 then v1", () => {
    const p = Buffer.alloc(32, 2);
    _setApiKeyPepperForTest(p);
    const k = generateApiKey();
    expect(k.hash).toBe(hashApiKeyV2(k.raw, p));
    expect(hashApiKeyForStorage(k.raw)).toBe(k.hash);
    expect(apiKeyLookup(k.raw).candidates).toEqual([hashApiKeyV2(k.raw, p), hashApiKeyV1(k.raw)]);
  });

  it("loads the pepper file (hex or raw), fails closed when too short", () => {
    _setApiKeyPepperForTest(undefined);
    expect(apiKeyPepper({}, () => Buffer.alloc(0))).toBeNull();
    _setApiKeyPepperForTest(undefined);
    const hex = crypto.randomBytes(32).toString("hex");
    expect(apiKeyPepper({ API_KEY_PEPPER_FILE: "/p" }, () => Buffer.from(hex + "\n"))!.toString("hex")).toBe(hex);
    _setApiKeyPepperForTest(undefined);
    expect(() => apiKeyPepper({ API_KEY_PEPPER_FILE: "/p" }, () => Buffer.from("short"))).toThrow(/at least 32 bytes/);
  });

  it("names the ownership requirement when the pepper file is unreadable", () => {
    _setApiKeyPepperForTest(undefined);
    const eacces = () => { throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }); };
    expect(() => apiKeyPepper({ API_KEY_PEPPER_FILE: "/p" }, eacces)).toThrow(/not readable by uid .*chown 1001:1001/);
    _setApiKeyPepperForTest(undefined);
  });

  it("hashEquals is length-safe", () => {
    expect(hashEquals("ab", "ab")).toBe(true);
    expect(hashEquals("ab", "ac")).toBe(false);
    expect(hashEquals("ab", "abc")).toBe(false);
  });
});
