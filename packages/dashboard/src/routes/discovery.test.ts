import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";

const m = vi.hoisted(() => ({ listPricing: vi.fn(), listTiers: vi.fn(), getSplit: vi.fn() }));
vi.mock("@dominusnode/shared", async (orig) => {
  const actual = await orig<typeof import("@dominusnode/shared")>();
  return { ...actual, policyRepo: { ...actual.policyRepo, listPricing: m.listPricing, listTiers: m.listTiers, getSplit: m.getSplit } };
});

import router from "./discovery.js";
import { call } from "./v1/test-helpers.js";

function app() {
  const a = express();
  a.use(router);
  return a;
}

/** Legacy v1 terms that must never appear in the agent discovery documents. */
const LEGACY = [
  /email_password/i, /\/api\/auth\/register/, /\/api\/auth\/login/, /password/i, /dc-country/, /residential-country/,
  /pool_type/, /\{pool_type\}/, /500 ?MB/i, /free_dc/, /swarm_/, /volume_1tb/, /"5\.00"|5\.00\b/, /3\.00\b/,
  /stripe/i, /paypal/i, /\bplans?\b/i, /slots/i, /bug_bounty/,
];

beforeEach(() => {
  m.listPricing.mockReset(); m.listTiers.mockReset(); m.getSplit.mockReset();
  m.listPricing.mockResolvedValue([
    { ipClass: "dc", pricePerGbMusd: 200000n, updatedAt: new Date() },
    { ipClass: "residential", pricePerGbMusd: 730000n, updatedAt: new Date() },
  ]);
  m.listTiers.mockResolvedValue([{ id: 1, name: "probation", rank: 0, nodeShareBps: 2500, holdDays: 14 }, { id: 6, name: "partner", rank: 5, nodeShareBps: 5000, holdDays: 3, buyerDiscountBps: 2500 }]);
  m.getSplit.mockResolvedValue({ id: 1, nodeShareBps: 2500, maturationHours: 168, effectiveFrom: new Date() });
});

describe("agent discovery documents", () => {
  it("describes the network honestly and leads with the TLS proxy when configured", async () => {
    const { buildLlmsTxt, buildAgentToolDocument, discoveryEnv } = await import("./discovery.js");
    const pricing = { prices: [{ ipClass: "dc", pricePerGbMusd: 200000n }], tiers: [], maturationHours: 168 };
    const env = discoveryEnv({ PROXY_TLS_PORT: "8443" } as NodeJS.ProcessEnv);
    const txt = buildLlmsTxt(env, pricing);
    expect(txt).not.toMatch(/decentralized/i);
    expect(txt).toContain("operator-run gateway (federation planned)");
    expect(txt).toMatch(/USDC withdrawals are built but disabled/);
    const doc = buildAgentToolDocument(env, pricing) as { proxy: Record<string, string>; description: string };
    expect(doc.description).not.toMatch(/decentralized/i);
    expect(doc.proxy["https"]).toMatch(/^https:\/\/\{username\}:\{api_key\}@.+:8443$/);
    expect(doc.proxy["plaintext_warning"]).toMatch(/in clear/);
    const noTls = buildAgentToolDocument(discoveryEnv({} as NodeJS.ProcessEnv), pricing) as { proxy: Record<string, string> };
    expect(noTls.proxy["https"]).toBeUndefined();
    // x402/MPP payers are pointed at the TLS port when one is published.
    expect(txt).toMatch(/x402 or MPP at the gateway \(https:\/\/[^)]+:8443, TLS\)/);
    expect(txt).toContain("class-residential|mobile|dc|masked");
  });

  it("agent-tool.json has no legacy terms and pricing matches network_pricing", async () => {
    const r = await call(app(), "GET", "/.well-known/agent-tool.json");
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    for (const re of LEGACY) expect(text, String(re)).not.toMatch(re);
    const pricing = r.body["pricing"] as { per_gb: Array<Record<string, string>> };
    expect(pricing.per_gb).toEqual([
      { ip_class: "dc", price_per_gb_musd: "200000", price_per_gb_usd: "0.200000" },
      { ip_class: "residential", price_per_gb_musd: "730000", price_per_gb_usd: "0.730000" },
    ]);
    const proxy = r.body["proxy"] as { username: { flags: Record<string, string> } };
    expect(Object.keys(proxy.username.flags)).toEqual(["country-XX", "class-residential|mobile|dc|masked", "session-<id>", "allowhttp-1"]);
    // Package identifiers match the real manifests.
    const fs = await import("node:fs");
    const root = (await import("node:path")).join(__dirname, "../../../../");
    const goMod = fs.readFileSync(root + "sdks/go/go.mod", "utf8").split("\n")[0].replace(/^module\s+/, "").trim();
    const pom = fs.readFileSync(root + "sdks/java/pom.xml", "utf8");
    const gid = pom.match(/<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/)!;
    const sdks = (r.body["integrations"] as { sdks: Record<string, string> }).sdks;
    expect(sdks["go"]).toBe(goMod);
    expect(sdks["java"]).toBe(`${gid[1]}:${gid[2]}`);
    expect((r.body["errors"] as { codes: string[] }).codes).toContain("TLS_REQUIRED");
    expect(text).toContain("/v1/policy");
    expect(text).toContain("/v1/abuse-reports");
    expect((r.body["announcements"] as { url: string }).url).toMatch(/\/v1\/announcements$/);
    expect(text).toContain("wallet_signature");
    expect(text).toContain("CONTRIBUTION_REQUIRED");
    expect(text).toContain("@dominusnode/mcp-server");
    expect((r.body["earn"] as { node_share: unknown[] }).node_share).toHaveLength(2);
    expect(text).toContain("buy cheaper");
    expect((r.body["earn"] as { buyer_discount: { by_tier: unknown[] } }).buyer_discount.by_tier).toContainEqual({ tier: "partner", rank: 5, buyer_discount_bps: 2500 });
  });

  it("llms.txt has no legacy terms and quotes live prices", async () => {
    const a = app();
    const server = a.listen(0);
    await new Promise<void>((res) => server.once("listening", () => res()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/llms.txt`);
    const text = await res.text();
    server.close();
    expect(res.status).toBe(200);
    for (const re of LEGACY) expect(text, String(re)).not.toMatch(re);
    expect(text).toContain("residential: $0.730000/GB");
    expect(text).toContain("dc: $0.200000/GB");
    expect(text).toMatch(/Announcements .*\/v1\/announcements/);
  });

  it("fails closed with 503 when pricing is unavailable", async () => {
    m.listPricing.mockRejectedValue(new Error("db down"));
    const r = await call(app(), "GET", "/.well-known/agent-tool.json");
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain("db down");
  });
});

describe("production compose advertises the TLS proxy", () => {
  it("the api service sets PROXY_PUBLIC_TLS_PORT so discovery lists https first", async () => {
    const fs = await import("node:fs");
    const { buildAgentToolDocument, discoveryEnv } = await import("./discovery.js");
    const yml = fs.readFileSync((await import("node:path")).join(__dirname, "../../../../docker-compose.prod.yml"), "utf8");
    const api = yml.split(/\n {2}api:\n/)[1]!.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0]!;
    expect(api).toMatch(/PROXY_PUBLIC_TLS_PORT: "\$\{PROXY_TLS_HOST_PORT:-8443\}"/);
    const env = discoveryEnv({ PROXY_PUBLIC_TLS_PORT: "8443" } as NodeJS.ProcessEnv);
    const doc = buildAgentToolDocument(env, { prices: [], tiers: [], maturationHours: 0 } as never) as { proxy: Record<string, string> };
    expect(Object.keys(doc.proxy)[0]).toBe("https");
    expect(doc.proxy["example"]).toMatch(/^curl -x https:\/\/.+:8443 /);
  });
});
