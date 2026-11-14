import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Containers get env only from the compose `environment:` maps (.env is in
 * .dockerignore). Every payment-rail variable must reach the service whose
 * process reads it, or a rail is advertised but cannot be paid.
 */
const root = path.resolve(__dirname, "..", "..", "..");
const RAIL_RE = /^(X402|MPP|CDP|PAYAI|PAYOUTS?|PAYER|NOWPAYMENTS|TEMPO|STARTER_CREDIT|OPS_ALERT|MAX_REGISTERED|NETWORK_PAYMENT)(_|$)/;
const READ_RE = /\b(?:process\.env|env)(?:\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]|\.([A-Z][A-Z0-9_]+))/g;
// Read through envInt(process.env, "NAME", ...) rather than env["NAME"].
const ENV_INT_RE = /envInt\(\s*process\.env\s*,\s*"([A-Z][A-Z0-9_]+)"/g;

function reads(pkg: string): Set<string> {
  const out = new Set<string>();
  const walk = (d: string): void => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) { if (n !== "node_modules" && n !== "dist") walk(p); continue; }
      if (!/\.ts$/.test(n) || /\.test\.ts$|\.d\.ts$/.test(n)) continue;
      const t = fs.readFileSync(p, "utf8");
      for (const m of t.matchAll(READ_RE)) { const v = m[1] ?? m[2]; if (v && RAIL_RE.test(v)) out.add(v); }
      for (const m of t.matchAll(ENV_INT_RE)) if (RAIL_RE.test(m[1])) out.add(m[1]);
    }
  };
  walk(path.join(root, "packages", pkg, "src"));
  return out;
}

// Billing variables by the process that uses them (billing is a library of both).
const BILLING_GATEWAY = /^(X402|CDP|PAYAI|MPP)_/;
const BILLING_API = /^(X402|CDP|PAYAI|MPP|NOWPAYMENTS|TEMPO)_/;

function serviceEnv(file: string, service: string): Record<string, unknown> {
  const yaml = createRequire(__filename)("js-yaml") as { load(s: string): unknown };
  const doc = yaml.load(fs.readFileSync(path.join(root, file), "utf8")) as { services: Record<string, { environment?: Record<string, unknown> }> };
  const env = doc.services[service]?.environment;
  if (!env || Array.isArray(env)) throw new Error(`${file}: ${service} has no environment map`);
  return env;
}

describe("compose files forward every payment-rail variable to its reader", () => {
  const gateway = reads("proxy-gateway");
  const api = reads("dashboard");
  const billing = reads("billing");
  const shared = reads("shared");
  for (const v of billing) {
    if (BILLING_GATEWAY.test(v)) gateway.add(v);
    if (BILLING_API.test(v)) api.add(v);
  }
  for (const v of shared) { gateway.add(v); api.add(v); } // PAYOUTS_ENABLED, STARTER_CREDIT_*

  it("finds the rail variables (scanner sanity)", () => {
    expect(gateway).toContain("X402_RELAY_ENABLED");
    expect(gateway).toContain("MPP_PAY_TO");
    expect(gateway).toContain("PAYOUT_SIGNER_KEY_FILE");
    expect(api).toContain("NOWPAYMENTS_API_KEY");
    expect(api).toContain("TEMPO_PAY_TO");
    expect(api).toContain("OPS_ALERT_WEBHOOKS");
  });

  const cases: Array<[string, string, Set<string>]> = [
    ["docker-compose.selfhost.yml", "gateway", gateway],
    ["docker-compose.selfhost.yml", "api", api],
    ["docker-compose.prod.yml", "proxy", gateway],
    ["docker-compose.prod.yml", "api", api],
  ];
  for (const [file, service, want] of cases) {
    it(`${file} ${service}`, () => {
      const env = serviceEnv(file, service);
      const missing = [...want].filter((v) => !(v in env)).sort();
      expect(missing).toEqual([]);
    });
  }

  it("lifts the hidden 2500 signup cap by default", () => {
    for (const f of ["docker-compose.selfhost.yml", "docker-compose.prod.yml"]) {
      expect(String(serviceEnv(f, "api")["MAX_REGISTERED_USERS"])).toMatch(/:-0\}$/);
    }
  });
});
