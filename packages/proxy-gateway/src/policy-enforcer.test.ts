import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSanctioned = vi.fn();
vi.mock("./geo-check.js", () => ({ checkSanctionedCountry: (ip: string) => mockSanctioned(ip) }));

import { DEFAULT_POLICY, type NetworkPolicy } from "@dominusnode/shared";
import { enforcePolicy, isDeniedDomain, recordRequesterSpend, getRequesterSpend, _resetPolicyEnforcer, isPlaintextPort } from "./policy-enforcer.js";

function pol(over: Partial<NetworkPolicy> = {}): NetworkPolicy {
  return { ...structuredClone(DEFAULT_POLICY), ...over };
}
const base = { userId: "u1", host: "example.com", port: 443, plaintext: false, allowHttp: false };

describe("policy-enforcer", () => {
  beforeEach(() => {
    _resetPolicyEnforcer();
    mockSanctioned.mockReturnValue(null);
  });

  it("allows an HTTPS request within policy", () => {
    expect(enforcePolicy(pol(), base)).toEqual({ allowed: true, exitVisible: false });
  });

  it("blocks ports outside the policy list", () => {
    expect(enforcePolicy(pol(), { ...base, port: 8443 })).toMatchObject({ allowed: false, status: 403, code: "PORT_BLOCKED" });
  });

  it("matches deny domains exactly or by suffix, not by substring", () => {
    expect(isDeniedDomain("bank.com", ["bank.com"])).toBe(true);
    expect(isDeniedDomain("www.Bank.com.", ["bank.com"])).toBe(true);
    expect(isDeniedDomain("notbank.com", ["bank.com"])).toBe(false);
    expect(enforcePolicy(pol({ denyDomains: ["bank.com"] }), { ...base, host: "a.bank.com" }))
      .toMatchObject({ allowed: false, code: "DOMAIN_BLOCKED" });
  });

  it("blocks IP-literal destinations in sanctioned countries", () => {
    mockSanctioned.mockReturnValue("IR");
    expect(enforcePolicy(pol(), { ...base, host: "5.0.0.1" })).toMatchObject({ allowed: false, code: "SANCTIONED_DESTINATION" });
  });

  it("geo-checks every resolved address of a hostname destination", () => {
    mockSanctioned.mockImplementation((ip: string) => (ip === "5.0.0.1" ? "IR" : null));
    expect(enforcePolicy(pol(), { ...base, resolvedIps: ["1.1.1.1", "5.0.0.1"] }))
      .toMatchObject({ allowed: false, code: "SANCTIONED_DESTINATION" });
    expect(enforcePolicy(pol(), { ...base, resolvedIps: ["1.1.1.1"] }).allowed).toBe(true);
  });

  it("only 443 counts as TLS for the plaintext gate", () => {
    expect(isPlaintextPort(443)).toBe(false);
    expect(isPlaintextPort(80)).toBe(true);
    expect(isPlaintextPort(8080)).toBe(true);
  });

  describe("plaintext", () => {
    const http = { ...base, port: 80, plaintext: true };
    it("deny refuses even with allowhttp-1", () => {
      expect(enforcePolicy(pol({ plaintext: "deny" }), { ...http, allowHttp: true }))
        .toMatchObject({ allowed: false, status: 400, code: "PLAINTEXT_DISABLED" });
    });
    it("opt_in requires allowhttp-1 and marks exit visible", () => {
      expect(enforcePolicy(pol({ plaintext: "opt_in" }), http)).toMatchObject({ allowed: false, code: "PLAINTEXT_DISABLED" });
      expect(enforcePolicy(pol({ plaintext: "opt_in" }), { ...http, allowHttp: true })).toEqual({ allowed: true, exitVisible: true });
    });
    it("allow passes and still marks exit visible", () => {
      expect(enforcePolicy(pol({ plaintext: "allow" }), http)).toEqual({ allowed: true, exitVisible: true });
    });
  });

  it("enforces per-requester req/s", () => {
    const p = pol({ requesterLimits: { reqPerSec: 2, dailySpendMusd: 1_000_000 } });
    expect(enforcePolicy(p, base, 1000).allowed).toBe(true);
    expect(enforcePolicy(p, base, 1001).allowed).toBe(true);
    expect(enforcePolicy(p, base, 1002)).toMatchObject({ allowed: false, status: 429, code: "RATE_LIMITED" });
    expect(enforcePolicy(p, { ...base, userId: "u2" }, 1002).allowed).toBe(true);
    expect(enforcePolicy(p, base, 2001).allowed).toBe(true);
  });

  it("enforces the daily spend cap per requester", () => {
    const p = pol({ requesterLimits: { reqPerSec: 100, dailySpendMusd: 1000 } });
    recordRequesterSpend("u1", 999n, 5000);
    expect(enforcePolicy(p, base, 5000).allowed).toBe(true);
    recordRequesterSpend("u1", 1n, 5000);
    expect(getRequesterSpend("u1", 5000)).toBe(1000n);
    expect(enforcePolicy(p, base, 5001)).toMatchObject({ allowed: false, code: "SPEND_CAP_EXCEEDED" });
    // Next day resets
    expect(enforcePolicy(p, base, 5000 + 86_400_000).allowed).toBe(true);
  });
});
