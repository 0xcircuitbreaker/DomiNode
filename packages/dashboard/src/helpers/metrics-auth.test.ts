import { describe, it, expect } from "vitest";
import { metricsAccessAllowed } from "./metrics-auth.js";

const SECRET = "a".repeat(32);

describe("metricsAccessAllowed", () => {
  it("allows loopback callers without a token", () => {
    expect(metricsAccessAllowed("127.0.0.1", undefined, undefined)).toBe(true);
    expect(metricsAccessAllowed("::ffff:127.0.0.1", undefined, undefined)).toBe(true);
    expect(metricsAccessAllowed("::1", undefined, undefined)).toBe(true);
  });

  it("refuses non-loopback callers when no secret is set", () => {
    expect(metricsAccessAllowed("172.18.0.5", `Bearer ${SECRET}`, undefined)).toBe(false);
    expect(metricsAccessAllowed("172.18.0.5", "Bearer ", "")).toBe(false);
  });

  it("refuses a secret shorter than 32 characters", () => {
    expect(metricsAccessAllowed("172.18.0.5", "Bearer short", "short")).toBe(false);
  });

  it("allows non-loopback callers with the exact bearer token", () => {
    expect(metricsAccessAllowed("172.18.0.5", `Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("refuses a wrong, missing or repeated token", () => {
    expect(metricsAccessAllowed("172.18.0.5", `Bearer ${"b".repeat(32)}`, SECRET)).toBe(false);
    expect(metricsAccessAllowed("172.18.0.5", SECRET, SECRET)).toBe(false);
    expect(metricsAccessAllowed("172.18.0.5", undefined, SECRET)).toBe(false);
    expect(metricsAccessAllowed("172.18.0.5", [`Bearer ${SECRET}`], SECRET)).toBe(false);
    expect(metricsAccessAllowed(undefined, `Bearer ${SECRET}x`, SECRET)).toBe(false);
  });
});
