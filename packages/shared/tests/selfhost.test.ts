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

  it("gateway and node read their keys from uid-1001 volumes, never the host bind mount", () => {
    const yaml = createRequire(__filename)("js-yaml") as { load(s: string): unknown };
    type Svc = { volumes?: string[]; command?: string[]; user?: string; depends_on?: Record<string, { condition: string }>; network_mode?: string };
    const doc = yaml.load(fs.readFileSync(path.join(ROOT, "docker-compose.selfhost.yml"), "utf8")) as { services: Record<string, Svc>; volumes: Record<string, unknown> };
    const s = doc.services;
    expect(s.gateway.volumes).toContain("gateway_secrets:/run/dominusnode:ro");
    expect(s.gateway.volumes!.join(" ")).not.toContain("selfhost/coord-key.pem");
    expect(s.gateway.depends_on?.keys?.condition).toBe("service_completed_successfully");
    expect(s.node.volumes).toContain("node_secrets:/run/dominusnode:ro");
    expect(s.node.depends_on?.["node-keys"]?.condition).toBe("service_completed_successfully");
    for (const [name, file] of [["keys", "coord-key.pem"], ["node-keys", "node.json"]] as const) {
      const svc = s[name];
      expect(svc.user).toBe("0:0");
      expect(svc.network_mode).toBe("none");
      const cmd = svc.command!.join("\n");
      expect(cmd).toContain(`install -o 1001 -g 1001 -m 0400 /src/${file}`);
      expect(cmd).toContain("chmod 0500 /dst");
    }
    expect(Object.keys(doc.volumes)).toEqual(expect.arrayContaining(["gateway_secrets", "node_secrets"]));
  });

  it("installer leaves data/ traversable and checks the gateway can read its key", () => {
    const text = fs.readFileSync(INSTALL, "utf8");
    expect(text).toMatch(/chmod 0755 "\$ROOT\/data"/);
    expect(text).toMatch(/exec -T gateway[\s\\]*test -r \/run\/dominusnode\/coord-key\.pem/);
    expect(text.indexOf("test -r /run/dominusnode/coord-key.pem")).toBeLessThan(text.indexOf('echo "up.'));
  });

  it.runIf(has("openssl", ["version"]))("makes a pre-created 0700 data dir and 0600 ASN db readable", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-selfhost-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts/selfhost"), { recursive: true });
      fs.copyFileSync(INSTALL, path.join(tmp, "scripts/selfhost/install.sh"));
      fs.copyFileSync(path.join(ROOT, "scripts/gen-coord-key.mjs"), path.join(tmp, "scripts/gen-coord-key.mjs"));
      fs.mkdirSync(path.join(tmp, "data"), { mode: 0o700 });
      fs.writeFileSync(path.join(tmp, "data/ip2asn-combined.tsv.gz"), "", { mode: 0o600 });
      execFileSync("bash", [path.join(tmp, "scripts/selfhost/install.sh"), "--yes", "--no-start"], {
        env: { ...process.env, DOMINUSNODE_HOSTNAMES: "node.example.org", TLS_MODE: "auto", OPERATOR_CONTACT: "ops@example.org" },
        stdio: "pipe",
      });
      expect(fs.statSync(path.join(tmp, "data")).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.join(tmp, "data/ip2asn-combined.tsv.gz")).mode & 0o777).toBe(0o644);
      expect(fs.statSync(path.join(tmp, "selfhost/coord-key.pem")).mode & 0o077).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("self-host roles and Cloudflare Tunnel", () => {
  const MAIN = path.join(ROOT, "docker-compose.selfhost.yml");
  const WGDB = path.join(ROOT, "docker-compose.selfhost.wg-db.yml");
  const TOKEN = "eyJhIjoiU0VDUkVUVE9LRU5WQUxVRSJ9";
  const matrix: Array<[string, string, string[]]> = [];
  for (const role of ["all", "coordinator", "gateway"]) {
    for (const tls of ["auto", "internal", "off", "cloudflare"]) {
      if (role === "gateway" && tls === "cloudflare") continue;
      const p = role === "all" ? ["coordinator", "gateway", "caddy"] : role === "coordinator" ? ["coordinator", ...(tls === "cloudflare" ? [] : ["caddy"])] : ["gateway", "caddy"];
      if (tls === "cloudflare") p.push("cloudflare");
      matrix.push([role, tls, p]);
    }
  }

  type Cfg = { services: Record<string, { ports?: unknown[] }> };
  const config = (profiles: string[], files = [MAIN], extra: Record<string, string> = {}): Cfg => {
    const args = files.flatMap((f) => ["-f", f]).concat(profiles.flatMap((p) => ["--profile", p]), ["config", "--format", "json"]);
    const r = spawnSync("docker", ["compose", ...args], { env: { ...composeEnv, ...extra }, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout) as Cfg;
  };

  for (const [role, tls, profiles] of matrix) {
    it.runIf(dockerCompose)(`compose parses for ROLE=${role} TLS_MODE=${tls}`, () => {
      const cfg = config(profiles);
      const names = Object.keys(cfg.services);
      expect(names.includes("gateway")).toBe(role !== "coordinator");
      expect(names.includes("api")).toBe(role !== "gateway");
      expect(names.includes("cloudflared")).toBe(tls === "cloudflare");
      expect(cfg.services.api?.ports ?? []).toEqual([]);
      if (tls === "cloudflare") {
        expect(cfg.services.cloudflared.ports ?? []).toEqual([]);
        if (role === "coordinator") expect(names).not.toContain("caddy");
      }
    });
  }

  it.runIf(dockerCompose)("wg-db override publishes Postgres only on the WireGuard address", () => {
    const cfg = config(["coordinator"], [MAIN, WGDB], { DB_WG_BIND: "10.66.0.1" });
    expect(JSON.stringify(cfg.services.postgres.ports)).toContain('"host_ip":"10.66.0.1"');
  });

  it("cloudflared is pinned and reads its token from a file, never env or argv", () => {
    const text = fs.readFileSync(MAIN, "utf8");
    expect(text).toMatch(/cloudflare\/cloudflared:\d{4}\.\d+\.\d+@sha256:[0-9a-f]{64}/);
    expect(text).toContain('"--token-file", "/run/cloudflared/token"');
    expect(text).not.toMatch(/TUNNEL_TOKEN[^_]|"--token"/);
  });

  const setup = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-selfhost-"));
    fs.mkdirSync(path.join(tmp, "scripts/selfhost"), { recursive: true });
    fs.mkdirSync(path.join(tmp, "selfhost"), { recursive: true });
    fs.copyFileSync(INSTALL, path.join(tmp, "scripts/selfhost/install.sh"));
    fs.copyFileSync(path.join(ROOT, "scripts/gen-coord-key.mjs"), path.join(tmp, "scripts/gen-coord-key.mjs"));
    fs.writeFileSync(path.join(tmp, "selfhost/cloudflared.token"), TOKEN, { mode: 0o600 });
    return tmp;
  };
  const run = (tmp: string, env: Record<string, string>) =>
    spawnSync("bash", [path.join(tmp, "scripts/selfhost/install.sh"), "--yes", "--no-start"], {
      env: { ...process.env, OPERATOR_CONTACT: "ops@example.org", SKIP_ASN_DB: "1", RELAY_HOST: "relay.example.org", PROXY_HOST: "proxy.example.org", ...env },
      encoding: "utf8",
    });
  const pw = "a".repeat(48);
  const coordEnv = { ROLE: "coordinator", TLS_MODE: "cloudflare", DOMINUSNODE_HOSTNAMES: "example.org www.example.org api.example.org", DB_WG_BIND: "10.66.0.1" };
  const gwEnv = { ROLE: "gateway", TLS_MODE: "auto", DOMINUSNODE_HOSTNAMES: "example.org", GATEWAY_DATABASE_URL: `postgresql://dominusnode:${pw}@10.66.0.1:5432/dominusnode`, COORD_PUBKEY: "1".repeat(64) };

  it.runIf(has("openssl", ["version"]))("coordinator + cloudflare dry run: no Caddy sites, token never copied, idempotent", () => {
    const tmp = setup();
    try {
      for (let i = 0; i < 2; i++) {
        const r = run(tmp, coordEnv);
        expect(r.stderr).not.toMatch(/install:/);
        expect(r.status).toBe(0);
        expect(r.stdout + r.stderr).not.toContain(TOKEN);
      }
      const env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env).not.toContain(TOKEN);
      expect(env).toMatch(/^ROLE=coordinator$/m);
      expect(env).toMatch(/^CLOUDFLARE_TUNNEL_TOKEN_FILE=\.\/selfhost\/cloudflared\.token$/m);
      expect(env).toMatch(/^RELAY_HOST=relay\.example\.org$/m);
      expect(env).toMatch(/^DB_WG_BIND=10\.66\.0\.1$/m);
      expect(env.match(/^ROLE=/gm)).toHaveLength(1);
      expect(fs.statSync(path.join(tmp, ".env")).mode & 0o077).toBe(0);
      expect(fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8")).not.toContain("reverse_proxy");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(has("openssl", ["version"]))("gateway dry run: own key, both pins, relay-only Caddyfile", () => {
    const tmp = setup();
    try {
      const r = run(tmp, gwEnv);
      expect(r.status).toBe(0);
      const env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      const own = fs.readFileSync(path.join(tmp, "selfhost/coord.pub"), "utf8").trim();
      expect(env).toContain(`DN_COORD_PUBKEYS=${"1".repeat(64)},${own}`);
      expect(env).toMatch(/^GATEWAY_DATABASE_URL=postgresql:\/\/dominusnode:a{48}@10\.66\.0\.1:5432\/dominusnode$/m);
      expect(r.stdout).not.toContain(pw);
      const caddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
      expect(caddy).toContain("relay.example.org:8443 {");
      expect(caddy).not.toContain("api:3000");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  const bad: Array<[string, Record<string, string>, RegExp]> = [
    ["gateway with cloudflare", { ...gwEnv, TLS_MODE: "cloudflare" }, /ROLE=gateway cannot use/],
    ["relay host through the tunnel", { ...coordEnv, RELAY_HOST: "api.example.org" }, /RELAY_HOST must not be a tunnel hostname/],
    ["newline in relay host", { ...coordEnv, RELAY_HOST: "relay.example.org\nX=1" }, /invalid RELAY_HOST/],
    ["bad proxy host", { ...coordEnv, PROXY_HOST: "proxy_example" }, /invalid PROXY_HOST/],
    ["public DB address", { ...gwEnv, GATEWAY_DATABASE_URL: `postgresql://dominusnode:${pw}@203.0.113.5:5432/dominusnode` }, /private \(WireGuard\)/],
    ["weak DB password", { ...gwEnv, GATEWAY_DATABASE_URL: "postgresql://dominusnode:short@10.66.0.1:5432/dominusnode" }, /GATEWAY_DATABASE_URL must be/],
    ["public DB_WG_BIND", { ...coordEnv, DB_WG_BIND: "0.0.0.0" }, /DB_WG_BIND must be/],
    ["bad role", { ...coordEnv, ROLE: "both" }, /ROLE must be/],
  ];
  for (const [name, env, msg] of bad) {
    it.runIf(has("openssl", ["version"]))(`rejects ${name}`, () => {
      const tmp = setup();
      try {
        const r = run(tmp, env);
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(msg);
        expect(fs.existsSync(path.join(tmp, ".env"))).toBe(false);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }

  it.runIf(has("openssl", ["version"]))("rejects a group-readable token file", () => {
    const tmp = setup();
    try {
      fs.chmodSync(path.join(tmp, "selfhost/cloudflared.token"), 0o644);
      const r = run(tmp, coordEnv);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/mode 0600/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
