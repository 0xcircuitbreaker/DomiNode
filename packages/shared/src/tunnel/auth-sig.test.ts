import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  challengeMessage, authMessage, signEd25519, verifyEd25519, ed25519PublicKeyHex, ed25519PublicKeyFromHex,
  loadEd25519PrivateKey,
} from "./auth-sig.js";

const nonce = "ab".repeat(32);
const nodeId = "11111111-2222-3333-4444-555555555555";

describe("tunnel auth signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = ed25519PublicKeyHex(publicKey);

  it("signs and verifies AUTH with and without exporter", () => {
    const exp = Buffer.alloc(32, 7);
    const sig = signEd25519(privateKey, authMessage(nonce, nodeId, exp));
    expect(verifyEd25519(pub, authMessage(nonce, nodeId, exp), sig)).toBe(true);
    expect(verifyEd25519(pub, authMessage(nonce, nodeId, null), sig)).toBe(false);
    expect(verifyEd25519(pub, authMessage("cd".repeat(32), nodeId, exp), sig)).toBe(false);
  });

  it("challenge message binds binding mode and fields", () => {
    const sig = signEd25519(privateKey, challengeMessage(nonce, 3, 1000, "none"));
    expect(verifyEd25519(pub, challengeMessage(nonce, 3, 1000, "none"), sig)).toBe(true);
    expect(verifyEd25519(pub, challengeMessage(nonce, 3, 1000, "tls-exporter"), sig)).toBe(false);
    expect(verifyEd25519(pub, challengeMessage(nonce, 31, 0, "none"), sig)).toBe(false);
  });

  it("rejects malformed inputs", () => {
    expect(verifyEd25519("zz", Buffer.alloc(1), "00".repeat(64))).toBe(false);
    expect(verifyEd25519(pub, Buffer.alloc(1), "short")).toBe(false);
    expect(verifyEd25519(pub, Buffer.alloc(1), 5)).toBe(false);
    expect(ed25519PublicKeyFromHex("x")).toBeNull();
    expect(() => authMessage(nonce, "not-a-uuid", null)).toThrow();
    expect(() => authMessage(nonce, nodeId, Buffer.alloc(3))).toThrow();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(() => loadEd25519PrivateKey(rsa)).toThrow(/ed25519/);
  });
});
