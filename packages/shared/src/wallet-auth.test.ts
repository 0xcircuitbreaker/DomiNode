import { describe, it, expect } from "vitest";
import {
  isValidEvmAddress,
  generateWalletNonce,
  buildSignMessage,
  walletToSyntheticEmail,
  isWalletEmail,
  WALLET_CHALLENGE_TTL_MS,
} from "./wallet-auth.js";

describe("wallet-auth", () => {
  describe("isValidEvmAddress", () => {
    it("should accept valid checksummed address", () => {
      expect(isValidEvmAddress("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe(true);
    });

    it("should accept valid lowercase address", () => {
      expect(isValidEvmAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(true);
    });

    it("should accept valid uppercase address", () => {
      expect(isValidEvmAddress("0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045")).toBe(true);
    });

    it("should reject address without 0x prefix", () => {
      expect(isValidEvmAddress("d8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(false);
    });

    it("should reject too-short address", () => {
      expect(isValidEvmAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa9604")).toBe(false);
    });

    it("should reject too-long address", () => {
      expect(isValidEvmAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa960450")).toBe(false);
    });

    it("should reject address with non-hex characters", () => {
      expect(isValidEvmAddress("0xg8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(false);
    });

    it("should reject empty string", () => {
      expect(isValidEvmAddress("")).toBe(false);
    });
  });

  describe("generateWalletNonce", () => {
    it("should return a 64-character hex string", () => {
      const nonce = generateWalletNonce();
      expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should generate unique nonces", () => {
      const a = generateWalletNonce();
      const b = generateWalletNonce();
      expect(a).not.toBe(b);
    });
  });

  describe("buildSignMessage", () => {
    it("should include domain, address, nonce, and timestamp", () => {
      const message = buildSignMessage(
        "dominusnode.daedalusdevelopmentgroup.com",
        "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        "abc123",
        new Date("2025-01-01T00:00:00Z"),
      );

      expect(message).toContain("dominusnode.daedalusdevelopmentgroup.com wants you to sign in with your Ethereum account:");
      expect(message).toContain("0xd8da6bf26964af9d7eed9e03e53415d37aa96045");
      expect(message).toContain("Nonce: abc123");
      expect(message).toContain("Issued At: 2025-01-01T00:00:00.000Z");
      expect(message).toContain("URI: https://dominusnode.daedalusdevelopmentgroup.com");
      expect(message).toContain("Sign in to Dominus Node proxy service");
    });
  });

  describe("walletToSyntheticEmail", () => {
    it("should convert address to synthetic email", () => {
      const email = walletToSyntheticEmail("0xD8DA6BF26964AF9D7EED9E03E53415D37AA96045");
      expect(email).toBe("0xd8da6bf26964af9d7eed9e03e53415d37aa96045@wallet.dominusnode.daedalusdevelopmentgroup.com");
    });

    it("should lowercase the address", () => {
      const email = walletToSyntheticEmail("0xABCDEF1234567890ABCDEF1234567890ABCDEF12");
      expect(email).toContain("0xabcdef");
    });
  });

  describe("isWalletEmail", () => {
    it("should detect synthetic wallet emails", () => {
      expect(isWalletEmail("0xabc@wallet.dominusnode.daedalusdevelopmentgroup.com")).toBe(true);
    });

    it("should not detect regular emails", () => {
      expect(isWalletEmail("user@example.com")).toBe(false);
    });

    it("should not detect partial matches", () => {
      expect(isWalletEmail("user@fakewallet.dominusnode.com")).toBe(false);
    });
  });

  describe("WALLET_CHALLENGE_TTL_MS", () => {
    it("should be 5 minutes", () => {
      expect(WALLET_CHALLENGE_TTL_MS).toBe(5 * 60 * 1000);
    });
  });
});

describe("wallet email domain migration", () => {
  it("recognises both the current and the legacy synthetic wallet domains", async () => {
    const { isWalletEmail, walletToSyntheticEmail } = await import("./wallet-auth.js");
    expect(walletToSyntheticEmail("0xABC")).toBe("0xabc@wallet.dominusnode.daedalusdevelopmentgroup.com");
    expect(isWalletEmail("0xabc@wallet.dominusnode.daedalusdevelopmentgroup.com")).toBe(true);
    expect(isWalletEmail("0xabc@wallet.dominusnode.com")).toBe(true);
    expect(isWalletEmail("someone@example.com")).toBe(false);
  });
});
