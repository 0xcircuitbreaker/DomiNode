import { describe, expect, it } from "vitest";
import { buildUsername, newSessionId } from "./flags.js";

// Mirror of proxy-gateway parseProxyOptions regexes, so the flags we emit parse as intended.
function gatewayParse(u: string) {
  return {
    legacyPrefix: /^(dc|residential|auto)(?:-|$)/.test(u),
    ipClass: u.match(/(?:^|-)class-(residential|dc|mobile)(?:-|$)/)?.[1],
    allowHttp: /(?:^|-)allowhttp-1(?:-|$)/.test(u),
    country: u.match(/(?:^|-)country-([A-Za-z]{2})(?:-|$)/)?.[1],
    session: u.match(/(?:^|-)session-([a-zA-Z0-9]+)(?:-|$)/)?.[1],
  };
}

const base = { country: null, ipClass: null, sticky: false, sessionId: null, plaintext: false } as const;

describe("buildUsername", () => {
  it("emits a bare agent username with no flags", () => {
    expect(buildUsername(base)).toBe("agent");
  });

  it("builds all flags with hyphens in gateway order", () => {
    const u = buildUsername({ country: "US", ipClass: "residential", sticky: true, sessionId: "abc123", plaintext: true });
    expect(u).toBe("agent-country-US-class-residential-session-abc123-allowhttp-1");
    expect(gatewayParse(u)).toEqual({ legacyPrefix: false, ipClass: "residential", allowHttp: true, country: "US", session: "abc123" });
  });

  it("never uses legacy dc-/residential- prefixes or underscores", () => {
    for (const ipClass of ["dc", "residential", "mobile"] as const) {
      const u = buildUsername({ ...base, ipClass, country: "DE" });
      expect(u.startsWith("agent-")).toBe(true);
      expect(gatewayParse(u).legacyPrefix).toBe(false);
      expect(gatewayParse(u).ipClass).toBe(ipClass);
      expect(u).not.toContain("_");
    }
  });

  it("omits session unless sticky, and plaintext unless opted in", () => {
    expect(buildUsername({ ...base, sessionId: "abc" })).toBe("agent");
    expect(buildUsername({ ...base, sticky: true, sessionId: null })).toBe("agent");
    expect(gatewayParse(buildUsername(base)).allowHttp).toBe(false);
  });

  it("drops malformed country/session values instead of injecting them", () => {
    expect(buildUsername({ ...base, country: "us-session-x" })).toBe("agent");
    expect(buildUsername({ ...base, sticky: true, sessionId: "a-b" })).toBe("agent");
  });

  it("newSessionId is 16 hex chars and random", () => {
    const a = newSessionId();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(newSessionId()).not.toBe(a);
  });
});
