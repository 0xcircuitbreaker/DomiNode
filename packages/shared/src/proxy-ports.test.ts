import { describe, it, expect } from "vitest";
import { getProxyPorts, getPublicProxyPorts, getProxyInternalPort, assertDistinctProxyPorts } from "./proxy-ports.js";

describe("proxy ports", () => {
  it("defaults: 8080 / 1080 / TLS off / tunnel 9443 (not the TLS proxy's 8443)", () => {
    expect(getProxyPorts({})).toEqual({ http: 8080, socks5: 1080, tls: null, socks5Tls: null, tunnel: 9443 });
  });

  it("reads the gateway's real env names", () => {
    const env = { PROXY_LISTEN_PORT: "18080", SOCKS5_LISTEN_PORT: "11080", PROXY_TLS_PORT: "8443", SOCKS5_TLS_PORT: "1443", TUNNEL_PORT: "9444" };
    expect(getProxyPorts(env)).toEqual({ http: 18080, socks5: 11080, tls: 8443, socks5Tls: 1443, tunnel: 9444 });
  });

  it("ignores the old drifted names (PROXY_HTTP_PORT, PROXY_SOCKS5_PORT)", () => {
    expect(getProxyPorts({ PROXY_HTTP_PORT: "1", PROXY_SOCKS5_PORT: "2" }).http).toBe(8080);
  });

  it("advertised ports take PROXY_PUBLIC_* overrides", () => {
    const env = { PROXY_LISTEN_PORT: "18080", PROXY_TLS_PORT: "8443", PROXY_PUBLIC_HTTP_PORT: "80", PROXY_PUBLIC_TLS_PORT: "443" };
    expect(getPublicProxyPorts(env)).toMatchObject({ http: 80, socks5: 1080, tls: 443, tunnel: 9443 });
  });

  it("internal port: PROXY_INTERNAL_PORT, else the HTTP listener", () => {
    expect(getProxyInternalPort({ PROXY_LISTEN_PORT: "18080" })).toBe(18080);
    expect(getProxyInternalPort({ PROXY_LISTEN_PORT: "18080", PROXY_INTERNAL_PORT: "9000" })).toBe(9000);
  });

  it("rejects invalid values", () => {
    expect(() => getProxyPorts({ TUNNEL_PORT: "abc" })).toThrow(/TUNNEL_PORT/);
    expect(() => getProxyPorts({ PROXY_LISTEN_PORT: "70000" })).toThrow(/PROXY_LISTEN_PORT/);
  });

  it("assertDistinctProxyPorts names both clashing variables", () => {
    expect(() => assertDistinctProxyPorts(getProxyPorts({ PROXY_TLS_PORT: "8443", TUNNEL_PORT: "8443" })))
      .toThrow(/PROXY_TLS_PORT and TUNNEL_PORT are both 8443/);
    expect(() => assertDistinctProxyPorts(getProxyPorts({ SOCKS5_LISTEN_PORT: "8080" })))
      .toThrow(/PROXY_LISTEN_PORT and SOCKS5_LISTEN_PORT/);
    expect(() => assertDistinctProxyPorts(getProxyPorts({ PROXY_TLS_PORT: "8443" }))).not.toThrow();
  });
});
