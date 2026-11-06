import { describe, expect, it, vi } from "vitest";
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
    expect(pac).toContain('"HTTPS proxy.dominusnode.com:8080"');
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

describe("WebRTC leak guard", () => {
  it("forces WebRTC through the proxy while proxying and clears it after", async () => {
    const { setPac, clearProxy } = await import("./proxy.js");
    const policy = { set: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    const proxySettings = { set: vi.fn(async () => {}), clear: vi.fn(async () => {}) };
    const c = globalThis as unknown as { chrome: Record<string, unknown> };
    const prevPrivacy = c.chrome.privacy;
    const prevProxy = c.chrome.proxy;
    c.chrome.privacy = { network: { webRTCIPHandlingPolicy: policy } };
    c.chrome.proxy = { settings: proxySettings };
    try {
      await setPac(buildPac("proxy", "proxy.dominusnode.com", 8080, "api.dominusnode.com"));
      expect(policy.set).toHaveBeenCalledWith({ value: "disable_non_proxied_udp", scope: "regular" });
      await clearProxy();
      expect(policy.clear).toHaveBeenCalledWith({ scope: "regular" });
    } finally {
      c.chrome.privacy = prevPrivacy;
      c.chrome.proxy = prevProxy;
    }
  });
});

describe("gateway TLS", () => {
  it("emits HTTPS host:port by default so the key never crosses in clear", () => {
    const pac = buildPac("proxy", "proxy.dominusnode.com", 8443, "api.dominusnode.com");
    expect(pac).toContain('"HTTPS proxy.dominusnode.com:8443"');
    expect(pac).not.toContain('"PROXY proxy.dominusnode.com');
  });

  it("refuses plaintext to a non-local gateway", () => {
    expect(() => buildPac("proxy", "proxy.dominusnode.com", 8080, "api.dominusnode.com", false)).toThrow(/Plaintext/);
  });

  it("allows plaintext only for localhost / 127.0.0.1", () => {
    expect(buildPac("proxy", "localhost", 8080, "api.dominusnode.com", false)).toContain('"PROXY localhost:8080"');
    expect(buildPac("proxy", "127.0.0.1", 8080, "api.dominusnode.com", false)).toContain('"PROXY 127.0.0.1:8080"');
  });
});
