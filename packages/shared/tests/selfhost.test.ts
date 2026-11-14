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
      expect(caddy).toContain("node.example.org:9443, relay.example.net:9443 {");
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

  it("prod compose enables canary probes and keeps loopback plaintext out of coordinator.json", () => {
    const text = fs.readFileSync(path.join(ROOT, "docker-compose.prod.yml"), "utf8");
    const proxy = text.slice(text.indexOf("\n  proxy:"));
    expect(proxy).toMatch(/PROBE_URL: \$\{PROBE_URL:-https:\/\/\$\{DOMINUSNODE_DOMAIN:-[^}]+\}\/v1\/probe\/echo\}/);
    expect(proxy).toMatch(/PROBES_DISABLED: \$\{PROBES_DISABLED:-\}/);
    expect(text).toMatch(/PROXY_PUBLISH_PLAINTEXT: \$\{PROXY_PUBLISH_PLAINTEXT:-false\}/);
    expect(proxy).toMatch(/PROXY_TLS_PORT: "8443"/);
    expect(proxy).toMatch(/TUNNEL_PORT: "9443"/);
  });

  it("self-host gateway passes PROBE_URL through", () => {
    const text = fs.readFileSync(path.join(ROOT, "docker-compose.selfhost.yml"), "utf8");
    const gateway = text.slice(text.indexOf("\n  gateway:"), text.indexOf("\n  caddy:"));
    expect(gateway).toMatch(/PROBE_URL: \$\{PROBE_URL:-\}/);
    expect(gateway).toMatch(/TUNNEL_PORT: "9443"/);
  });

  it("node tunnel goes through Caddy with PROXY v2, not a published gateway port", () => {
    const text = fs.readFileSync(path.join(ROOT, "docker-compose.selfhost.yml"), "utf8");
    const gateway = text.slice(text.indexOf("\n  gateway:"), text.indexOf("\n  caddy:"));
    const caddy = text.slice(text.indexOf("\n  caddy:"), text.indexOf("\n  node:"));
    expect(gateway).not.toMatch(/-\s*"[^"]*:9443"/);
    expect(gateway).toMatch(/TUNNEL_TRUSTED_PROXY_IPS:\s*172\.29\.53\.2/);
    expect(caddy).toMatch(/:9443"/);
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
    // No in-stack node: a same-box node is refused as a private peer.
    expect(s.node).toBeUndefined();
    expect(s["node-keys"]).toBeUndefined();
    for (const [name, file] of [["keys", "coord-key.pem"], ["keys", "api-key-pepper"]] as const) {
      const svc = s[name];
      expect(svc.user).toBe("0:0");
      expect(svc.network_mode).toBe("none");
      const cmd = svc.command!.join("\n");
      expect(cmd).toContain(`install -o 1001 -g 1001 -m 0400 /src/${file}`);
      expect(cmd).toContain("chmod 0500 /dst");
    }
    expect(Object.keys(doc.volumes)).toEqual(expect.arrayContaining(["gateway_secrets"]));
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
  const PLAIN = path.join(ROOT, "docker-compose.selfhost.plain.yml");
  const TOKEN = "eyJhIjoiU0VDUkVUVE9LRU5WQUxVRSJ9";
  const DNS_TOKEN = "cfdnsSECRETtokenVALUE0123456789abcdefXYZ";
  // Every ROLE x TLS_MODE x ACME_CHALLENGE combination install.sh accepts.
  const matrix: Array<[string, string, string, string[]]> = [];
  for (const role of ["all", "coordinator", "gateway"]) {
    for (const tls of ["auto", "internal", "off", "cloudflare"]) {
      for (const acme of ["http", "dns-cloudflare"]) {
        if (role === "gateway" && tls === "cloudflare") continue;
        if (acme === "dns-cloudflare" && (tls === "internal" || tls === "off" || (role === "coordinator" && tls === "cloudflare"))) continue;
        if (acme === "http" && tls === "cloudflare" && role !== "coordinator") continue;
        const p = role === "all" ? ["coordinator", "gateway", "caddy"] : role === "coordinator" ? ["coordinator", ...(tls === "cloudflare" ? [] : ["caddy"])] : ["gateway", "caddy"];
        if (tls === "cloudflare") p.push("cloudflare");
        if (role !== "coordinator" && tls !== "off") p.push("proxytls");
        if (acme === "dns-cloudflare") p.push("dnscf");
        matrix.push([role, tls, acme, p]);
      }
    }
  }

  type Cfg = { services: Record<string, { ports?: Array<{ target: number; published: string }>; environment?: Record<string, string>; depends_on?: Record<string, { condition: string }> }> };
  const config = (profiles: string[], files = [MAIN], extra: Record<string, string> = {}): Cfg => {
    const args = files.flatMap((f) => ["-f", f]).concat(profiles.flatMap((p) => ["--profile", p]), ["config", "--format", "json"]);
    const r = spawnSync("docker", ["compose", ...args], { env: { ...composeEnv, ...extra }, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    return JSON.parse(r.stdout) as Cfg;
  };

  // The env install.sh writes for TLS_MODE=off (empty TLS keys, plaintext allowed).
  const offEnv = {
    GATEWAY_PROXY_TLS_PORT: "", GATEWAY_SOCKS5_TLS_PORT: "", GATEWAY_PROXY_TLS_CERT_FILE: "", GATEWAY_PROXY_TLS_KEY_FILE: "",
    PROXY_PUBLIC_TLS_PORT: "", PROXY_PUBLIC_SOCKS5_TLS_PORT: "", PROXY_REQUIRE_TLS: "false", PLAINTEXT_PROXY_PUBLISHED: "1",
  };
  for (const [role, tls, acme, profiles] of matrix) {
    it.runIf(dockerCompose)(`compose parses for ROLE=${role} TLS_MODE=${tls} ACME_CHALLENGE=${acme}`, () => {
      const files = role !== "coordinator" && tls === "off" ? [MAIN, PLAIN] : [MAIN];
      const cfg = config(profiles, files, tls === "off" ? offEnv : {});
      const names = Object.keys(cfg.services);
      expect(names.includes("gateway")).toBe(role !== "coordinator");
      expect(names.includes("api")).toBe(role !== "gateway");
      expect(names.includes("cloudflared")).toBe(tls === "cloudflare");
      expect(cfg.services.api?.ports ?? []).toEqual([]);
      if (tls === "cloudflare") {
        expect(cfg.services.cloudflared.ports ?? []).toEqual([]);
        if (role === "coordinator") expect(names).not.toContain("caddy");
      }
      expect(names.includes("proxy-certs")).toBe(role !== "coordinator" && tls !== "off");
      expect(names.includes("caddy-dns-keys")).toBe(acme === "dns-cloudflare");
      if (cfg.services.caddy) {
        expect(JSON.stringify(cfg.services.caddy)).toContain("dominusnode-caddy:selfhost");
        if (acme === "dns-cloudflare") expect(cfg.services.caddy.depends_on?.["caddy-dns-keys"]?.condition).toBe("service_completed_successfully");
        expect(JSON.stringify(cfg.services.caddy)).not.toContain(DNS_TOKEN);
      }
      const gw = cfg.services.gateway;
      if (gw) {
        const published = (gw.ports ?? []).map((p) => p.target).sort((a, b) => a - b);
        const env = gw.environment ?? {};
        if (tls === "off") {
          expect(published).toEqual([1080, 1443, 8080, 8443]);
          expect(env.PROXY_REQUIRE_TLS).toBe("false");
          expect(env.PROXY_TLS_PORT ?? "").toBe("");
          expect(env.PROXY_TLS_CERT_FILE ?? "").toBe("");
        } else {
          expect(published).toEqual([1443, 8443]);
          expect(env.PROXY_REQUIRE_TLS).toBe("true");
          expect(env.PROXY_TLS_PORT).toBe("8443");
          expect(env.SOCKS5_TLS_PORT).toBe("1443");
          expect(env.PROXY_TLS_CERT_FILE).toBe("/run/dominusnode-tls/proxy.crt");
          expect(gw.depends_on?.["proxy-certs"]?.condition).toBe("service_healthy");
        }
      }
      // depends_on graph must be acyclic (proxy-certs -> caddy cert -> caddy start).
      // proxy-certs needs a running caddy at runtime, so model that edge too.
      const deps = (n: string): string[] => {
        const d = Object.keys(cfg.services[n]?.depends_on ?? {}).filter((x) => x in cfg.services);
        if (n === "proxy-certs" && "caddy" in cfg.services) d.push("caddy");
        return d;
      };
      const state: Record<string, number> = {};
      const visit = (n: string, path: string[]): void => {
        if (state[n] === 2) return;
        if (state[n] === 1) throw new Error(`depends_on cycle: ${[...path, n].join(" -> ")}`);
        state[n] = 1;
        for (const d of deps(n)) visit(d, [...path, n]);
        state[n] = 2;
      };
      for (const n of names) visit(n, []);
      if (cfg.services.caddy) expect(Object.keys(cfg.services.caddy.depends_on ?? {})).not.toContain("gateway");
      const api = cfg.services.api;
      if (api) expect(api.environment?.PROXY_PUBLIC_TLS_PORT ?? "").toBe(tls === "off" ? "" : "8443");
      // coordinator.json lists 8080/1080 only when they are published.
      if (api) expect(api.environment?.PROXY_PUBLISH_PLAINTEXT).toBe(tls === "off" ? "1" : "0");
    });
  }

  it.runIf(dockerCompose)("wg-db override publishes Postgres only on the WireGuard address", () => {
    const cfg = config(["coordinator"], [MAIN, WGDB], { DB_WG_BIND: "10.66.0.1" });
    expect(JSON.stringify(cfg.services.postgres.ports)).toContain('"host_ip":"10.66.0.1"');
  });

  it("proxy-certs copies Caddy's cert read-only, never shares Caddy's volume with the gateway", () => {
    const yaml = createRequire(__filename)("js-yaml") as { load(s: string): unknown };
    type Svc = { volumes?: string[]; command?: string[]; network_mode?: string; cap_drop?: string[] };
    const s = (yaml.load(fs.readFileSync(MAIN, "utf8")) as { services: Record<string, Svc> }).services;
    expect(s["proxy-certs"].volumes).toEqual(["caddy_data:/caddy:ro", "proxy_tls:/dst"]);
    expect(s["proxy-certs"].network_mode).toBe("none");
    expect(s["proxy-certs"].cap_drop).toEqual(["ALL"]);
    expect(s["proxy-certs"].command!.join("\n")).toContain("install -o 1001 -g 1001 -m 0400");
    expect(s.gateway.volumes).toContain("proxy_tls:/run/dominusnode-tls:ro");
    expect(s.gateway.volumes!.join(" ")).not.toContain("caddy_data");
  });

  for (const [name, env, wantBlock, wantPlain] of [
    ["gateway auto", { ROLE: "gateway", TLS_MODE: "auto", DOMINUSNODE_HOSTNAMES: "example.org", GATEWAY_DATABASE_URL: `postgresql://dominusnode_gateway:${"a".repeat(48)}@10.66.0.1:5432/dominusnode`, COORD_PUBKEY: "1".repeat(64), API_KEY_PEPPER: "a1".repeat(32) }, true, false],
    ["gateway internal", { ROLE: "gateway", TLS_MODE: "internal", DOMINUSNODE_HOSTNAMES: "example.org", GATEWAY_DATABASE_URL: `postgresql://dominusnode_gateway:${"a".repeat(48)}@10.66.0.1:5432/dominusnode`, COORD_PUBKEY: "1".repeat(64), API_KEY_PEPPER: "a1".repeat(32) }, true, false],
    ["all + proxy host among site hosts", { ROLE: "all", TLS_MODE: "auto", DOMINUSNODE_HOSTNAMES: "example.org proxy.example.org" }, false, false],
    ["all + cloudflare", { ROLE: "all", TLS_MODE: "cloudflare", DOMINUSNODE_HOSTNAMES: "example.org", CLOUDFLARE_DNS_TOKEN_FILE: "./selfhost/cloudflare-dns.token" }, true, false],
    ["all + off", { ROLE: "all", TLS_MODE: "off", DOMINUSNODE_HOSTNAMES: "example.org" }, false, true],
  ] as Array<[string, Record<string, string>, boolean, boolean]>) {
    it.runIf(has("openssl", ["version"]))(`proxy TLS dry run: ${name}`, () => {
      const tmp = setup();
      try {
        for (let i = 0; i < 2; i++) expect(run(tmp, env).status).toBe(0);
        const caddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
        expect(caddy.includes("\nproxy.example.org {")).toBe(wantBlock);
        if (env.TLS_MODE === "internal") expect(caddy).toMatch(/proxy\.example\.org \{\n  tls internal/);
        const e = fs.readFileSync(path.join(tmp, ".env"), "utf8");
        expect(e).toMatch(new RegExp(`^PROXY_REQUIRE_TLS=${wantPlain ? "false" : "true"}$`, "m"));
        expect(e).toMatch(new RegExp(`^PUBLISH_PLAINTEXT_PROXY=0$`, "m"));
        expect(e).toMatch(new RegExp(`^PLAINTEXT_PROXY_PUBLISHED=${wantPlain ? "1" : "0"}$`, "m"));
        expect(e.match(/^PROXY_REQUIRE_TLS=/gm)).toHaveLength(1);
        if (wantPlain) expect(e).toMatch(/^GATEWAY_PROXY_TLS_PORT=$/m);
        else expect(e).not.toMatch(/^GATEWAY_PROXY_TLS_PORT=/m);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, 30_000);
  }

  it.runIf(has("openssl", ["version"]))("switching TLS_MODE off -> auto re-enables the TLS proxy", () => {
    const tmp = setup();
    try {
      const base = { ROLE: "all", DOMINUSNODE_HOSTNAMES: "example.org" };
      expect(run(tmp, { ...base, TLS_MODE: "off" }).status).toBe(0);
      expect(run(tmp, { ...base, TLS_MODE: "auto" }).status).toBe(0);
      const e = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(e).toMatch(/^PROXY_REQUIRE_TLS=true$/m);
      for (const k of ["GATEWAY_PROXY_TLS_PORT", "PROXY_PUBLIC_TLS_PORT", "GATEWAY_PROXY_TLS_CERT_FILE"]) expect(e).not.toMatch(new RegExp(`^${k}=`, "m"));
      expect(run(tmp, { ...base, TLS_MODE: "auto", PUBLISH_PLAINTEXT_PROXY: "yes" }).stderr).toMatch(/PUBLISH_PLAINTEXT_PROXY must be 0 or 1/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

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
    fs.writeFileSync(path.join(tmp, "selfhost/cloudflare-dns.token"), DNS_TOKEN + "\n", { mode: 0o600 });
    return tmp;
  };
  const run = (tmp: string, env: Record<string, string>) =>
    spawnSync("bash", [path.join(tmp, "scripts/selfhost/install.sh"), "--yes", "--no-start"], {
      env: { ...process.env, OPERATOR_CONTACT: "ops@example.org", SKIP_ASN_DB: "1", ALLOW_NON_WG_DB_BIND: "1", RELAY_HOST: "relay.example.org", PROXY_HOST: "proxy.example.org", ...env },
      encoding: "utf8",
    });
  const pw = "a".repeat(48);
  const coordEnv = { ROLE: "coordinator", TLS_MODE: "cloudflare", DOMINUSNODE_HOSTNAMES: "example.org www.example.org api.example.org", DB_WG_BIND: "10.66.0.1" };
  const gwEnv = { ROLE: "gateway", TLS_MODE: "auto", DOMINUSNODE_HOSTNAMES: "example.org", GATEWAY_DATABASE_URL: `postgresql://dominusnode_gateway:${pw}@10.66.0.1:5432/dominusnode`, COORD_PUBKEY: "1".repeat(64), API_KEY_PEPPER: "a1".repeat(32) };

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

  it.runIf(has("openssl", ["version"]))("gateway takes the coordinator's JWT secret so dn_proxy_ tokens verify", () => {
    const tmp = setup();
    try {
      const jwt = "b2".repeat(48);
      const r = run(tmp, { ...gwEnv, COORD_JWT_SECRET: jwt });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(path.join(tmp, ".env"), "utf8")).toMatch(new RegExp(`^JWT_SECRET=${jwt}$`, "m"));
      expect(r.stdout + r.stderr).not.toContain(jwt);
      expect(r.stdout).toMatch(/JWT secret check value[^:]*: [0-9a-f]{16}/);
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
      expect(env).toMatch(/^GATEWAY_DATABASE_URL=postgresql:\/\/dominusnode_gateway:a{48}@10\.66\.0\.1:5432\/dominusnode$/m);
      expect(r.stdout).not.toContain(pw);
      const caddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
      expect(caddy).toContain("relay.example.org:9443 {");
      expect(caddy).not.toContain("api:3000");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(has("openssl", ["version"]))("role change clears the other roles' keys", () => {
    const tmp = setup();
    try {
      expect(run(tmp, gwEnv).status).toBe(0);
      let env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env).toMatch(/^GATEWAY_DATABASE_URL=postgresql/m);
      expect(run(tmp, { ...coordEnv, GATEWAY_PUBKEY: "2".repeat(64) }).status).toBe(0);
      env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env).toMatch(/^GATEWAY_DATABASE_URL=$/m);
      expect(env).toMatch(/^COORD_PUBKEY=$/m);
      expect(env).toMatch(new RegExp(`^COORD_ADDITIONAL_PUBKEYS=${"2".repeat(64)}$`, "m"));
      expect(run(tmp, { ...coordEnv, ROLE: "all", TLS_MODE: "auto" }).status).toBe(0);
      env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      for (const k of ["GATEWAY_DATABASE_URL", "COORD_PUBKEY", "DB_WG_BIND", "GATEWAY_PUBKEY", "COORD_ADDITIONAL_PUBKEYS"]) {
        expect(env).toMatch(new RegExp(`^${k}=$`, "m"));
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(has("openssl", ["version"]))("rejects a DB_WG_BIND not on a WireGuard interface", () => {
    const tmp = setup();
    try {
      const r = run(tmp, { ...coordEnv, DB_WG_BIND: "192.168.1.10", ALLOW_NON_WG_DB_BIND: "0" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/WireGuard interface|ip tool/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  const bad: Array<[string, Record<string, string>, RegExp]> = [
    ["gateway with cloudflare", { ...gwEnv, TLS_MODE: "cloudflare" }, /ROLE=gateway cannot use/],
    ["all + cloudflare without a DNS token", { ROLE: "all", TLS_MODE: "cloudflare", DOMINUSNODE_HOSTNAMES: "example.org" }, /needs CLOUDFLARE_DNS_TOKEN_FILE.*Zone:DNS:Edit and Zone:Zone:Read/],
    ["all + cloudflare forced to http", { ROLE: "all", TLS_MODE: "cloudflare", DOMINUSNODE_HOSTNAMES: "example.org", ACME_CHALLENGE: "http" }, /needs ACME_CHALLENGE=dns-cloudflare.*Zone:DNS:Edit/],
    ["dns-cloudflare with internal", { ...gwEnv, TLS_MODE: "internal", ACME_CHALLENGE: "dns-cloudflare", CLOUDFLARE_DNS_TOKEN_FILE: "./selfhost/cloudflare-dns.token" }, /needs TLS_MODE auto or cloudflare/],
    ["bad ACME_CHALLENGE", { ...gwEnv, ACME_CHALLENGE: "dns" }, /ACME_CHALLENGE must be/],
    ["DNS token file = tunnel token file", { ROLE: "all", TLS_MODE: "cloudflare", DOMINUSNODE_HOSTNAMES: "example.org", CLOUDFLARE_DNS_TOKEN_FILE: "./selfhost/cloudflared.token" }, /must differ/],
    ["DNS token path with spaces", { ...gwEnv, ACME_CHALLENGE: "dns-cloudflare", CLOUDFLARE_DNS_TOKEN_FILE: "./self host/t" }, /invalid CLOUDFLARE_DNS_TOKEN_FILE path/],
    ["relay host through the tunnel", { ...coordEnv, RELAY_HOST: "api.example.org" }, /RELAY_HOST must not be a tunnel hostname/],
    ["newline in relay host", { ...coordEnv, RELAY_HOST: "relay.example.org\nX=1" }, /invalid RELAY_HOST/],
    ["bad proxy host", { ...coordEnv, PROXY_HOST: "proxy_example" }, /invalid PROXY_HOST/],
    ["public DB address", { ...gwEnv, GATEWAY_DATABASE_URL: `postgresql://dominusnode_gateway:${pw}@203.0.113.5:5432/dominusnode` }, /private \(WireGuard\)/],
    ["superuser DB role", { ...gwEnv, GATEWAY_DATABASE_URL: `postgresql://dominusnode:${pw}@10.66.0.1:5432/dominusnode` }, /least-privilege|superuser/],
    ["gateway without the pepper", { ...gwEnv, API_KEY_PEPPER: "" }, /API key pepper/],
    ["gateway with a malformed coordinator JWT secret", { ...gwEnv, COORD_JWT_SECRET: "nothex" }, /COORD_JWT_SECRET/],
    ["weak DB password", { ...gwEnv, GATEWAY_DATABASE_URL: "postgresql://dominusnode_gateway:short@10.66.0.1:5432/dominusnode" }, /GATEWAY_DATABASE_URL must be/],
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

  const dnsEnv = { ...gwEnv, ACME_CHALLENGE: "dns-cloudflare", CLOUDFLARE_DNS_TOKEN_FILE: "./selfhost/cloudflare-dns.token" };
  const tree = (tmp: string) => fs.readFileSync(path.join(tmp, ".env"), "utf8") + fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");

  it.runIf(has("openssl", ["version"]))("dns-cloudflare Caddyfile snapshot (gateway auto): DNS-01 on relay and proxy, token by path only", () => {
    const tmp = setup();
    try {
      for (let i = 0; i < 2; i++) {
        const r = run(tmp, dnsEnv);
        expect(r.status).toBe(0);
        expect(r.stdout + r.stderr).not.toContain(DNS_TOKEN);
        expect(r.stdout).toMatch(/ACME challenge: dns-cloudflare; compose profiles: gateway caddy proxytls dnscf/);
      }
      expect(fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8")).toBe(
        [
          "# Generated by scripts/selfhost/install.sh; re-run it instead of editing.",
          "{",
          "  email ops@example.org",
          "}",
          "relay.example.org:9443 {",
          "  tls {",
          "    dns cloudflare {file./run/caddy-secrets/cloudflare-dns.token}",
          "    resolvers 1.1.1.1 1.0.0.1",
          "  }",
          "  reverse_proxy gateway:9443 {",
          "    transport http {",
          "      proxy_protocol v2",
          "    }",
          "  }",
          "}",
          "proxy.example.org {",
          "  tls {",
          "    dns cloudflare {file./run/caddy-secrets/cloudflare-dns.token}",
          "    resolvers 1.1.1.1 1.0.0.1",
          "  }",
          '  respond "DominusNode relay gateway: use the HTTPS proxy on port 8443" 404',
          "}",
          "",
        ].join("\n"),
      );
      const env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env).toMatch(/^ACME_CHALLENGE=dns-cloudflare$/m);
      expect(env).toMatch(/^CLOUDFLARE_DNS_TOKEN_FILE=\.\/selfhost\/cloudflare-dns\.token$/m);
      expect(tree(tmp)).not.toContain(DNS_TOKEN);
      expect(fs.readFileSync(MAIN, "utf8")).not.toContain(DNS_TOKEN);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(has("openssl", ["version"]))("dns-cloudflare covers every public-cert site block (all + auto, all + cloudflare)", () => {
    const tmp = setup();
    try {
      expect(run(tmp, { ROLE: "all", TLS_MODE: "auto", DOMINUSNODE_HOSTNAMES: "example.org www.example.org", ACME_CHALLENGE: "dns-cloudflare", CLOUDFLARE_DNS_TOKEN_FILE: "./selfhost/cloudflare-dns.token" }).status).toBe(0);
      let caddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
      const sites = caddy.split("\n").filter((l) => /^[a-z].* \{$/.test(l));
      expect(sites).toEqual(["example.org, www.example.org {", "example.org:9443, www.example.org:9443, relay.example.org:9443 {", "proxy.example.org {"]);
      expect(caddy.match(/dns cloudflare \{file\.\/run\/caddy-secrets\/cloudflare-dns\.token\}/g)).toHaveLength(3);
      // Default for TLS_MODE=cloudflare with a gateway: DNS-01 without being asked.
      expect(run(tmp, { ROLE: "all", TLS_MODE: "cloudflare", DOMINUSNODE_HOSTNAMES: "example.org", CLOUDFLARE_DNS_TOKEN_FILE: "./selfhost/cloudflare-dns.token" }).status).toBe(0);
      caddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
      expect(caddy).not.toContain("api:3000");
      expect(caddy.match(/dns cloudflare/g)).toHaveLength(2);
      expect(tree(tmp)).not.toContain(DNS_TOKEN);
      expect(tree(tmp)).not.toContain(TOKEN);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(has("openssl", ["version"]))("switching ACME_CHALLENGE back and forth is idempotent", () => {
    const tmp = setup();
    try {
      expect(run(tmp, dnsEnv).status).toBe(0);
      const dnsCaddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
      expect(run(tmp, { ...gwEnv, ACME_CHALLENGE: "http" }).status).toBe(0);
      let env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env).toMatch(/^ACME_CHALLENGE=http$/m);
      expect(env).not.toMatch(/^CLOUDFLARE_DNS_TOKEN_FILE=/m);
      expect(fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8")).not.toContain("dns cloudflare");
      // Stored http is kept on a plain re-run.
      expect(run(tmp, gwEnv).stdout).toMatch(/ACME challenge: http;/);
      expect(run(tmp, dnsEnv).status).toBe(0);
      expect(fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8")).toBe(dnsCaddy);
      env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env.match(/^ACME_CHALLENGE=/gm)).toHaveLength(1);
      expect(env.match(/^CLOUDFLARE_DNS_TOKEN_FILE=/gm)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(has("openssl", ["version"]))("rejects a group-readable or multi-line DNS token file", () => {
    const tmp = setup();
    try {
      const f = path.join(tmp, "selfhost/cloudflare-dns.token");
      fs.chmodSync(f, 0o640);
      expect(run(tmp, dnsEnv).stderr).toMatch(/Cloudflare DNS token file must be mode 0600/);
      fs.chmodSync(f, 0o600);
      fs.writeFileSync(f, "a\nb\n");
      expect(run(tmp, dnsEnv).stderr).toMatch(/must hold one line/);
      expect(fs.existsSync(path.join(tmp, ".env"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("Caddy image is built locally from pinned versions and base digests", () => {
    const df = fs.readFileSync(path.join(ROOT, "infra/docker/caddy.Dockerfile"), "utf8");
    const froms = [...df.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]);
    expect(froms).toHaveLength(2);
    for (const f of froms) expect(f).toMatch(/^caddy:\d+\.\d+\.\d+-(builder-)?alpine@sha256:[0-9a-f]{64}$/);
    expect(df).toMatch(/xcaddy build v\d+\.\d+\.\d+ --with github\.com\/caddy-dns\/cloudflare@v\d+\.\d+\.\d+/);
    const text = fs.readFileSync(MAIN, "utf8");
    expect(text).not.toMatch(/image: caddy:/);
    expect(text).toMatch(/\$\{CLOUDFLARE_DNS_TOKEN_FILE:-[^}]+\}:\/src\/token:ro/);
    expect(text).not.toMatch(/CF_API_TOKEN|CLOUDFLARE_API_TOKEN|env\.CLOUDFLARE/);
  });

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

describe("self-host fixes from the first live install", () => {
  type Svc = { profiles?: string[]; environment?: Record<string, string>; volumes?: string[]; depends_on?: Record<string, { condition: string }> };
  const yaml = createRequire(__filename)("js-yaml") as { load(s: string): unknown };
  const doc = yaml.load(fs.readFileSync(path.join(ROOT, "docker-compose.selfhost.yml"), "utf8")) as {
    services: Record<string, Svc>;
    networks: Record<string, { ipam?: { config?: Array<{ subnet?: string; ip_range?: string }> } }>;
  };

  it("the api gets the coordinator key so coordinator.json and policy.json are signed", () => {
    const api = doc.services["api"]!;
    expect(api.environment?.["COORD_SIGNING_KEY_FILE"]).toBe("/run/dominusnode/coord-key.pem");
    expect(api.environment?.["COORDINATOR_HOSTNAMES"]).toContain("PUBLIC_HOSTNAMES");
    expect(api.volumes).toContain("gateway_secrets:/run/dominusnode:ro");
    expect(api.depends_on?.["keys"]?.condition).toBe("service_completed_successfully");
    expect(doc.services["keys"]!.profiles).toEqual(expect.arrayContaining(["gateway", "coordinator"]));
  });

  it("dynamic frontend addresses never collide with Caddy's fixed IP", () => {
    const cfg = doc.networks["frontend"]!.ipam!.config![0]!;
    expect(cfg.subnet).toBe("172.29.53.0/24");
    expect(cfg.ip_range).toBe("172.29.53.128/25");
    const text = fs.readFileSync(path.join(ROOT, "docker-compose.selfhost.yml"), "utf8");
    expect(text).toMatch(/ipv4_address:\s*172\.29\.53\.2\b/);
  });

  it("update-asn-db.sh reads the gzip head without a SIGPIPE-prone pipeline", () => {
    const text = fs.readFileSync(path.join(ROOT, "scripts/update-asn-db.sh"), "utf8");
    expect(text).toMatch(/head -n 100 < <\(gzip -dc "\$TMP"\)/);
    expect(text).not.toMatch(/gzip -dc "\$TMP" \| head/);
  });
});

describe("DNS-01 token rotation and image pins", () => {
  it("restarts Caddy after copying the DNS token so a rotated token takes effect", () => {
    const text = fs.readFileSync(INSTALL, "utf8");
    expect(text).toMatch(/if \[ "\$ACME" = dns-cloudflare \]; then\n\s+"\$\{COMPOSE\[@\]\}" restart caddy/);
  });
  it("pins both Caddy base images by digest", () => {
    const text = fs.readFileSync(path.join(ROOT, "infra/docker/caddy.Dockerfile"), "utf8");
    expect(text).toMatch(/caddy:2\.11\.9-builder-alpine@sha256:[0-9a-f]{64}/);
    expect(text).toMatch(/caddy:2\.11\.9-alpine@sha256:[0-9a-f]{64}/);
  });
});

describe("self-host operations (admin, contacts, pepper, backups)", () => {
  const yaml = createRequire(__filename)("js-yaml") as { load(s: string): unknown };
  type Svc = { environment?: Record<string, string>; volumes?: string[]; command?: string[]; profiles?: string[]; build?: { dockerfile: string } };
  const svc = () => (yaml.load(fs.readFileSync(path.join(ROOT, "docker-compose.selfhost.yml"), "utf8")) as { services: Record<string, Svc> }).services;

  it("restore skips ACLs and the gateway role is applied in one transaction", () => {
    expect(fs.readFileSync(path.join(ROOT, "scripts/selfhost/restore.sh"), "utf8")).toMatch(/pg_restore .*--no-acl/);
    expect(fs.readFileSync(path.join(ROOT, "scripts/selfhost/install.sh"), "utf8")).toMatch(/psql -q -1 -v ON_ERROR_STOP=1 [^\n]*\n?[^\n]*/);
    const sh = fs.readFileSync(path.join(ROOT, "scripts/selfhost/install.sh"), "utf8");
    const i = sh.indexOf("gateway-role.sql\"; } |");
    expect(sh.slice(i, i + 200)).toContain("psql -q -1 ");
  });

  it("passes contacts, branding and the admin bootstrap through to the api", () => {
    const env = svc().api.environment!;
    for (const k of ["OPERATOR_CONTACT", "ABUSE_CONTACT", "OPERATOR_NAME", "SITE_NAME", "ADMIN_HUMAN_LOGIN", "ADMIN_BOOTSTRAP_EMAIL"]) {
      expect(env[k]).toMatch(new RegExp(`^\\$\\{${k}:-`));
    }
  });

  it("wires the API key pepper into the api and the gateway", () => {
    const s = svc();
    expect(s.api.environment!.API_KEY_PEPPER_FILE).toBe("/run/dominusnode/api-key-pepper");
    expect(s.gateway.environment!.API_KEY_PEPPER_FILE).toBe("/run/dominusnode/api-key-pepper");
    expect(s.keys.volumes).toContain("./selfhost/api-key-pepper:/src/api-key-pepper:ro");
  });

  it("serves the admin UI and routes API paths to the api", () => {
    const s = svc();
    expect(s.frontend.build!.dockerfile).toBe("infra/docker/frontend.Dockerfile");
    expect((s.frontend.build as { args?: Record<string, string> }).args?.NGINX_CONF).toBe("infra/nginx/selfhost.conf");
    const conf = fs.readFileSync(path.join(ROOT, "infra/nginx/selfhost.conf"), "utf8");
    expect(conf).not.toMatch(/includeSubDomains|; preload/);
    expect(conf).not.toMatch(/dominusnode\.com/);
    expect(s.frontend.profiles).toEqual(["coordinator"]);
  });

  const setup = () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-selfhost-ops-"));
    fs.mkdirSync(path.join(tmp, "scripts/selfhost"), { recursive: true });
    for (const f of ["install.sh", "backup.sh", "restore.sh"]) {
      fs.copyFileSync(path.join(ROOT, "scripts/selfhost", f), path.join(tmp, "scripts/selfhost", f));
    }
    fs.copyFileSync(path.join(ROOT, "scripts/gen-coord-key.mjs"), path.join(tmp, "scripts/gen-coord-key.mjs"));
    return tmp;
  };
  const install = (tmp: string, env: Record<string, string>) =>
    spawnSync("bash", [path.join(tmp, "scripts/selfhost/install.sh"), "--yes", "--no-start"], {
      env: { ...process.env, DOMINUSNODE_HOSTNAMES: "example.org", TLS_MODE: "auto", OPERATOR_CONTACT: "ops@example.org", SKIP_ASN_DB: "1", ...env },
      encoding: "utf8",
    });

  it.runIf(has("openssl", ["version"]))("generates the pepper once, writes admin/contacts, routes the admin UI", () => {
    const tmp = setup();
    try {
      const r1 = install(tmp, { ADMIN_BOOTSTRAP_EMAIL: "admin@example.org", ABUSE_CONTACT: "abuse@example.org" });
      expect(r1.status).toBe(0);
      const pep1 = fs.readFileSync(path.join(tmp, "selfhost/api-key-pepper"), "utf8");
      expect(pep1).toMatch(/^[0-9a-f]{64}\n$/);
      expect(fs.statSync(path.join(tmp, "selfhost/api-key-pepper")).mode & 0o077).toBe(0);
      expect(r1.stdout).not.toContain(pep1.trim());
      expect(r1.stdout).toMatch(/--trust sha256:[0-9a-f]{64}/);
      const env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env).toMatch(/^ADMIN_HUMAN_LOGIN=true$/m);
      expect(env).toMatch(/^ADMIN_BOOTSTRAP_EMAIL=admin@example\.org$/m);
      expect(env).toMatch(/^ABUSE_CONTACT=abuse@example\.org$/m);
      const caddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
      expect(caddy).toMatch(/handle @api \{\n\s+reverse_proxy api:3000/);
      expect(caddy).toMatch(/handle @admin \{\n\s+reverse_proxy frontend:8080/);
      // Only the admin UI reaches the frontend: no official public pages.
      const admin = caddy.split("\n").find((l) => l.includes("@admin path"))!;
      for (const p of ["/report-abuse", "/pricing", "/terms", "/privacy", "/aup", "/run-a-node"]) expect(admin).not.toContain(p);
      expect(caddy).toMatch(/handle \/ \{\n\s+redir \/admin 302/);
      expect(caddy).toMatch(/handle \{\n\s+respond 404/);
      // Re-run: pepper kept; an explicitly empty bootstrap email closes registration.
      expect(install(tmp, { ADMIN_BOOTSTRAP_EMAIL: "" }).status).toBe(0);
      expect(fs.readFileSync(path.join(tmp, "selfhost/api-key-pepper"), "utf8")).toBe(pep1);
      expect(fs.readFileSync(path.join(tmp, ".env"), "utf8")).toMatch(/^ADMIN_BOOTSTRAP_EMAIL=$/m);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it.runIf(has("openssl", ["version"]))("backup is encrypted, holds Postgres + keys + .env, and restores", () => {
    const tmp = setup();
    try {
      expect(install(tmp, {}).status).toBe(0);
      // Stub docker: pg_dump prints a marker, pg_restore records its stdin.
      const bin = path.join(tmp, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "docker"),
        '#!/usr/bin/env bash\ncase "$*" in *pg_dump*) printf FAKE-PG-DUMP ;; *pg_restore*) cat > "$STUB_RESTORED" ;; esac\n', { mode: 0o755 });
      const pass = path.join(tmp, "pass");
      fs.writeFileSync(path.join(pass), "correct horse battery staple\n", { mode: 0o600 });
      const env = { ...process.env, DOCKER: path.join(bin, "docker"), BACKUP_DIR: path.join(tmp, "backups"), BACKUP_PASSPHRASE_FILE: pass };
      const unenc = spawnSync("bash", [path.join(tmp, "scripts/selfhost/backup.sh")], { env: { ...env, BACKUP_PASSPHRASE_FILE: "" }, encoding: "utf8" });
      expect(unenc.status).not.toBe(0);
      expect(unenc.stderr).toMatch(/refusing to write an unencrypted backup/);
      const b = spawnSync("bash", [path.join(tmp, "scripts/selfhost/backup.sh")], { env, encoding: "utf8" });
      expect(b.stderr).toBe("");
      expect(b.status).toBe(0);
      const files = fs.readdirSync(path.join(tmp, "backups"));
      expect(files).toHaveLength(1);
      const archive = path.join(tmp, "backups", files[0]);
      const raw = fs.readFileSync(archive);
      const jwt = fs.readFileSync(path.join(tmp, ".env"), "utf8").match(/^JWT_SECRET=(.*)$/m)![1];
      expect(raw.includes(Buffer.from(jwt))).toBe(false);
      expect(raw.subarray(0, 8).toString()).toBe("Salted__");

      // Restore onto an empty checkout.
      const dst = setup();
      try {
        const restored = path.join(dst, "restored.dump");
        const r = spawnSync("bash", [path.join(dst, "scripts/selfhost/restore.sh"), archive], {
          env: { ...env, PATH: `${bin}:${process.env.PATH}`, STUB_RESTORED: restored, SKIP_ASN_DB: "1", SKIP_ASN_TIMER: "1", OPERATOR_CONTACT: "ops@example.org" }, encoding: "utf8",
        });
        expect(r.stderr).not.toMatch(/restore:/);
        for (const f of ["selfhost/coord-key.pem", "selfhost/api-key-pepper", ".env"]) {
          expect(fs.readFileSync(path.join(dst, f))).toEqual(fs.readFileSync(path.join(tmp, f)));
        }
        expect(fs.readFileSync(restored, "utf8")).toBe("FAKE-PG-DUMP");
        expect(fs.statSync(path.join(dst, ".env")).mode & 0o077).toBe(0);
        // A second restore refuses to overwrite live keys without --force.
        const again = spawnSync("bash", [path.join(dst, "scripts/selfhost/restore.sh"), "--no-start", archive], { env, encoding: "utf8" });
        expect(again.status).not.toBe(0);
        expect(again.stderr).toMatch(/--force/);
      } finally {
        fs.rmSync(dst, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(has("shellcheck", ["--version"]))("ops scripts are shellcheck-clean", () => {
    for (const f of ["backup.sh", "restore.sh", "refresh-asn.sh"]) execFileSync("shellcheck", [path.join(ROOT, "scripts/selfhost", f)]);
  });
});

describe("gateway VPS readiness", () => {
  const PREFLIGHT = path.join(ROOT, "scripts/selfhost/preflight.sh");
  const pw = "a".repeat(48);

  it.runIf(has("shellcheck", ["--version"]))("preflight.sh is shellcheck-clean", () => {
    execFileSync("shellcheck", [PREFLIGHT]);
  });

  it.runIf(has("openssl", ["version"]))("ROLE=gateway generates its own key, prints it and never needs the coordinator key", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-gw-"));
    try {
      fs.mkdirSync(path.join(tmp, "scripts/selfhost"), { recursive: true });
      fs.copyFileSync(INSTALL, path.join(tmp, "scripts/selfhost/install.sh"));
      fs.copyFileSync(path.join(ROOT, "scripts/gen-coord-key.mjs"), path.join(tmp, "scripts/gen-coord-key.mjs"));
      const home = "1".repeat(64);
      const r = spawnSync("bash", [path.join(tmp, "scripts/selfhost/install.sh"), "--yes", "--no-start"], {
        env: {
          ...process.env, ROLE: "gateway", TLS_MODE: "auto", DOMINUSNODE_HOSTNAMES: "example.org",
          RELAY_HOST: "relay.example.org", PROXY_HOST: "proxy.example.org", OPERATOR_CONTACT: "ops@example.org", SKIP_ASN_DB: "1",
          GATEWAY_DATABASE_URL: `postgresql://dominusnode_gateway:${pw}@10.66.0.1:5432/dominusnode`, COORD_PUBKEY: home, API_KEY_PEPPER: "a1".repeat(32),
        },
        encoding: "utf8",
      });
      expect(r.stderr).not.toMatch(/install: (?!WARNING|  )/);
      expect(r.status).toBe(0);
      const pub = fs.readFileSync(path.join(tmp, "selfhost/coord.pub"), "utf8").trim();
      expect(pub).toMatch(/^[0-9a-f]{64}$/);
      expect(pub).not.toBe(home);
      expect(r.stdout).toContain(`gateway public key (hex): ${pub}`);
      expect(r.stdout).toContain(`GATEWAY_PUBKEY=${pub} ./scripts/selfhost/install.sh`);
      expect(r.stdout).toContain(`DN_COORD_PUBKEYS=${home},${pub}`);
      expect(r.stdout).not.toContain(pw);
      const env = fs.readFileSync(path.join(tmp, ".env"), "utf8");
      expect(env).toMatch(/^RELAY_HOST=relay\.example\.org$/m);
      expect(env).toMatch(/^PROXY_HOST=proxy\.example\.org$/m);
      expect(env).toMatch(new RegExp(`^DN_COORD_PUBKEYS=${home},${pub}$`, "m"));
      const caddy = fs.readFileSync(path.join(tmp, "selfhost/Caddyfile"), "utf8");
      expect(caddy).toContain("relay.example.org:9443");
      expect(caddy).not.toContain("reverse_proxy api:3000");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  // Stubbed system tools so the checks run deterministically anywhere.
  type PreOpts = {
    dns: Record<string, string>; route: string; hs: number; ntp: string; ufw?: string; url?: (port: number) => string;
    dns6?: Record<string, string>; udp?: string; curl?: string; env?: Record<string, string>;
  };
  const stubs = (opts: PreOpts) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-pre-"));
    const w = (n: string, body: string) => fs.writeFileSync(path.join(dir, n), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
    w("getent", [
      ...Object.entries(opts.dns).map(([h, a]) => `[ "$1" = ahostsv4 ] && [ "$2" = ${h} ] && echo "${a} STREAM ${h}" && exit 0`),
      ...Object.entries(opts.dns6 ?? {}).map(([h, a]) => `[ "$1" = ahostsv6 ] && [ "$2" = ${h} ] && echo "${a} STREAM ${h}" && exit 0`),
    ].join("\n") + "\nexit 2");
    w("ip", `if [ "$1" = -o ] && [ "$2" = route ]; then echo "$4 dev ${opts.route} src 10.66.0.2 uid 0"; fi`);
    w("wg", `echo "peerkey= ${opts.hs}"`);
    w("timedatectl", `echo ${opts.ntp}`);
    w("ss", opts.udp ? `[ "$1" = -Hlun ] && echo "UNCONN 0 0 0.0.0.0:${opts.udp} 0.0.0.0:*"; exit 0` : "exit 0");
    // Default curl stub fails, so the Cloudflare fetch falls back and nothing touches the network.
    w("curl", opts.curl ?? "exit 7");
    w("ufw", `printf '%b\\n' ${JSON.stringify(opts.ufw ?? "Status: inactive")}`);
    return dir;
  };
  const preflight = async (opts: PreOpts) => {
    const net = await import("node:net");
    const srv = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    const port = (srv.address() as { port: number }).port;
    const bin = stubs(opts);
    try {
      const r = spawnSync("bash", [PREFLIGHT], {
        env: {
          PATH: `${bin}:${process.env.PATH}`, PUBLIC_IP: "203.0.113.10", RELAY_HOST: "relay.example.org", PROXY_HOST: "proxy.example.org",
          ROLE: "gateway", PREFLIGHT_MIN_DISK_GB: "0", ...opts.env,
          GATEWAY_DATABASE_URL: opts.url ? opts.url(port) : `postgresql://dominusnode_gateway:${pw}@127.0.0.1:${port}/dominusnode`,
        },
        encoding: "utf8",
      });
      return r;
    } finally {
      srv.close();
      fs.rmSync(bin, { recursive: true, force: true });
    }
  };
  const now = () => Math.floor(Date.now() / 1000);
  const good = { dns: { "relay.example.org": "203.0.113.10", "proxy.example.org": "203.0.113.10" }, route: "wg0", ntp: "yes" };

  it("preflight passes on a ready gateway and never prints the DB password", async () => {
    const r = await preflight({ ...good, hs: now() - 5 });
    expect(r.stdout).toContain("preflight: all checks passed");
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(pw);
  });

  it("preflight fails on Cloudflare-proxied or foreign DNS", async () => {
    const r = await preflight({ ...good, hs: now(), dns: { "relay.example.org": "104.16.1.1", "proxy.example.org": "198.51.100.7" } });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+dns\s+RELAY_HOST relay\.example\.org -> 104\.16\.1\.1 is a Cloudflare proxy/);
    expect(r.stdout).toMatch(/FAIL\s+dns\s+PROXY_HOST proxy\.example\.org -> 198\.51\.100\.7, not this host/);
  });

  it("preflight fails when the DB is not routed over WireGuard, the peer is stale or the clock unsynced", async () => {
    const r = await preflight({ ...good, route: "eth0", hs: now() - 600, ntp: "no" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+db\s+127\.0\.0\.1 is routed via eth0, not wg0/);
    expect(r.stdout).toMatch(/FAIL\s+wg\s+wg0 last handshake/);
    expect(r.stdout).toMatch(/FAIL\s+clock/);
    expect(r.stdout + r.stderr).not.toContain(pw);
  });

  it("preflight accepts postgres:// URLs and multiport ufw rules, and fails a port ufw does not allow", async () => {
    const ufw = "Status: active\n\nTo Action From\n80,443/tcp ALLOW Anywhere\n8443/tcp ALLOW Anywhere\n9443 ALLOW Anywhere";
    const r = await preflight({ ...good, hs: now(), ufw, url: (p) => `postgres://dominusnode_gateway:${pw}@127.0.0.1:${p}/dominusnode?sslmode=disable` });
    expect(r.stdout).toMatch(/ok\s+db\s+127\.0\.0\.1:\d+ reachable over wg0/);
    expect(r.stdout).not.toMatch(/ufw is active and does not allow tcp\/(80|443|8443|9443)$/m);
    expect(r.stdout).toMatch(/FAIL\s+ports\s+ufw is active and does not allow tcp\/1443/);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(pw);
  });

  it("preflight falls back to the built-in Cloudflare list when the fetch fails", async () => {
    const r = await preflight({ ...good, hs: now(), dns: { ...good.dns, "relay.example.org": "104.16.1.1" } });
    expect(r.stdout).toMatch(/ok\s+dns\s+Cloudflare ranges: built-in \(fetch from cloudflare\.com failed\)/);
    expect(r.stdout).toMatch(/FAIL\s+dns\s+RELAY_HOST relay\.example\.org -> 104\.16\.1\.1 is a Cloudflare proxy/);
  });

  it("preflight uses the Cloudflare ranges fetched at runtime and rejects a malformed list", async () => {
    const live = `case "$*" in *ips-v4*) printf '198.51.100.0/24\\n' ;; *ips-v6*) printf '2001:db8:cf::/48\\n' ;; *) exit 7 ;; esac`;
    const r = await preflight({
      ...good, hs: now(), curl: live,
      dns: { ...good.dns, "proxy.example.org": "198.51.100.9" }, dns6: { "relay.example.org": "2001:db8:cf::5" },
    });
    expect(r.stdout).toMatch(/Cloudflare ranges: cloudflare\.com/);
    expect(r.stdout).toMatch(/FAIL\s+dns\s+PROXY_HOST proxy\.example\.org -> 198\.51\.100\.9 is a Cloudflare proxy/);
    expect(r.stdout).toMatch(/FAIL\s+dns\s+RELAY_HOST relay\.example\.org -> 2001:db8:cf::5 \(AAAA\) is a Cloudflare proxy/);
    const bad = await preflight({ ...good, hs: now(), curl: `echo '<html>not a list</html>'` });
    expect(bad.stdout).toMatch(/Cloudflare ranges: built-in \(fetch from cloudflare\.com failed\)/);
  });

  it("preflight fails a Cloudflare AAAA and warns on an AAAA that is not this host", async () => {
    const r = await preflight({
      ...good, hs: now(), env: { PUBLIC_IP6: "2001:db8::10" },
      dns6: { "relay.example.org": "2606:4700::6810:1", "proxy.example.org": "2001:db8::99" },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+dns\s+RELAY_HOST relay\.example\.org -> 2606:4700::6810:1 \(AAAA\) is a Cloudflare proxy/);
    expect(r.stdout).toMatch(/warn\s+dns\s+PROXY_HOST proxy\.example\.org -> 2001:db8::99 \(AAAA\), not this host/);
    const okr = await preflight({ ...good, hs: now(), env: { PUBLIC_IP6: "2001:db8::10" }, dns6: { "relay.example.org": "2001:db8:0::10" } });
    expect(okr.stdout).toMatch(/ok\s+dns\s+RELAY_HOST relay\.example\.org -> 2001:db8:0::10 \(AAAA\)/);
    expect(okr.status).toBe(0);
  });

  it("preflight checks the UDP WireGuard listener and ufw in server mode only", async () => {
    const off = await preflight({ ...good, hs: now() });
    expect(off.stdout).not.toMatch(/udp\/51820/);
    const missing = await preflight({ ...good, hs: now(), env: { WG_SERVER: "1" }, ufw: "Status: active\n80,443,8443,1443,9443/tcp ALLOW Anywhere" });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toMatch(/FAIL\s+wg\s+udp\/51820 not listening/);
    expect(missing.stdout).toMatch(/FAIL\s+wg\s+ufw is active and does not allow udp\/51820/);
    const up = await preflight({ ...good, hs: now(), udp: "51820", env: { WG_SERVER: "1" }, ufw: "Status: active\n80,443,8443,1443,9443/tcp ALLOW Anywhere\n51820/udp ALLOW Anywhere" });
    expect(up.stdout).toMatch(/ok\s+wg\s+udp\/51820 listening/);
    expect(up.status).toBe(0);
  });

  it("preflight skips external reachability with a note, or checks each port via PREFLIGHT_REACH_URL", async () => {
    const skip = await preflight({ ...good, hs: now() });
    expect(skip.stdout).toMatch(/warn\s+reach\s+external reachability skipped/);
    const curl = `for a in "$@"; do case "$a" in https://check.example.org/*) case "$a" in *port=1443*) exit 22 ;; *) exit 0 ;; esac ;; esac; done; exit 7`;
    const r = await preflight({ ...good, hs: now(), curl, env: { PREFLIGHT_REACH_URL: "https://check.example.org/tcp?host={host}&port={port}" } });
    expect(r.stdout).toMatch(/ok\s+reach\s+tcp\/9443 reachable from outside/);
    expect(r.stdout).toMatch(/FAIL\s+reach\s+tcp\/1443 not reachable from outside/);
    expect(r.status).toBe(1);
    const bad = await preflight({ ...good, hs: now(), env: { PREFLIGHT_REACH_URL: "http://check.example.org/" } });
    expect(bad.status).toBe(2);
    // URL globbing off, and a RELAY_HOST that is not a plain hostname is never sent to the checker.
    const glob = `case " $* " in *" -g "*) exit 0 ;; esac; exit 7`;
    const g = await preflight({ ...good, hs: now(), curl: glob, env: { PREFLIGHT_REACH_URL: "https://check.example.org/tcp?h={host}&p={port}" } });
    expect(g.stdout).toMatch(/ok\s+reach\s+tcp\/443 reachable from outside/);
    const inj = await preflight({ ...good, hs: now(), curl: "exit 0", env: { RELAY_HOST: "relay.example.org&x=1", PREFLIGHT_REACH_URL: "https://check.example.org/tcp?h={host}&p={port}" } });
    expect(inj.stdout).toMatch(/FAIL\s+reach\s+RELAY_HOST is not a plain hostname/);
    expect(inj.stdout).not.toMatch(/reachable from outside/);
  });

  it("preflight rejects an oversized Cloudflare list and --help prints only the header", async () => {
    const big = `case "$*" in *ips-v*) for i in $(seq 1 6000); do echo 198.51.100.0/24; done ;; *) exit 7 ;; esac`;
    const r = await preflight({ ...good, hs: now(), curl: big });
    expect(r.stdout).toMatch(/Cloudflare ranges: built-in \(fetch from cloudflare\.com failed\)/);
    const h = spawnSync("bash", [PREFLIGHT, "--help"], { encoding: "utf8" });
    expect(h.status).toBe(0);
    expect(h.stdout).toMatch(/Exit status/);
    expect(h.stdout).not.toMatch(/set -uo|ROOT=/);
  });

  it("docs cover the gateway checklist with placeholder hosts only", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/agent-network/DEPLOYMENT.md"), "utf8");
    const sec = doc.slice(doc.indexOf("#### Gateway VPS checklist"), doc.indexOf("## 8. Launch jobs"));
    expect(sec.length).toBeGreaterThan(100);
    for (const s of ["preflight.sh", "GATEWAY_PUBKEY", "DN_COORD_PUBKEYS", "ListenPort = 51820", "PersistentKeepalive = 25", "DNS only"]) expect(sec).toContain(s);
    expect(sec).not.toMatch(/daedalusdevelopmentgroup|dominusnode\.com|@gmail\.|@protonmail\.|\b(?!10\.66\.0\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});
