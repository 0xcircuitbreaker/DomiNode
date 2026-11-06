import { describe, it, expect } from "vitest";
import {
  computeRelayCharge,
  RelayChargeError,
  MAX_RELAY_BYTES,
  RELAY_RAILS,
  type RelayRail,
} from "./relay.js";

// Deterministic PRNG (mulberry32)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randBig = (r: () => number, max: bigint) =>
  (BigInt(Math.floor(r() * 2 ** 32)) * BigInt(Math.floor(r() * 2 ** 32))) % (max + 1n);

const paidRails: RelayRail[] = RELAY_RAILS.filter((x) => x !== "free");

describe("computeRelayCharge", () => {
  it("matches worked example", () => {
    const c = computeRelayCharge({ bytes: 1_000_000_000n, priceMusdPerGb: 500_000n, nodeShareBps: 5000, selfDealing: false, rail: "wallet" });
    expect(c).toEqual({ grossMusd: 500_000n, nodeMusd: 250_000n, platformMusd: 250_000n, requesterDebitCents: 50n, zeroReason: null });
  });

  it("rounds gross up and node down; residue to platform", () => {
    const c = computeRelayCharge({ bytes: 1n, priceMusdPerGb: 1000n, nodeShareBps: 5000, selfDealing: false, rail: "wallet" });
    expect(c.grossMusd).toBe(1n);
    expect(c.nodeMusd).toBe(0n);
    expect(c.platformMusd).toBe(1n);
    expect(c.requesterDebitCents).toBe(1n);
  });

  it("zero bytes yields zero", () => {
    const c = computeRelayCharge({ bytes: 0n, priceMusdPerGb: 200_000n, nodeShareBps: 3000, selfDealing: false, rail: "x402" });
    expect(c.grossMusd).toBe(0n);
    expect(c.requesterDebitCents).toBe(0n);
  });

  it("selfDealing and free rail zero the node share", () => {
    const base = { bytes: 5_000_000_000n, priceMusdPerGb: 500_000n, nodeShareBps: 5000 };
    const s = computeRelayCharge({ ...base, selfDealing: true, rail: "wallet" });
    expect(s.nodeMusd).toBe(0n);
    expect(s.zeroReason).toBe("self_dealing");
    expect(s.platformMusd).toBe(s.grossMusd);
    const f = computeRelayCharge({ ...base, selfDealing: false, rail: "free" });
    expect(f.nodeMusd).toBe(0n);
    expect(f.zeroReason).toBe("free_rail");
  });

  it("property: invariants hold over seeded random inputs", () => {
    for (const seed of [1, 42, 1337, 20261104]) {
      const r = rng(seed);
      for (let i = 0; i < 2000; i++) {
        const bytes = randBig(r, MAX_RELAY_BYTES);
        const price = 1000n + randBig(r, 4_999_000n);
        const bps = Math.floor(r() * 5001);
        const rail = paidRails[Math.floor(r() * paidRails.length)]!;
        const c = computeRelayCharge({ bytes, priceMusdPerGb: price, nodeShareBps: bps, selfDealing: false, rail });
        expect(c.nodeMusd + c.platformMusd).toBe(c.grossMusd);
        // gross is ceil
        expect(c.grossMusd * 1_000_000_000n >= bytes * price).toBe(true);
        expect((c.grossMusd - (c.grossMusd > 0n ? 1n : 0n)) * 1_000_000_000n < bytes * price || c.grossMusd === 0n).toBe(true);
        // node is floor: residue (< 1 µUSD of exact share) goes to platform
        expect(c.nodeMusd * 10_000n <= c.grossMusd * BigInt(bps)).toBe(true);
        expect((c.nodeMusd + 1n) * 10_000n > c.grossMusd * BigInt(bps)).toBe(true);
        expect(c.platformMusd * 10_000n >= c.grossMusd * BigInt(10_000 - bps)).toBe(true);
        // debit covers gross by < 1 cent
        expect(c.requesterDebitCents * 10_000n >= c.grossMusd).toBe(true);
        expect(c.requesterDebitCents * 10_000n - c.grossMusd < 10_000n).toBe(true);
        expect(c.nodeMusd >= 0n && c.platformMusd >= 0n).toBe(true);
      }
    }
  });

  it("property: monotonic in bytes, price and bps", () => {
    const r = rng(7);
    for (let i = 0; i < 2000; i++) {
      const bytes = randBig(r, MAX_RELAY_BYTES - 1000n);
      const price = 1000n + randBig(r, 4_998_000n);
      const bps = Math.floor(r() * 5000);
      const base = { bytes, priceMusdPerGb: price, nodeShareBps: bps, selfDealing: false, rail: "wallet" as const };
      const c = computeRelayCharge(base);
      const moreBytes = computeRelayCharge({ ...base, bytes: bytes + 1n + randBig(r, 999n) });
      const morePrice = computeRelayCharge({ ...base, priceMusdPerGb: price + 1n });
      const moreBps = computeRelayCharge({ ...base, nodeShareBps: bps + 1 });
      expect(moreBytes.grossMusd >= c.grossMusd).toBe(true);
      expect(moreBytes.nodeMusd >= c.nodeMusd).toBe(true);
      expect(moreBytes.requesterDebitCents >= c.requesterDebitCents).toBe(true);
      expect(morePrice.grossMusd >= c.grossMusd).toBe(true);
      expect(moreBps.nodeMusd >= c.nodeMusd).toBe(true);
      expect(moreBps.grossMusd).toBe(c.grossMusd);
    }
  });

  it("rejects out-of-bounds inputs", () => {
    const ok = { bytes: 1n, priceMusdPerGb: 1000n, nodeShareBps: 0, selfDealing: false, rail: "wallet" as RelayRail };
    const bad = [
      { bytes: -1n },
      { bytes: MAX_RELAY_BYTES + 1n },
      { priceMusdPerGb: 999n },
      { priceMusdPerGb: 5_000_001n },
      { nodeShareBps: -1 },
      { nodeShareBps: 5001 },
      { nodeShareBps: 1.5 },
      { nodeShareBps: Number.NaN },
      { rail: "bogus" as RelayRail },
      { bytes: 5 as unknown as bigint },
    ];
    for (const b of bad) expect(() => computeRelayCharge({ ...ok, ...b })).toThrow(RelayChargeError);
    expect(() => computeRelayCharge({ ...ok, bytes: MAX_RELAY_BYTES, priceMusdPerGb: 5_000_000n, nodeShareBps: 5000 })).not.toThrow();
  });
});
