import { describe, it, expect } from "vitest";
import { resolveGateway, NODE_SETUP_GUIDE } from "./core.js";

const envOf = (e: Record<string, string>) => (k: string) => e[k];

describe("gateway endpoint", () => {
  it("defaults to TLS on 8443 (production refuses plaintext 8080/1080)", () => {
    expect(resolveGateway({}, envOf({}))).toEqual({ proxyHost: undefined, httpProxyPort: undefined, gatewayTls: { port: 8443 } });
  });

  it("DOMINUSNODE_PROXY_URL sets host and TLS port (self-host 8444)", () => {
    const g = resolveGateway({}, envOf({ DOMINUSNODE_PROXY_URL: "https://Proxy.Example.org:8444" }));
    expect(g.proxyHost).toBe("proxy.example.org");
    expect(g.gatewayTls).toEqual({ port: 8444 });
    expect(resolveGateway({}, envOf({ DOMINUSNODE_PROXY_URL: "https://gw.example" })).gatewayTls).toEqual({ port: 8443 });
    expect(resolveGateway({}, envOf({ DOMINUSNODE_PROXY_TLS_PORT: "8444" })).gatewayTls).toEqual({ port: 8444 });
    expect(resolveGateway({ tlsProxyPort: 9443 }, envOf({})).gatewayTls).toEqual({ port: 9443 });
  });

  it("refuses non-https or credentialed proxy URLs", () => {
    expect(() => resolveGateway({}, envOf({ DOMINUSNODE_PROXY_URL: "http://gw.example:8080" }))).toThrow(/https/);
    expect(() => resolveGateway({}, envOf({ DOMINUSNODE_PROXY_URL: "https://u:p@gw.example" }))).toThrow(/credentials/);
  });

  it("plaintext only when asked for explicitly", () => {
    expect(resolveGateway({}, envOf({ DOMINUSNODE_PROXY_INSECURE: "1", DOMINUSNODE_PROXY_PORT: "9080" })))
      .toEqual({ proxyHost: undefined, httpProxyPort: 9080, gatewayTls: false });
    expect(resolveGateway({ insecureProxy: true }, envOf({})).gatewayTls).toBe(false);
  });

  it("node setup guide uses the published image, not a pinless source build", () => {
    expect(NODE_SETUP_GUIDE).toContain("ghcr.io/0xcircuitbreaker/dominusnode-node");
    expect(NODE_SETUP_GUIDE).not.toContain("npm run build -w");
  });
});
