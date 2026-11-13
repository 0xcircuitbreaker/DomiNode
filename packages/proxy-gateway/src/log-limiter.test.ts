import { describe, it, expect } from "vitest";
import { PerKeyLogLimiter } from "./log-limiter.js";

describe("PerKeyLogLimiter", () => {
  it("allows one line per key per interval", () => {
    const l = new PerKeyLogLimiter(60_000, 10);
    expect(l.allow("n1", 0)).toBe(true);
    expect(l.allow("n1", 59_999)).toBe(false);
    expect(l.allow("n2", 1)).toBe(true);
    expect(l.allow("n1", 60_000)).toBe(true);
  });

  it("caps the key map", () => {
    const l = new PerKeyLogLimiter(60_000, 3);
    for (let i = 0; i < 100; i++) l.allow(`n${i}`, i);
    expect(l.size).toBe(3);
  });
});
