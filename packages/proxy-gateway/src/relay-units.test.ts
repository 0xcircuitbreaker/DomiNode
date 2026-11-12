import { describe, it, expect } from "vitest";
import { relayChargeRepo, RELAY_BYTES_PER_GB, BYTES_PER_GIB } from "@dominusnode/shared";
import { x402AmountMusd } from "./x402-handler.js";
import { reservationCentsFor, maxBytesForReservation, maxBytesForPrepaid } from "./session-manager.js";

/**
 * Unit consistency: network_pricing is µUSD per decimal GB. Quote, byte cap,
 * reservation and settlement must all use RELAY_BYTES_PER_GB (1e9).
 */

// Deterministic PRNG so failures reproduce.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe("relay money <-> bytes units", () => {
  it("uses decimal GB for relay pricing and keeps GiB separate", () => {
    expect(RELAY_BYTES_PER_GB).toBe(1_000_000_000);
    expect(BYTES_PER_GIB).toBe(1_073_741_824);
  });

  it("x402 quote -> paid byte cap -> computeSplit returns the paid amount within 1 µUSD", () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const price = BigInt(1_000 + Math.floor(r() * 4_999_000)); // [$0.001, $5]/GB
      const bytes = 65_536 + Math.floor(r() * (1_073_741_824 - 65_536));
      const paid = x402AmountMusd(price, bytes);
      const cap = maxBytesForPrepaid(paid, price); // same math as paidByteCap
      expect(cap).toBeGreaterThanOrEqual(bytes);
      const s = relayChargeRepo.computeSplit(BigInt(cap), price, 2500, "x402");
      expect(s.grossMusd <= paid).toBe(true);
      expect(paid - s.grossMusd <= 1n).toBe(true);
    }
  });

  it("reservation -> maxBytes -> settle never charges more than reserved", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const price = BigInt(1_000 + Math.floor(r() * 4_999_000));
      const cap = 1_048_576 + Math.floor(r() * 10_000_000_000);
      const cents = reservationCentsFor(price, cap);
      const maxBytes = maxBytesForReservation(cents, price);
      expect(maxBytes).toBeGreaterThanOrEqual(cap); // reservation covers the cap
      const s = relayChargeRepo.computeSplit(BigInt(maxBytes), price, 2500, "wallet");
      expect(s.debitCents <= BigInt(cents)).toBe(true);
    }
  });

  it("$0.50/GB buys exactly 1e9 bytes per 50 cents", () => {
    expect(reservationCentsFor(500_000n, 1_000_000_000)).toBe(50);
    expect(maxBytesForReservation(50, 500_000n)).toBe(1_000_000_000);
  });
});
