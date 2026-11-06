import { describe, expect, it } from "vitest";
import { buildPac, createAuthHandler, type GatewayCreds } from "./proxy.js";

const creds: GatewayCreds = {
  host: "proxy.dominusnode.com",
  port: 8080,
  auth: { username: "agent-country-US", password: "dn_live_testkey12345" },
};

const challenge = (over: Record<string, unknown> = {}) =>
  ({ requestId: "1", isProxy: true, challenger: { host: "proxy.dominusnode.com", port: 8080 }, ...over }) as never;

describe("auth handler", () => {
  it("answers gateway proxy challenges with flags as username and key as password", () => {
    const h = createAuthHandler(() => creds);
    expect(h(challenge())).toEqual({ authCredentials: { username: "agent-country-US", password: "dn_live_testkey12345" } });
  });

  it("never answers origin-server (non-proxy) challenges", () => {
    const h = createAuthHandler(() => creds);
    expect(h(challenge({ isProxy: false }))).toEqual({});
  });

  it("ignores proxies other than the configured gateway host:port", () => {
    const h = createAuthHandler(() => creds);
    expect(h(challenge({ challenger: { host: "evil.example", port: 8080 } }))).toEqual({});
    expect(h(challenge({ challenger: { host: "proxy.dominusnode.com", port: 3128 } }))).toEqual({});
  });

  it("cancels a repeated challenge for the same request (rejected key, no loop)", () => {
    const h = createAuthHandler(() => creds);
    expect(h(challenge())).toHaveProperty("authCredentials");
    expect(h(challenge())).toEqual({ cancel: true });
    expect(h(challenge({ requestId: "2" }))).toHaveProperty("authCredentials");
  });

  it("cancels gateway challenges while blocked (no auth)", () => {
    const h = createAuthHandler(() => ({ ...creds, auth: null }));
    expect(h(challenge())).toEqual({ cancel: true });
  });

  it("stays out of the way when disabled", () => {
    const h = createAuthHandler(() => null);
    expect(h(challenge())).toEqual({});
  });
});

describe("buildPac", () => {
  it("routes through the gateway and bypasses the API host", () => {
    const pac = buildPac("proxy", "proxy.dominusnode.com", 8080, "api.dominusnode.com");
    expect(pac).toContain('"PROXY proxy.dominusnode.com:8080"');
    expect(pac).toContain('host === "api.dominusnode.com"');
    expect(pac).not.toContain("dn_live_");
  });

  it("block mode fails closed to a dead loopback port, never DIRECT for normal hosts", () => {
    const pac = buildPac("block", "proxy.dominusnode.com", 8080, "api.dominusnode.com");
    const fn = new Function(
      "isPlainHostName", "dnsDomainIs",
      `${pac}; return FindProxyForURL;`,
    )((h: string) => !h.includes("."), (h: string, d: string) => h.endsWith(d));
    expect(fn("https://example.com/", "example.com")).toBe("PROXY 127.0.0.1:9");
    expect(fn("https://api.dominusnode.com/", "api.dominusnode.com")).toBe("DIRECT");
  });

  it("rejects hosts that could inject into the PAC script", () => {
    expect(() => buildPac("proxy", 'x";alert(1);"', 8080, "api.dominusnode.com")).toThrow();
    expect(() => buildPac("proxy", "proxy.dominusnode.com", 70000, "api.dominusnode.com")).toThrow();
  });
});
