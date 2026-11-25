import { describe, it, expect } from "vitest";
import { proxyTokenSpendMusd } from "./session-manager.js";

describe("proxyTokenSpendMusd", () => {
  it("charges ceil(bytes × price per GB)", () => {
    // $0.50/GB = 500_000 µUSD per 1e9 bytes
    expect(proxyTokenSpendMusd({ pricePerGbMusd: 500_000n }, 1_000_000_000)).toBe(500_000n);
    expect(proxyTokenSpendMusd({ pricePerGbMusd: 500_000n }, 1)).toBe(1n);
    expect(proxyTokenSpendMusd({ pricePerGbMusd: 500_000n }, 0)).toBe(0n);
    expect(proxyTokenSpendMusd({ pricePerGbMusd: 0n }, 1000)).toBe(0n);
  });
  it("uses the prepaid amount for x402/MPP sessions", () => {
    expect(proxyTokenSpendMusd({ pricePerGbMusd: 500_000n, prepaid: { paidMusd: 1234n } }, 10)).toBe(1234n);
  });
});
