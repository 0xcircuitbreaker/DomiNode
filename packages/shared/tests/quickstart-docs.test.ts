import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TUNNEL_PORT } from "../src/proxy-ports.js";

/**
 * The five-minute quickstart must match the current port layout:
 * HTTPS proxy 8443, SOCKS5 over TLS 1443, node tunnel 9443. Plaintext 8080/1080
 * never carry credentials, and hosts are the public ones or example.* placeholders.
 */
const ROOT = resolve(__dirname, "../../..");
const FILES = [
  "docs/agent-network/QUICKSTART.md",
  "scripts/quickstart-smoke.sh",
  "packages/frontend/public/llms.txt",
  "packages/frontend/public/docs/agents.md",
  "packages/frontend/src/landing/snippets.ts",
  "packages/frontend/src/landing/quickstart.ts",
];
const read = (f: string) => readFileSync(resolve(ROOT, f), "utf8");

const ALLOWED_HOSTS = [
  /^(api|proxy|relay)\.dominusnode\.com$/,
  /^dominusnode\.com$/,
  /^github\.com$/,
  /^daedalusdevelopmentgroup\.com$/,
  /^ghcr\.io$/,
  /^httpbin\.org$/,
  /^example\.(com|org)$/,
  /^[a-z0-9-]+\.example\.org$/,
];
const PROXY_HOST_RE = /(proxy\.dominusnode\.com|proxy\.example\.org|\$\{PROXY_HOST\}|\$\{DN_PROXY_HOST\})/;

describe("quickstart docs and snippets", () => {
  it("uses the shared tunnel default", () => {
    expect(DEFAULT_TUNNEL_PORT).toBe(9443);
  });

  for (const f of FILES) {
    describe(f, () => {
      const text = read(f);

      it("sends credentials only to the TLS proxy on 8443", () => {
        // Any `-x` / proxy URL that carries a key must use https and port 8443.
        for (const m of text.matchAll(/-x\s+"([^"]+)"/g)) {
          const url = m[1]!;
          if (!/\$(DOMINUSNODE_API_KEY|\{?KEY)|dn_live_/.test(url) && !PROXY_HOST_RE.test(url)) continue;
          expect(url, `${f}: ${url}`).toMatch(/^https:\/\//);
          expect(url, `${f}: ${url}`).toMatch(/:(8443|\$\{DN_PROXY_PORT\})$/);
        }
      });

      it("never pairs a proxy host with a wrong port", () => {
        for (const m of text.matchAll(/(?:proxy\.dominusnode\.com|proxy\.example\.org|\$\{PROXY_HOST\}):(\d+)/g)) {
          expect(["8443", "1443"], `${f}: ${m[0]}`).toContain(m[1]);
        }
        expect(text, f).not.toMatch(/tunnel[^\n]{0,40}:8443\b/i);
        expect(text, f).not.toMatch(/SOCKS5[- ]?(over[- ])?TLS\)?:?\s*`?:?(8443|9443|1080)\b/i);
      });

      it("uses only public or placeholder hosts", () => {
        for (const m of text.matchAll(/https?:\/\/(?:[^@\s"'`/]*@)?([A-Za-z0-9.${}_-]+)/g)) {
          const host = m[1]!.toLowerCase().replace(/\}+$/, "");
          if (host === "" || host.startsWith("$")) continue;
          expect(ALLOWED_HOSTS.some((re) => re.test(host)), `${f}: host ${host}`).toBe(true);
        }
      });

      it("contains placeholder keys only", () => {
        for (const m of text.matchAll(/dn_(live|test|node)_[A-Za-z0-9_]*/g)) {
          expect(["dn_live_", "dn_test_", "dn_node_", "dn_live_YOUR_KEY"], `${f}: ${m[0]}`).toContain(m[0]);
        }
      });
    });
  }

  it("documents all three ports in QUICKSTART.md and llms.txt", () => {
    for (const f of ["docs/agent-network/QUICKSTART.md", "packages/frontend/public/llms.txt"]) {
      const t = read(f);
      expect(t, f).toMatch(/8443/);
      expect(t, f).toMatch(/1443/);
      expect(t, f).toMatch(/9443/);
    }
  });

  it("keeps the key out of argv in the new quickstart examples", () => {
    // QUICKSTART.md tells agents never to pass the key as an argument, so its own
    // examples (and the copies on the site and in llms.txt) must not embed it in a proxy URL.
    for (const f of ["docs/agent-network/QUICKSTART.md", "packages/frontend/src/landing/quickstart.ts", "packages/frontend/public/llms.txt"]) {
      const t = read(f);
      const section = f.endsWith("llms.txt") ? t.slice(t.indexOf("## Five-minute quickstart"), t.indexOf("## Docs")) : t;
      expect(section, f).not.toMatch(/:\$\{?DOMINUSNODE_API_KEY\}?@/);
      expect(section, f).toMatch(/proxy-user = /);
    }
  });

  it("documents the crypto top-up rails accurately", () => {
    const t = read("docs/agent-network/QUICKSTART.md");
    expect(t).toContain("/api/wallet/topup/crypto");
    expect(t).toContain("/api/wallet/topup/tempo");
  });

  describe("scripts/quickstart-smoke.sh", () => {
    const sh = read("scripts/quickstart-smoke.sh");
    it("defaults to the TLS proxy port and reads the key from the environment", () => {
      expect(sh).toContain('DN_PROXY_PORT="${DN_PROXY_PORT:-8443}"');
      expect(sh).toContain("DOMINUSNODE_API_KEY");
    });
    it("never puts the key or token in a command's argv", () => {
      // The key reaches curl via a printf builtin on stdin or a config on fd 3.
      expect(sh).not.toMatch(/-u\s+"?\$/);
      expect(sh).not.toMatch(/--proxy-user\s/);
      expect(sh).not.toMatch(/-H\s+"Authorization/);
      expect(sh).not.toMatch(/jq[^\n]*--arg[^\n]*KEY/);
      expect(sh).toMatch(/-K \/dev\/fd\/3/);
    });
    it("validates DN_CA_BUNDLE before use", () => {
      expect(sh).toMatch(/DN_CA_BUNDLE must be a readable file/);
    });
    it("hits policy, pricing, balance and the proxy, with next steps on failure", () => {
      for (const s of ["/v1/policy", "/v1/pricing", "/api/auth/verify-key", "/api/wallet", "NO_NODES_AVAILABLE", "topup/crypto", "x402", "/status"]) {
        expect(sh, s).toContain(s);
      }
    });
  });
});
