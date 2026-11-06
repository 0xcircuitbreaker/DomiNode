import { describe, it, expect } from "vitest";
import { buildAttestationMessage as local } from "../src/attestation.js";
import { buildAttestationMessage as shared } from "../../shared/src/attestation.js";

describe("attestation parity with @dominusnode/shared", () => {
  const cases = [
    { wallet: "0xABCdef0000000000000000000000000000000001", nonce: "aa".repeat(32), attestationVersion: 1, attestationText: "I operate lawfully.", nodePubkey: "bb".repeat(32) },
    { wallet: "0x0000000000000000000000000000000000000002", nonce: "cd".repeat(32), attestationVersion: 7, attestationText: "line one\nline two", nodePubkey: null },
  ];
  for (const c of cases) {
    it(`matches for version ${c.attestationVersion}`, () => {
      expect(local(c)).toBe(shared(c));
    });
  }
});
