import { describe, it, expect } from "vitest";
import { SNIPPETS } from "./snippets";

describe("landing quickstarts", () => {
  it("send credentials and x402 payments only to the TLS proxy", () => {
    for (const s of SNIPPETS) {
      // Production refuses credentials (API key or X-PAYMENT) on plaintext 8080/1080.
      expect(s.code, s.id).not.toMatch(/-x "(http|socks5h?):\/\/[^"]*:(8080|1080)"/);
    }
    expect(SNIPPETS.find((s) => s.id === "x402")!.code).toContain(":8443");
  });

  it("keep keys out of argv and proxy URLs; literal keys are marked placeholders", () => {
    for (const s of SNIPPETS) {
      expect(s.code, s.id).not.toMatch(/:\/\/[^\s"]*:\$?\{?DOMINUSNODE_API_KEY/);
      expect(s.code, s.id).not.toMatch(/:\/\/[^\s"]*:dn_live_/);
      expect(s.code, s.id).not.toMatch(/export DOMINUSNODE_API_KEY=dn_/);
      for (const k of s.code.match(/dn_live_[A-Za-z0-9_]+/g) ?? []) expect(k, s.id).toBe("dn_live_YOUR_KEY");
    }
    expect(SNIPPETS.find((s) => s.id === "curl")!.code).toContain("-K <(printf 'proxy-user = ");
  });

  it("run a node from the published image, not a pinless source build", () => {
    const node = SNIPPETS.find((s) => s.id === "node-agent")!.code;
    expect(node).toContain("ghcr.io/0xcircuitbreaker/dominusnode-node");
    expect(node).not.toContain("npm run build");
    expect(node).not.toMatch(/docker run[^\n]* -i?t\b/);
    expect(node).toContain("sudo rm /etc/dominusnode/wallet.key");
  });
});
