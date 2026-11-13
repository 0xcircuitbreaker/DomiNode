import { describe, it, expect } from "vitest";
import { ByteRate } from "./limits.js";

describe("ByteRate (DN_NODE_MAX_MBPS)", () => {
  it("refills at maxMbps * 125000 B/s with a one-second burst", () => {
    let t = 0;
    const r = new ByteRate(8, () => t); // 1 MB/s
    expect(r.available()).toBe(1_000_000);
    r.consume(1_500_000);
    expect(r.available()).toBe(0);
    expect(r.waitMs()).toBe(500);
    t = 500;
    expect(r.waitMs()).toBe(0);
    expect(r.waitMs(100_000)).toBe(100);
    t = 10_000;
    expect(r.available()).toBe(1_000_000);
  });
  it("rejects a non-positive cap", () => {
    expect(() => new ByteRate(0)).toThrow(RangeError);
  });
});
