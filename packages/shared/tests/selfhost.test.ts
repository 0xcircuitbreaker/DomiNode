import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const COMPOSE = ["docker-compose.demo.yml", "docker-compose.selfhost.yml"];
const INSTALL = path.join(ROOT, "scripts/selfhost/install.sh");

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const dockerCompose = has("docker", ["compose", "version"]);

const composeEnv = {
  ...process.env,
  POSTGRES_PASSWORD: "x", JWT_SECRET: "x", MFA_ENCRYPTION_KEY: "x",
  DOMINUSNODE_DOMAIN: "example.org", DN_COORD_PUBKEYS: "0".repeat(64),
};

describe("self-host compose files", () => {
  for (const file of COMPOSE) {
    it(`${file} parses`, () => {
      const full = path.join(ROOT, file);
      if (dockerCompose) {
        const r = spawnSync("docker", ["compose", "-f", full, "config", "-q"], { env: composeEnv, encoding: "utf8" });
        expect(r.stderr).toBe("");
        expect(r.status).toBe(0);
      } else {
        const yaml = createRequire(__filename)("js-yaml") as { load(s: string): unknown };
        const doc = yaml.load(fs.readFileSync(full, "utf8")) as { services?: Record<string, unknown> };
        expect(Object.keys(doc.services ?? {})).toContain("gateway");
      }
    });
  }

  it("demo compose is development-only and loopback-bound", () => {
    const text = fs.readFileSync(path.join(ROOT, "docker-compose.demo.yml"), "utf8");
    expect(text).toContain("DEMO, NOT FOR PRODUCTION");
    expect(text).not.toMatch(/NODE_ENV:\s*production/);
    for (const m of text.matchAll(/-\s*"([^"]*:\d+:\d+)"/g)) expect(m[1]).toMatch(/^127\.0\.0\.1:/);
  });

  it("new compose files hardcode no canonical hostname", () => {
    for (const file of COMPOSE) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(text).not.toMatch(/daedalusdevelopmentgroup\.com|dominusnode\.com|@gmail\./);
    }
  });
});

describe("scripts/selfhost/install.sh", () => {
  it.runIf(has("shellcheck", ["--version"]))("is shellcheck-clean", () => {
    execFileSync("shellcheck", [INSTALL]);
  });

  it.runIf(has("openssl", ["version"]))("is idempotent and supports several hostnames", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-selfhost-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts/selfhost"), { recursive: true });
      fs.copyFileSync(INSTALL, path.join(tmp, "scripts/selfhost/install.sh"));
      fs.copyFileSync(path.join(ROOT, "scripts/gen-coord-key.mjs"), path.join(tmp, "scripts/gen-coord-key.mjs"));
      const run = () => execFileSync("bash", [path.join(tmp, "scripts/selfhost/install.sh"), "--yes", "--no-start"], {
        env: { ...process.env, DOMINUSNODE_HOSTNAMES: "Node.Example.org, relay.example.net", TLS_MODE: "auto", OPERATOR_CONTACT: "ops@example.org", SKIP_ASN_DB: "1" },
        stdio: "pipe",
      });
      run();
      const env1 = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env1).toMatch(/^DOMINUSNODE_DOMAIN=node\.example\.org$/m);
      expect(env1).toMatch(/^PUBLIC_HOSTNAMES=node\.example\.org,relay\.example\.net$/m);
      expect(env1).toMatch(/^DN_COORD_PUBKEYS=[0-9a-f]{64}$/m);
      expect(fs.statSync(path.join(tmp, ".env")).mode & 0o077).toBe(0);
      expect(fs.statSync(path.join(tmp, "selfhost/coord-key.pem")).mode & 0o077).toBe(0);
      const caddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
      expect(caddy).toContain("node.example.org, relay.example.net {");
      expect(caddy).toContain("node.example.org:8443, relay.example.net:8443 {");
      expect(caddy).toContain("proxy_protocol v2");
      expect(env1).toMatch(/^TUNNEL_SCHEME=wss$/m);
      run();
      const env2 = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      const pick = (s: string, k: string) => s.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1];
      for (const k of ["POSTGRES_PASSWORD", "JWT_SECRET", "MFA_ENCRYPTION_KEY", "DN_COORD_PUBKEYS"]) {
        expect(pick(env2, k)).toBe(pick(env1, k));
      }
      expect(env2.match(/^JWT_SECRET=/gm)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  describe("input validation", () => {
    const setup = () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-selfhost-"));
      fs.mkdirSync(path.join(tmp, "scripts/selfhost"), { recursive: true });
      fs.copyFileSync(INSTALL, path.join(tmp, "scripts/selfhost/install.sh"));
      fs.copyFileSync(path.join(ROOT, "scripts/gen-coord-key.mjs"), path.join(tmp, "scripts/gen-coord-key.mjs"));
      // Stub downloader that always fails (no network in tests).
      fs.writeFileSync(path.join(tmp, "scripts/update-asn-db.sh"), "#!/usr/bin/env bash\nexit 1\n");
      return tmp;
    };
    const run = (tmp: string, env: Record<string, string>) =>
      spawnSync("bash", [path.join(tmp, "scripts/selfhost/install.sh"), "--yes", "--no-start"], {
        env: { ...process.env, DOMINUSNODE_HOSTNAMES: "node.example.org", TLS_MODE: "auto", SKIP_ASN_DB: "1", ...env },
        encoding: "utf8",
      });

    for (const bad of ["ops@example.org\n}\nevil.example {", "ops@example.org }", "a b@example.org", "ops@example.org\nDN_COORD_PUBKEYS=00", "\"ops\"@example.org"]) {
      it.runIf(has("openssl", ["version"]))(`rejects contact ${JSON.stringify(bad)}`, () => {
        const tmp = setup();
        try {
          const r = run(tmp, { OPERATOR_CONTACT: bad });
          expect(r.status).not.toBe(0);
          expect(r.stderr).toMatch(/invalid contact email/);
          expect(fs.existsSync(path.join(tmp, "selfhost/Caddyfile"))).toBe(false);
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    }

    it.runIf(has("openssl", ["version"]))("fails without the ASN database unless SKIP_ASN_DB=1", () => {
      const tmp = setup();
      try {
        const r = run(tmp, { OPERATOR_CONTACT: "ops@example.org", SKIP_ASN_DB: "0" });
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/ASN\/geo database download failed/);
        const ok = run(tmp, { OPERATOR_CONTACT: "ops@example.org", SKIP_ASN_DB: "1" });
        expect(ok.status).toBe(0);
        expect(ok.stderr).toMatch(/SKIP_ASN_DB=1/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 30_000);
  });

  it("node tunnel goes through Caddy with PROXY v2, not a published gateway port", () => {
    const text = fs.readFileSync(path.join(ROOT, "docker-compose.selfhost.yml"), "utf8");
    const gateway = text.slice(text.indexOf("\n  gateway:"), text.indexOf("\n  caddy:"));
    const caddy = text.slice(text.indexOf("\n  caddy:"), text.indexOf("\n  node:"));
    expect(gateway).not.toMatch(/-\s*"[^"]*:8443"/);
    expect(gateway).toMatch(/TUNNEL_TRUSTED_PROXY_IPS:\s*172\.29\.53\.2/);
    expect(caddy).toMatch(/:8443"/);
    expect(caddy).toMatch(/ipv4_address:\s*172\.29\.53\.2/);
  });
});
