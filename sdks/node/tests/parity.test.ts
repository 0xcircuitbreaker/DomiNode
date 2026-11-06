import { describe, it, expect } from "vitest";
import { buildAttestationMessage } from "../src/messages.js";
import { buildAttestationMessage as serverBuild } from "../../../packages/shared/src/attestation.js";

describe("attestation message parity with the server", () => {
  it("is byte-identical", () => {
    for (const nodePubkey of [null, "ab".repeat(32)]) {
      const p = { wallet: "0xAbCd" + "0".repeat(36), nonce: "f".repeat(64), attestationVersion: 3, attestationText: "line1\nline2 µ", nodePubkey };
      expect(buildAttestationMessage(p)).toBe(serverBuild(p));
    }
  });
});
