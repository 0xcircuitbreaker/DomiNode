import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Wallet, verifyMessage } from "ethers";
import { buildAttestationMessage } from "@dominusnode/shared/dist/src/attestation.js";
import { registerNodeTools, solvePow } from "../../src/tools/nodes.js";
import type { McpConfig } from "../../src/config.js";
import { callTool, jsonResponse, makeHttpClient, mockFetchSequence } from "../helpers/mock.js";

const API_KEY = "dn_live_" + "k".repeat(40);
const NODE_KEY = "dn_node_" + "ab".repeat(32);
const NODE_ID = "11111111-2222-4333-8444-555555555555";
const POW_ID = "99999999-8888-4777-8666-555555555555";
const NONCE = "c".repeat(64);
const ATT_TEXT = "I operate this node lawfully and accept the DomiNode relay terms.";

let dir: string;
let wallet: Wallet;
let config: McpConfig;

function challengeFor(walletAddr: string, nodePubkey: string | null, overrides: Record<string, unknown> = {}) {
  return {
    nonce: NONCE,
    attestationText: ATT_TEXT,
    attestationVersion: 1,
    policyVersion: 3,
    message: buildAttestationMessage({ wallet: walletAddr, nonce: NONCE, attestationVersion: 1, attestationText: ATT_TEXT, nodePubkey }),
    expiresAt: "2026-11-06T01:00:00.000Z",
    powChallenge: { challengeId: POW_ID, prefix: "abcd", difficulty: 6, algorithm: "sha256" },
    ...overrides,
  };
}

/** fetch mock that answers the challenge with a message built for the pubkey the client sent. */
function mockRegisterFlow(opts: { message?: string; regStatus?: number; regBody?: unknown } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (url.endsWith("/v1/nodes/challenge")) {
      const ch = challengeFor(wallet.address, body.nodePubkey ?? null);
      if (opts.message !== undefined) ch.message = opts.message;
      return jsonResponse(ch);
    }
    if (url.endsWith("/v1/nodes")) {
      return jsonResponse(opts.regBody ?? { nodeId: NODE_ID, nodeKey: NODE_KEY, status: "pending", attestationVersion: 1 }, opts.regStatus ?? 201);
    }
    throw new Error(`unexpected ${url}`);
  }) as unknown as typeof fetch;
  return calls;
}

async function setup(cfg: Partial<McpConfig> = {}) {
  const http = await makeHttpClient();
  const server = new McpServer({ name: "t", version: "1" });
  registerNodeTools(server, http, { ...config, ...cfg });
  return server;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-mcp-node-"));
  wallet = Wallet.createRandom() as unknown as Wallet;
  const keyFile = path.join(dir, "wallet.key");
  fs.writeFileSync(keyFile, wallet.privateKey, { mode: 0o600 });
  config = {
    apiKey: API_KEY,
    apiUrl: "http://localhost:3000",
    proxyHost: "proxy.example.com",
    httpProxyPort: 8080,
    socks5ProxyPort: 1080,
    fetchTimeoutMs: 30000,
    fetchMaxResponseBytes: 1024,
    mcpAgentSecret: "",
    walletKeyFile: keyFile,
    nodeKeyFile: path.join(dir, "out", "node.json"),
  };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("solvePow", () => {
  it("finds a nonce meeting the difficulty", () => {
    const n = solvePow("prefix", 8);
    const h = createHash("sha256").update("prefix" + n).digest();
    expect(h[0]).toBe(0);
  });
  it("rejects bad difficulty", () => {
    expect(() => solvePow("p", 0)).toThrow();
    expect(() => solvePow("p", 33)).toThrow();
  });
});

describe("dominusnode_node_register", () => {
  it("signs the shared attestation, solves PoW, writes a 0600 file and never echoes the node key", async () => {
    const server = await setup();
    const calls = mockRegisterFlow();
    const r = await callTool(server, "dominusnode_node_register", { accept_attestation: true, max_streams: 16 });
    expect(r.isError).toBeFalsy();
    const text = r.content[0].text;
    expect(text).not.toContain("dn_node_");
    expect(text).toContain(config.nodeKeyFile);
    expect(text).toContain(NODE_ID);

    // Agent routes use the API key as Bearer, with the MCP agent header.
    for (const c of calls) {
      const h = c.init.headers as Record<string, string>;
      expect(h.Authorization).toBe(`Bearer ${API_KEY}`);
      expect(h["X-DominusNode-Agent"]).toBe("mcp");
    }
    const ch = JSON.parse(String(calls[0].init.body));
    expect(ch.nodePubkey).toMatch(/^[0-9a-f]{64}$/);
    const reg = JSON.parse(String(calls[1].init.body));
    expect(reg.nonce).toBe(NONCE);
    expect(reg.nodePubkey).toBe(ch.nodePubkey);
    expect(reg.maxStreams).toBe(16);
    expect(reg.pow.challengeId).toBe(POW_ID);
    const h = createHash("sha256").update("abcd" + reg.pow.nonce).digest();
    expect(h[0] >> 2).toBe(0); // 6 leading zero bits
    const msg = buildAttestationMessage({ wallet: wallet.address, nonce: NONCE, attestationVersion: 1, attestationText: ATT_TEXT, nodePubkey: ch.nodePubkey });
    expect(verifyMessage(msg, reg.walletSignature).toLowerCase()).toBe(wallet.address.toLowerCase());
    // The wallet key never leaves the process.
    for (const c of calls) expect(String(c.init.body)).not.toContain(wallet.privateKey.slice(2));

    const st = fs.statSync(config.nodeKeyFile);
    if (process.platform !== "win32") expect(st.mode & 0o777).toBe(0o600);
    const stored = JSON.parse(fs.readFileSync(config.nodeKeyFile, "utf8"));
    expect(stored.nodeKey).toBe(NODE_KEY);
    expect(stored.nodeId).toBe(NODE_ID);
    expect(stored.nodePrivateKeyPem).toContain("PRIVATE KEY");
  });

  it("refuses to sign when the server message differs from the local build", async () => {
    const server = await setup();
    const calls = mockRegisterFlow({ message: "DomiNode node attestation\nsomething else" });
    const r = await callTool(server, "dominusnode_node_register", { accept_attestation: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/does not match/);
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(config.nodeKeyFile)).toBe(false);
  });

  it("requires DOMINUSNODE_WALLET_KEY_FILE and never accepts a key argument", async () => {
    const server = await setup({ walletKeyFile: null });
    const r = await callTool(server, "dominusnode_node_register", { accept_attestation: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("DOMINUSNODE_WALLET_KEY_FILE");
    const schema = (server as any)._registeredTools["dominusnode_node_register"].inputSchema;
    expect(Object.keys(schema.shape)).toEqual(["accept_attestation", "max_streams", "max_gb_day"]);
    expect(schema.safeParse({ accept_attestation: false }).success).toBe(false);
  });

  it("rejects a group/world-readable wallet key file", async () => {
    if (process.platform === "win32") return;
    fs.chmodSync(config.walletKeyFile!, 0o644);
    const server = await setup();
    const calls = mockRegisterFlow();
    const r = await callTool(server, "dominusnode_node_register", { accept_attestation: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("chmod 600");
    expect(calls).toHaveLength(0);
  });

  it("refuses to overwrite an existing node key file", async () => {
    fs.mkdirSync(path.dirname(config.nodeKeyFile), { recursive: true });
    fs.writeFileSync(config.nodeKeyFile, "{}");
    const server = await setup();
    const calls = mockRegisterFlow();
    const r = await callTool(server, "dominusnode_node_register", { accept_attestation: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/already exists/);
    expect(calls).toHaveLength(0);
  });

  it("scrubs credentials from server errors (e.g. node cap)", async () => {
    const server = await setup();
    mockRegisterFlow({ regStatus: 409, regBody: { error: `Node limit reached ${NODE_KEY} ${API_KEY}` } });
    const r = await callTool(server, "dominusnode_node_register", { accept_attestation: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Node limit reached");
    expect(r.content[0].text).not.toMatch(/dn_node_[0-9a-f]|dn_live_k/);
  });

  it("rejects a malformed node key in the response without writing a file", async () => {
    const server = await setup();
    mockRegisterFlow({ regBody: { nodeId: NODE_ID, nodeKey: "dn_node_short", status: "pending", attestationVersion: 1 } });
    const r = await callTool(server, "dominusnode_node_register", { accept_attestation: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain("dn_node_short");
    expect(fs.existsSync(config.nodeKeyFile)).toBe(false);
  });
});

describe("other node tools", () => {
  it("node_register_challenge shows the attestation and PoW difficulty", async () => {
    const server = await setup();
    const fetchFn = mockFetchSequence(jsonResponse(challengeFor(wallet.address, null)));
    const r = await callTool(server, "dominusnode_node_register_challenge");
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:3000/v1/nodes/challenge");
    expect(fetchFn.mock.calls[0][1].method).toBe("POST");
    expect(r.content[0].text).toContain(ATT_TEXT);
    expect(r.content[0].text).toContain("difficulty 6");
    expect(r.content[0].text).toContain("policy v3");
  });

  it("node_list renders nodes and paginates", async () => {
    const server = await setup();
    const fetchFn = mockFetchSequence(jsonResponse({
      nodes: [{
        id: NODE_ID, status: "active", walletAddress: "0xabc", observedIp: "203.0.113.7", country: "US", ipClass: "residential",
        maxStreams: 32, maxGbDay: 5, reputation: 0.7, agentVersion: "0.1.0", lastSeenAt: "2026-11-06T00:00:00Z", createdAt: "2026-11-01T00:00:00Z",
      }],
      limit: 10, offset: 5,
    }));
    const r = await callTool(server, "dominusnode_node_list", { limit: 10, offset: 5 });
    expect(fetchFn.mock.calls[0][0]).toBe("http://localhost:3000/v1/nodes?limit=10&offset=5");
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(r.content[0].text).toContain("203.0.113.7");
    expect(r.content[0].text).toContain("[active]");
  });

  it("node_list surfaces verified vs declared class and tier weight (additive)", async () => {
    const server = await setup();
    mockFetchSequence(jsonResponse({
      nodes: [{
        id: NODE_ID, status: "active", walletAddress: "0xabc", observedIp: "104.28.1.2", country: "US", ipClass: "masked",
        verifiedClass: "masked", declaredClass: "residential", tierWeight: 0.25,
        maxStreams: 32, maxGbDay: 5, reputation: 0.7, agentVersion: "0.1.0", lastSeenAt: null, createdAt: "2026-11-01T00:00:00Z",
      }],
      limit: 10, offset: 0,
    }));
    const text = (await callTool(server, "dominusnode_node_list", { limit: 10, offset: 0 })).content[0].text;
    expect(text).toContain("class=masked (declared residential) tierWeight=0.25");
  });

  it("node_list says how to start when empty", async () => {
    const server = await setup();
    mockFetchSequence(jsonResponse({ nodes: [], limit: 100, offset: 0 }));
    const r = await callTool(server, "dominusnode_node_list", { limit: 100, offset: 0 });
    expect(r.content[0].text).toContain("dominusnode_node_setup_guide");
  });

  it("node_revoke requires confirm and a UUID, and calls DELETE", async () => {
    const server = await setup();
    const schema = (server as any)._registeredTools["dominusnode_node_revoke"].inputSchema;
    expect(schema.safeParse({ node_id: NODE_ID }).success).toBe(false);
    expect(schema.safeParse({ node_id: "../admin", confirm: true }).success).toBe(false);
    const fetchFn = mockFetchSequence(jsonResponse({ id: NODE_ID, status: "revoked" }));
    const r = await callTool(server, "dominusnode_node_revoke", { node_id: NODE_ID, confirm: true });
    expect(fetchFn.mock.calls[0][0]).toBe(`http://localhost:3000/v1/nodes/${NODE_ID}`);
    expect(fetchFn.mock.calls[0][1].method).toBe("DELETE");
    expect(r.content[0].text).toContain("revoked");
  });

  it("node_tier shows share and progress to the next tier", async () => {
    const server = await setup();
    const tier = (name: string, rank: number, bps: number) => ({
      id: name, name, rank, nodeShareBps: bps, holdDays: 14, maxNodes: 10, dailyWithdrawLimitMusd: "50000000",
    });
    mockFetchSequence(jsonResponse({
      tier: tier("Probation", 0, 2500),
      nextTier: tier("Bronze", 1, 3000),
      progress: {
        tenureDays: { required: 7, current: 3, met: false },
        activeIps: { required: 1, current: 1, met: true },
        reputation: { required: 0.5, current: 0.6, met: true },
        uptimeBps: { required: 8000, current: null, met: null },
        noClawbackDays: null,
      },
      changedAt: null, uptimeGraceUntil: null, demotionReason: "uptime below threshold",
    }));
    const text = (await callTool(server, "dominusnode_node_tier")).content[0].text;
    expect(text).toContain("Probation");
    expect(text).toContain("25%");
    expect(text).toContain("$50.00");
    expect(text).toContain("Next tier: Bronze");
    expect(text).toContain("Buyer discount on your own relay purchases: 0%");
    expect(text).toContain("Paid tenure days: 3 / 7 (not met)");
    expect(text).toContain("computed daily");
    expect(text).toContain("uptime below threshold");
  });

  it("node_tier lists class weights when the API returns them", async () => {
    const server = await setup();
    const tier = (name: string, rank: number) => ({ id: name, name, rank, nodeShareBps: 2500, holdDays: 14, maxNodes: 10, dailyWithdrawLimitMusd: "1" });
    mockFetchSequence(jsonResponse({
      tier: tier("Probation", 0), nextTier: tier("Bronze", 1),
      progress: { tenureDays: { required: 7, current: 3, met: false }, activeIps: { required: 1, current: 1, met: true },
        reputation: { required: 1, current: 1, met: true }, uptimeBps: { required: 8000, current: null, met: null }, noClawbackDays: null },
      changedAt: null, uptimeGraceUntil: null, demotionReason: null,
      tierWeights: { residential: 1, mobile: 1, dc: 0.4, masked: 0.25 },
    }));
    const text = (await callTool(server, "dominusnode_node_tier")).content[0].text;
    expect(text).toContain("Active IPs are class-weighted: residential 1, mobile 1, dc 0.4, masked 0.25");
  });

  it("node tools fail cleanly without an API key", async () => {
    const server = await setup({ apiKey: null });
    const fetchFn = mockFetchSequence();
    const r = await callTool(server, "dominusnode_node_tier");
    expect(r.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("node_setup_guide gives exact commands and explains earning rules", async () => {
    const server = await setup();
    const text = (await callTool(server, "dominusnode_node_setup_guide")).content[0].text;
    expect(text).toContain("main.js register --wallet-key-file");
    expect(text).toContain("main.js run --key-file");
    expect(text).toContain("DOMINUSNODE_WALLET_KEY_FILE");
    expect(text).toMatch(/Self-dealing earns nothing/);
    expect(text).toMatch(/80\/443/);
    expect(text).not.toMatch(/dn_live_k/);
  });
});
