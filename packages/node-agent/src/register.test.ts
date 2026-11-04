import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { verifyMessage } from "ethers";
import { buildAttestationMessage, countLeadingZeroBits, readCapped, readNodeFile, readWalletKey, registerNode, solvePow, writeNodeFile } from "./register.js";
import { parseFlags } from "./main.js";
import type { buildAttestationMessage as BuildFn } from "./register.js";

// Load the dashboard's builder via a non-literal specifier so tsc (rootDir) does
// not pull another package's sources into this build; vitest resolves it at runtime.
const DASHBOARD_ATTESTATION = "../../shared/src/attestation.ts";
let serverBuild: typeof BuildFn;
beforeAll(async () => {
  serverBuild = ((await import(DASHBOARD_ATTESTATION)) as { buildAttestationMessage: typeof BuildFn }).buildAttestationMessage;
});

const WALLET_KEY = "0x" + "11".repeat(32);
const NODE_KEY = "dn_node_" + "ef".repeat(32);
const WALLET_ADDR = "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A";

describe("register", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-node-")); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("pow solver meets difficulty", () => {
    expect(countLeadingZeroBits(Buffer.from([0, 0x0f]))).toBe(12);
    const n = solvePow("abc", 8);
    expect(n).toMatch(/^\d+$/);
    expect(() => solvePow("abc", 33)).toThrow();
  });

  it("refuses group/world-readable wallet key files", () => {
    const f = path.join(dir, "w");
    fs.writeFileSync(f, WALLET_KEY, { mode: 0o644 });
    expect(() => readWalletKey(f)).toThrow(/chmod 600/);
    fs.chmodSync(f, 0o600);
    expect(readWalletKey(f)).toBe(WALLET_KEY);
  });

  it("registers: challenge -> PoW -> EIP-191 -> store key 0600", async () => {
    const wf = path.join(dir, "wallet");
    fs.writeFileSync(wf, WALLET_KEY.slice(2) + "\n", { mode: 0o600 });
    const out = path.join(dir, "cfg", "node.json");
    const calls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body, auth: (init.headers as Record<string, string>)["Authorization"] });
      expect(init.redirect).toBe("error");
      const json = url.endsWith("/challenge")
        ? { nonce: "aa".repeat(32), attestationText: "I operate lawfully.", attestationVersion: 1,
            message: serverBuild({ wallet: WALLET_ADDR, nonce: "aa".repeat(32), attestationVersion: 1,
              attestationText: "I operate lawfully.", nodePubkey: body["nodePubkey"] as string }),
            powChallenge: { prefix: "p:", difficulty: 6, challengeId: "c1" }, __proto__: { polluted: true } }
        : { nodeId: "0b5c2e9a-1111-4222-8333-444455556666", nodeKey: NODE_KEY };
      return new Response(JSON.stringify(json), { status: 200 });
    }) as unknown as typeof fetch;
    const stored = await registerNode({ apiUrl: "https://api.test/", apiKey: "dn_live_x", walletKeyFile: wf, outFile: out, fetchFn });
    expect(calls.map((c) => c.url)).toEqual(["https://api.test/v1/nodes/challenge", "https://api.test/v1/nodes"]);
    expect(calls[0].auth).toBe("Bearer dn_live_x");
    const reg = calls[1].body as { walletSignature: string; nodePubkey: string; pow: { nonce: string } };
    expect(reg.nodePubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0].body["nodePubkey"]).toBe(reg.nodePubkey);
    const msg = serverBuild({ wallet: WALLET_ADDR, nonce: "aa".repeat(32), attestationVersion: 1,
      attestationText: "I operate lawfully.", nodePubkey: reg.nodePubkey });
    expect(verifyMessage(msg, reg.walletSignature).toLowerCase())
      .toBe("0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a".toLowerCase());
    expect(JSON.stringify(calls)).not.toContain(WALLET_KEY.slice(2));
    expect(fs.statSync(out).mode & 0o777).toBe(0o600);
    expect(readNodeFile(out).nodeKey).toBe(NODE_KEY);
    expect(stored.nodeId).toMatch(/^0b5c/);
    await expect(registerNode({ apiUrl: "https://api.test", apiKey: "k", walletKeyFile: wf, outFile: out, fetchFn }))
      .rejects.toThrow(/already exists/);
  });

  it("attestation builder matches the dashboard builder byte-for-byte", () => {
    const p = { wallet: WALLET_ADDR, nonce: "bb".repeat(32), attestationVersion: 3, attestationText: "line1\nline2", nodePubkey: "cd".repeat(32) };
    expect(buildAttestationMessage(p)).toBe(serverBuild(p));
    expect(buildAttestationMessage({ ...p, nodePubkey: null })).toBe(serverBuild({ ...p, nodePubkey: null }));
    expect(buildAttestationMessage(p)).toBe(
      "DomiNode node attestation\nVersion: 3\nWallet: " + WALLET_ADDR.toLowerCase() + "\nNonce: " + "bb".repeat(32) +
      "\nNode pubkey: " + "cd".repeat(32) + "\n\nline1\nline2");
  });

  it("aborts when the server message differs from the local one (no blind signing)", async () => {
    const wf = path.join(dir, "wallet");
    fs.writeFileSync(wf, WALLET_KEY, { mode: 0o600 });
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(JSON.stringify({ nonce: "aa".repeat(32), attestationText: "t", attestationVersion: 1,
        message: "Send all funds to 0xevil", powChallenge: { prefix: "p:", difficulty: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(registerNode({ apiUrl: "https://a", apiKey: "k", walletKeyFile: wf, outFile: path.join(dir, "n.json"), fetchFn }))
      .rejects.toThrow(/does not match/);
    expect(calls).toBe(1);
  });

  it("caps response bodies while streaming", async () => {
    const big = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(16 * 1024)); },
    });
    await expect(readCapped(new Response(big), 64 * 1024)).rejects.toThrow(/too large/);
    const declared = new Response("x", { headers: { "content-length": "999999999" } });
    await expect(readCapped(declared, 64 * 1024)).rejects.toThrow(/too large/);
    expect(await readCapped(new Response("{}"), 64 * 1024)).toBe("{}");
  });

  it("writeNodeFile never replaces an existing file and tightens the parent dir", () => {
    const d = path.join(dir, "loose");
    fs.mkdirSync(d, { mode: 0o755 });
    fs.chmodSync(d, 0o755);
    const f = path.join(d, "node.json");
    const data = { nodeId: "a", nodeKey: NODE_KEY, nodePubkey: "x", nodePrivateKeyPem: "p", apiUrl: "u", createdAt: "c" };
    writeNodeFile(f, data);
    expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    expect(() => writeNodeFile(f, { ...data, nodeId: "b" })).toThrow(/already exists/);
    expect(readNodeFile(f).nodeId).toBe("a");
    expect(fs.readdirSync(d)).toEqual(["node.json"]);
  });

  it("CLI refuses secrets as flags", () => {
    expect(() => parseFlags(["--api-key", "dn_live_x"])).toThrow(/not accepted/);
    expect(() => parseFlags(["--wallet-key=abc"])).toThrow(/not accepted/);
    expect(parseFlags(["--wallet-key-file", "/k", "--ports=443"])).toMatchObject({ "wallet-key-file": "/k", ports: "443" });
  });
});
