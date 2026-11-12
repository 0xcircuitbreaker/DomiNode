import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { loadProxyTls, parseRequireTls, createPlaintextAuthGuard, watchProxyTlsCert } from "./proxy-tls.js";

const read = (p: string) => Buffer.from(`file:${p}`);

describe("loadProxyTls", () => {
  it("returns null when nothing is set", () => {
    expect(loadProxyTls({}, read)).toBeNull();
  });

  it("loads port, cert and key", () => {
    const c = loadProxyTls({ PROXY_TLS_PORT: "8443", PROXY_TLS_CERT_FILE: "/c", PROXY_TLS_KEY_FILE: "/k" }, read);
    expect(c).toEqual({ port: 8443, socks5Port: null, cert: read("/c"), key: read("/k"), certFile: "/c", keyFile: "/k" });
  });

  it("accepts an optional SOCKS5_TLS_PORT", () => {
    const c = loadProxyTls({ PROXY_TLS_PORT: "8443", SOCKS5_TLS_PORT: "1443", PROXY_TLS_CERT_FILE: "/c", PROXY_TLS_KEY_FILE: "/k" }, read);
    expect(c?.socks5Port).toBe(1443);
  });

  it.each(["abc", "0", "65536", "-1", "8443x", "1e3", "NaN"])("rejects invalid port %s", (p) => {
    expect(() => loadProxyTls({ PROXY_TLS_PORT: p, PROXY_TLS_CERT_FILE: "/c", PROXY_TLS_KEY_FILE: "/k" }, read)).toThrow(/PROXY_TLS_PORT/);
  });

  it("requires both cert and key", () => {
    expect(() => loadProxyTls({ PROXY_TLS_PORT: "8443", PROXY_TLS_CERT_FILE: "/c" }, read)).toThrow(/KEY_FILE/);
    expect(() => loadProxyTls({ PROXY_TLS_PORT: "8443", PROXY_TLS_KEY_FILE: "/k" }, read)).toThrow(/CERT_FILE/);
  });

  it("refuses cert files without a port, and SOCKS5_TLS_PORT alone", () => {
    expect(() => loadProxyTls({ PROXY_TLS_CERT_FILE: "/c", PROXY_TLS_KEY_FILE: "/k" }, read)).toThrow(/without PROXY_TLS_PORT/);
    expect(() => loadProxyTls({ SOCKS5_TLS_PORT: "1443" }, read)).toThrow(/requires PROXY_TLS_PORT/);
  });

  it("refuses identical HTTPS and SOCKS5 TLS ports", () => {
    expect(() => loadProxyTls({ PROXY_TLS_PORT: "8443", SOCKS5_TLS_PORT: "8443", PROXY_TLS_CERT_FILE: "/c", PROXY_TLS_KEY_FILE: "/k" }, read)).toThrow(/differ/);
  });
});

describe("parseRequireTls", () => {
  it("is opt-in outside production", () => {
    expect(parseRequireTls({})).toBe(false);
    expect(parseRequireTls({ PROXY_REQUIRE_TLS: "1" })).toBe(false);
    expect(parseRequireTls({ PROXY_REQUIRE_TLS: "true" })).toBe(true);
  });
  it("defaults on in production; only an explicit \"false\" turns it off", () => {
    expect(parseRequireTls({}, true)).toBe(true);
    expect(parseRequireTls({ PROXY_REQUIRE_TLS: "0" }, true)).toBe(true);
    expect(parseRequireTls({ PROXY_REQUIRE_TLS: "False" }, true)).toBe(true);
    expect(parseRequireTls({ PROXY_REQUIRE_TLS: "false" }, true)).toBe(false);
  });
});

describe("createPlaintextAuthGuard", () => {
  it("refuses everything when requireTls", () => {
    const warn = vi.fn();
    const g = createPlaintextAuthGuard({ production: true, requireTls: true, warn });
    expect(g("http")).toBe(false);
    expect(g("socks5")).toBe(false);
  });

  it("allows silently outside production", () => {
    const warn = vi.fn();
    const g = createPlaintextAuthGuard({ production: false, requireTls: false, warn });
    expect(g("http")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns in production, rate limited per listener", () => {
    const warn = vi.fn();
    let t = 0;
    const g = createPlaintextAuthGuard({ production: true, requireTls: false, warn, now: () => t, intervalMs: 1000 });
    expect(g("http")).toBe(true);
    g("http");
    g("socks5");
    expect(warn).toHaveBeenCalledTimes(2);
    t = 1000;
    g("http");
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0][1]).toEqual({ listener: "http" });
  });
});

describe("watchProxyTlsCert", () => {
  const fx = path.join(__dirname, "__fixtures__");
  const cert = fs.readFileSync(path.join(fx, "test-proxy-tls.crt"));
  const key = fs.readFileSync(path.join(fx, "test-proxy-tls.key"));
  const log = { info: vi.fn(), warn: vi.fn() };

  it("applies a changed valid pair to every server with TLS 1.3 options", () => {
    const files: Record<string, Buffer> = { "/c": Buffer.from("old"), "/k": Buffer.from("old") };
    const s1 = { setSecureContext: vi.fn() };
    const s2 = { setSecureContext: vi.fn() };
    const w = watchProxyTlsCert({ certFile: "/c", keyFile: "/k", servers: [s1, s2], initial: { cert: files["/c"], key: files["/k"] }, log, readFile: (p) => files[p], intervalMs: 1e9 });
    expect(w.check()).toBe(false);
    files["/c"] = cert; files["/k"] = key;
    expect(w.check()).toBe(true);
    expect(s1.setSecureContext).toHaveBeenCalledWith(expect.objectContaining({ cert, key, minVersion: "TLSv1.3" }));
    expect(s2.setSecureContext).toHaveBeenCalledTimes(1);
    expect(w.check()).toBe(false);
    w.stop();
  });

  it("keeps the current cert on an invalid pair or read error", () => {
    const files: Record<string, Buffer> = { "/c": cert, "/k": key };
    const s = { setSecureContext: vi.fn() };
    const w = watchProxyTlsCert({
      certFile: "/c", keyFile: "/k", servers: [s], initial: { cert, key }, log, intervalMs: 1e9,
      readFile: (p) => { const b = files[p]; if (!b) throw new Error("ENOENT"); return b; },
    });
    files["/c"] = Buffer.from("-----BEGIN CERTIFICATE-----\nhalf");
    expect(w.check()).toBe(false);
    delete files["/k"];
    expect(w.check()).toBe(false);
    expect(s.setSecureContext).not.toHaveBeenCalled();
    w.stop();
  });
});
