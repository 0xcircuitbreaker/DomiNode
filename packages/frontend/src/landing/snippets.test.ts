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

  it("run a node from the published image, not a pinless source build", () => {
    const node = SNIPPETS.find((s) => s.id === "node-agent")!.code;
    expect(node).toContain("ghcr.io/0xcircuitbreaker/dominusnode-node");
    expect(node).not.toContain("npm run build");
  });
});
