/**
 * Node (supply-side) tools: register a relay node owned by this agent's wallet,
 * list/revoke nodes, and read tier progress (DESIGN.md §10, §15).
 *
 * Secrets: the owner wallet private key is only ever read from the file named
 * by DOMINUSNODE_WALLET_KEY_FILE (never a tool argument), and the returned
 * dn_node_ key is written to a 0600 file and never echoed in tool output.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Wallet } from "ethers";
import { buildAttestationMessage } from "../attestation.js";
import type { McpConfig } from "../config.js";
import { scrubCredentials, type HttpClient } from "../http-client.js";
import { formatMusd } from "./network.js";

const HEX64 = /^[0-9a-f]{64}$/;
const NODE_KEY_RE = /^dn_node_[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIG_RE = /^0x[0-9a-fA-F]{130}$/;
const MAX_ATTESTATION_TEXT = 20_000;

/** Node credential file; same shape the node agent (`dominusnode-node run`) reads. */
export interface StoredNode {
  nodeId: string;
  nodeKey: string;
  nodePubkey: string;
  nodePrivateKeyPem: string;
  apiUrl: string;
  createdAt: string;
}

interface ChallengeResponse {
  nonce: string;
  attestationText: string;
  attestationVersion: number;
  policyVersion?: number;
  message?: string;
  expiresAt?: string;
  powChallenge?: { challengeId?: string; prefix?: string; difficulty?: number; algorithm?: string; expiresAt?: string };
}

interface RegisterResponse {
  nodeId: string;
  nodeKey: string;
  status: string;
  attestationVersion: number;
}

interface NodeView {
  id: string;
  status: string;
  walletAddress: string | null;
  observedIp: string | null;
  country: string | null;
  ipClass: string | null;
  maxStreams: number | null;
  maxGbDay: number | null;
  reputation: number | string | null;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

interface TierView {
  id: string;
  name: string;
  rank: number;
  nodeShareBps: number;
  holdDays: number;
  maxNodes: number;
  dailyWithdrawLimitMusd: string;
}

interface Req {
  required: number;
  current: number | null;
  met: boolean | null;
}

interface TierResponse {
  tier: TierView;
  nextTier: TierView | null;
  progress: {
    tenureDays: Req;
    activeIps: Req;
    reputation: Req;
    uptimeBps: Req;
    noClawbackDays: Req | null;
  } | null;
  changedAt: string | null;
  uptimeGraceUntil: string | null;
  demotionReason: string | null;
}

export class NodeToolError extends Error {
  constructor(message: string) {
    super(scrubCredentials(message));
    this.name = "NodeToolError";
  }
}

function countLeadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (const byte of buf) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/** Find n such that sha256(prefix + n) has `difficulty` leading zero bits (server verifyPow). */
export function solvePow(prefix: string, difficulty: number, maxIterations = 200_000_000): string {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 32) throw new NodeToolError("invalid PoW difficulty");
  for (let n = 0; n < maxIterations; n++) {
    const h = createHash("sha256").update(prefix + n.toString()).digest();
    if (countLeadingZeroBits(h) >= difficulty) return n.toString();
  }
  throw new NodeToolError("PoW not solved within iteration cap");
}

/** Read the owner wallet key from a file; refuses group/world-accessible files. */
export function readWalletKey(file: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new NodeToolError("wallet key file (DOMINUSNODE_WALLET_KEY_FILE) is not readable");
  }
  if (!st.isFile()) throw new NodeToolError("wallet key path is not a regular file");
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new NodeToolError("wallet key file must not be group/world accessible (chmod 600)");
  }
  if (st.size > 4096) throw new NodeToolError("wallet key file too large");
  const raw = fs.readFileSync(file, "utf8").trim();
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new NodeToolError("wallet key file must contain a 32-byte hex private key");
  return key;
}

/** Write the node file with mode 0600, never replacing an existing file. */
export function writeNodeFile(file: string, data: StoredNode): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(tmp, 0o600);
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new NodeToolError("node key file already exists; refusing to overwrite");
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function requireApiKey(config: McpConfig): string {
  if (!config.apiKey) throw new NodeToolError("DOMINUSNODE_API_KEY is required for node tools");
  return config.apiKey;
}

function validateChallenge(ch: ChallengeResponse): asserts ch is ChallengeResponse & {
  powChallenge: { prefix: string; difficulty: number; challengeId: string };
} {
  if (typeof ch.nonce !== "string" || !HEX64.test(ch.nonce)) throw new NodeToolError("invalid challenge nonce");
  if (typeof ch.attestationText !== "string" || !ch.attestationText || ch.attestationText.length > MAX_ATTESTATION_TEXT) {
    throw new NodeToolError("invalid attestation text");
  }
  if (!Number.isInteger(ch.attestationVersion) || ch.attestationVersion < 1 || ch.attestationVersion > 100_000) {
    throw new NodeToolError("invalid attestation version");
  }
  const pow = ch.powChallenge;
  if (
    !pow || typeof pow.prefix !== "string" || pow.prefix.length > 256 ||
    typeof pow.difficulty !== "number" || typeof pow.challengeId !== "string" || !UUID_RE.test(pow.challengeId)
  ) {
    throw new NodeToolError("invalid PoW challenge");
  }
}

export interface RegisterResult {
  nodeId: string;
  status: string;
  attestationVersion: number;
  keyFile: string;
}

/** Full registration: challenge -> local attestation build -> PoW -> EIP-191 sign -> register -> 0600 file. */
export async function registerNodeViaApi(
  httpClient: HttpClient,
  config: McpConfig,
  opts: { maxStreams?: number; maxGbDay?: number },
): Promise<RegisterResult> {
  const apiKey = requireApiKey(config);
  if (!config.walletKeyFile) {
    throw new NodeToolError(
      "DOMINUSNODE_WALLET_KEY_FILE is not set. Point it at a chmod-600 file holding the private key of the wallet linked to this account, then restart the MCP server.",
    );
  }
  const outFile = path.resolve(config.nodeKeyFile);
  if (fs.existsSync(outFile)) {
    throw new NodeToolError(`node key file ${outFile} already exists; set DOMINUSNODE_NODE_KEY_FILE to a new path to register another node`);
  }
  const wallet = new Wallet(readWalletKey(config.walletKeyFile));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const nodePubkey = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");

  const ch = await httpClient.request<ChallengeResponse>({
    method: "POST", path: "/v1/nodes/challenge", body: { nodePubkey }, bearer: apiKey,
  });
  validateChallenge(ch);

  const message = buildAttestationMessage({
    wallet: wallet.address,
    nonce: ch.nonce,
    attestationVersion: ch.attestationVersion,
    attestationText: ch.attestationText,
    nodePubkey,
  });
  // Never sign the server's string blindly: if it sent one, it must equal ours.
  if (ch.message !== undefined && ch.message !== message) {
    throw new NodeToolError(
      "server attestation message does not match the locally built one (the key file's wallet is not the wallet linked to this account, or protocol mismatch)",
    );
  }
  const powNonce = solvePow(ch.powChallenge.prefix, ch.powChallenge.difficulty);
  const walletSignature = await wallet.signMessage(message);
  if (!SIG_RE.test(walletSignature)) throw new NodeToolError("signature has unexpected format");

  const body: Record<string, unknown> = {
    nonce: ch.nonce,
    walletSignature,
    nodePubkey,
    attestationVersion: ch.attestationVersion,
    pow: { challengeId: ch.powChallenge.challengeId, nonce: powNonce },
  };
  if (opts.maxStreams !== undefined) body["maxStreams"] = opts.maxStreams;
  if (opts.maxGbDay !== undefined) body["maxGbDay"] = opts.maxGbDay;

  const reg = await httpClient.request<RegisterResponse>({ method: "POST", path: "/v1/nodes", body, bearer: apiKey });
  if (typeof reg.nodeId !== "string" || !UUID_RE.test(reg.nodeId)) throw new NodeToolError("invalid nodeId in response");
  if (typeof reg.nodeKey !== "string" || !NODE_KEY_RE.test(reg.nodeKey)) throw new NodeToolError("invalid node key in response");

  writeNodeFile(outFile, {
    nodeId: reg.nodeId,
    nodeKey: reg.nodeKey,
    nodePubkey,
    nodePrivateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    apiUrl: config.apiUrl,
    createdAt: new Date().toISOString(),
  });
  return {
    nodeId: reg.nodeId,
    status: String(reg.status ?? "unknown"),
    attestationVersion: reg.attestationVersion,
    keyFile: outFile,
  };
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${scrubCredentials(err instanceof Error ? err.message : String(err))}` }],
  };
}

function fmtReq(label: string, r: Req | null, unit = ""): string | null {
  if (!r) return null;
  const cur = r.current === null ? "computed daily" : `${r.current}${unit}`;
  const mark = r.met === null ? "?" : r.met ? "met" : "not met";
  return `  ${label}: ${cur} / ${r.required}${unit} (${mark})`;
}

export function nodeSetupGuide(config: McpConfig): string {
  return [
    `DominusNode relay node setup (earn by contributing an IP)`,
    ``,
    `How earning works`,
    `  - Your node dials OUT to the gateway (no inbound ports) and relays other agents' traffic.`,
    `  - You earn your tier's share (Probation 25% ... Partner 50%) of each paid GB relayed; prices and`,
    `    shares are live in dominusnode_network_pricing. Earnings mature before becoming available.`,
    `  - Self-dealing earns nothing: traffic from you, your wallet, your team or your /24 is never routed`,
    `    to your node, and any that slips through settles with a zero node share.`,
    `  - Tiers rise with paid tenure, uptime, active IPs (distinct /32s with 3+ paying requesters in 7d)`,
    `    and reputation. Check progress with dominusnode_node_tier.`,
    `  - The node floor is fixed: only ports 80/443, never private/loopback/metadata targets, never`,
    `    SMTP/SSH/RDP, connection metadata only (no payload logging). See dominusnode_network_policy.`,
    ``,
    `Prerequisites`,
    `  - A wallet-linked account (dominusnode_wallet_setup) and a dn_live_ API key (not a team key).`,
    `  - Node.js >= 18 and git on the machine whose IP you contribute.`,
    `  - IPs in sanctioned countries cannot join (list in dominusnode_network_policy).`,
    ``,
    `Step 1: Store the owner wallet key in a private file (never pass it as an argument)`,
    `  umask 077 && printf '%s' "$WALLET_PRIVATE_KEY_HEX" > ~/.dominusnode/wallet.key && chmod 600 ~/.dominusnode/wallet.key`,
    ``,
    `Step 2: Register the node (pick ONE)`,
    `  a) From this MCP server: set DOMINUSNODE_WALLET_KEY_FILE=~/.dominusnode/wallet.key (and optionally`,
    `     DOMINUSNODE_NODE_KEY_FILE, default ${config.nodeKeyFile}), restart, then call`,
    `     dominusnode_node_register with accept_attestation=true. The node key is written to that file (0600).`,
    `  b) With the node agent CLI on the node machine:`,
    `     git clone https://github.com/0xcircuitbreaker/DomiNode.git && cd DomiNode`,
    `     npm ci && npm run build -w @dominusnode/shared -w @dominusnode/node-agent`,
    `     export DN_API_KEY  # your dn_live_ key, from env only`,
    `     node packages/node-agent/dist/src/main.js register --wallet-key-file ~/.dominusnode/wallet.key`,
    `     (writes ~/.dominusnode/node.json, mode 0600; override with --key-file or DN_NODE_KEY_FILE)`,
    ``,
    `Step 3: Run the node agent on the machine that owns the IP`,
    `  If you registered from MCP on another machine, copy the node file there with mode 0600.`,
    `  node packages/node-agent/dist/src/main.js run --key-file ~/.dominusnode/node.json`,
    `  Optional limits (can only tighten): --ports 443  --max-streams 32  --gb-per-day 5  --req-per-sec 20`,
    `  Env equivalents: DN_NODE_KEY_FILE, DN_NODE_PORTS, DN_NODE_MAX_STREAMS, DN_NODE_GB_PER_DAY,`,
    `  DN_NODE_REQ_PER_SEC, DN_NODE_MAX_MBPS, DN_NODE_DENY_DOMAINS, DN_NODE_API_URL, DN_NODE_GATEWAY_URL.`,
    `  Keep it running (systemd, pm2, or a container restart policy) - uptime drives your tier.`,
    ``,
    `Step 4: Verify`,
    `  dominusnode_node_list shows status, observed IP, class and last-seen time once the tunnel is up.`,
    `  dominusnode_node_revoke permanently retires a node (irreversible).`,
  ].join("\n");
}

export function registerNodeTools(server: McpServer, httpClient: HttpClient, config: McpConfig): void {
  const bearer = () => requireApiKey(config);

  server.tool(
    "dominusnode_node_register_challenge",
    "Preview what registering a relay node commits you to: fetches a node challenge (POST /v1/nodes/challenge) and shows the exact " +
      "attestation text and version you will sign with your linked wallet, the policy version, and the proof-of-work difficulty. " +
      "Read-only in effect (the challenge simply expires); dominusnode_node_register requests its own fresh challenge. " +
      "Requires a wallet-linked account and a personal (non-team) API key.",
    {},
    async () => {
      try {
        const ch = await httpClient.request<ChallengeResponse>({
          method: "POST", path: "/v1/nodes/challenge", body: {}, bearer: bearer(),
        });
        const text = [
          `Node attestation v${ch.attestationVersion} (policy v${ch.policyVersion ?? "?"})`,
          ``,
          `You will sign (EIP-191 personal_sign, with your linked wallet):`,
          `---`,
          ch.message ?? ch.attestationText,
          `---`,
          ``,
          `Proof-of-work: sha256, difficulty ${ch.powChallenge?.difficulty ?? "?"} leading zero bits (solved locally).`,
          `Challenge expires: ${ch.expiresAt ?? "?"}`,
          ``,
          `To register: set DOMINUSNODE_WALLET_KEY_FILE (chmod 600) and call dominusnode_node_register`,
          `with accept_attestation=true. The node key is written to ${path.resolve(config.nodeKeyFile)}.`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_node_register",
    "Register a relay node so you EARN from contributing an IP. Runs the full flow locally: challenge, attestation built with the " +
      "shared builder and checked against the server's, proof-of-work, EIP-191 signature with the wallet key read from the file in " +
      "DOMINUSNODE_WALLET_KEY_FILE (never an argument), then POST /v1/nodes. The returned dn_node_ key is written to a new 0600 file " +
      "(DOMINUSNODE_NODE_KEY_FILE, never overwritten) and is NOT shown; the tool returns the file path. Then run the node agent with it " +
      "(see dominusnode_node_setup_guide). Node count is capped by tier; self-dealing traffic earns nothing.",
    {
      accept_attestation: z.literal(true).describe("Must be true: you have read the attestation (dominusnode_node_register_challenge / dominusnode_network_policy) and agree to sign it"),
      max_streams: z.number().int().min(1).max(1024).optional().describe("Optional concurrent stream cap for this node (1-1024)"),
      max_gb_day: z.number().int().min(1).max(10000).optional().describe("Optional daily GB cap for this node (1-10000)"),
    },
    async (args) => {
      try {
        const r = await registerNodeViaApi(httpClient, config, { maxStreams: args.max_streams, maxGbDay: args.max_gb_day });
        const text = [
          `Node registered.`,
          `  Node ID: ${r.nodeId}`,
          `  Status: ${r.status}`,
          `  Attestation version: ${r.attestationVersion}`,
          `  Node key file (mode 0600): ${r.keyFile}`,
          ``,
          `The node key is stored only in that file and is not shown here.`,
          `Next: run the node agent with --key-file ${r.keyFile} on the machine whose IP you contribute`,
          `(dominusnode_node_setup_guide), then check dominusnode_node_list.`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_node_list",
    "List the relay nodes you own (GET /v1/nodes): status, observed IP, country, IP class, caps, reputation, agent version and last-seen time.",
    {
      limit: z.number().int().min(1).max(500).default(100).describe("Max nodes to return"),
      offset: z.number().int().min(0).max(1_000_000).default(0).describe("Pagination offset"),
    },
    async (args) => {
      try {
        const data = await httpClient.request<{ nodes: NodeView[] }>({
          method: "GET", path: `/v1/nodes?limit=${args.limit}&offset=${args.offset}`, bearer: bearer(),
        });
        const nodes = data.nodes ?? [];
        if (!nodes.length) {
          return { content: [{ type: "text", text: "No nodes registered. See dominusnode_node_setup_guide to start earning." }] };
        }
        const lines = [`Your nodes (${nodes.length}):`, ``];
        for (const n of nodes) {
          lines.push(
            `${n.id} [${n.status}] ${n.observedIp ?? "no IP yet"} ${n.country ?? "--"} class=${n.ipClass ?? "?"} ` +
              `rep=${n.reputation ?? "?"} streams=${n.maxStreams ?? "default"} gb/day=${n.maxGbDay ?? "default"} ` +
              `agent=${n.agentVersion ?? "?"} lastSeen=${n.lastSeenAt ?? "never"}`,
          );
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_node_revoke",
    "Permanently revoke one of your relay nodes (DELETE /v1/nodes/:id). Irreversible: its key stops working and the tunnel is dropped. Register a new node to rejoin.",
    {
      node_id: z.string().regex(UUID_RE).describe("Node UUID from dominusnode_node_list"),
      confirm: z.literal(true).describe("Must be true to confirm the irreversible revoke"),
    },
    async (args) => {
      try {
        const r = await httpClient.request<{ id: string; status: string }>({
          method: "DELETE", path: `/v1/nodes/${encodeURIComponent(args.node_id)}`, bearer: bearer(),
        });
        return { content: [{ type: "text", text: `Node ${r.id} is now ${r.status}.` }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_node_tier",
    "Show your node-operator tier (GET /v1/node/tier): current share of relay revenue, earnings hold days, node cap, daily withdraw limit, " +
      "progress toward the next tier (paid tenure days, active IPs, reputation, uptime, no-clawback days) and any demotion reason. " +
      "Only matured, undisputed paid traffic from OTHER principals counts toward tiers.",
    {},
    async () => {
      try {
        const t = await httpClient.request<TierResponse>({ method: "GET", path: "/v1/node/tier", bearer: bearer() });
        const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
        const lines = [
          `Tier: ${t.tier.name} (rank ${t.tier.rank}) — node share ${pct(t.tier.nodeShareBps)}`,
          `  Earnings hold: ${t.tier.holdDays} days, node cap: ${t.tier.maxNodes}, daily withdraw limit: ${formatMusd(t.tier.dailyWithdrawLimitMusd)}`,
        ];
        if (t.demotionReason) lines.push(`  Demotion reason: ${t.demotionReason}`);
        if (t.uptimeGraceUntil) lines.push(`  Uptime grace until: ${t.uptimeGraceUntil}`);
        if (t.nextTier && t.progress) {
          lines.push(``, `Next tier: ${t.nextTier.name} — node share ${pct(t.nextTier.nodeShareBps)}, cap ${t.nextTier.maxNodes}`);
          lines.push(
            ...[
              fmtReq("Paid tenure days", t.progress.tenureDays),
              fmtReq("Active IPs", t.progress.activeIps),
              fmtReq("Reputation", t.progress.reputation),
              fmtReq("30d uptime (bps)", t.progress.uptimeBps),
              fmtReq("Days since last clawback", t.progress.noClawbackDays),
            ].filter((l): l is string => l !== null),
          );
          lines.push(`  Promotion is one step at a time, evaluated daily.`);
        } else {
          lines.push(``, `You are at the top tier.`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.tool(
    "dominusnode_node_setup_guide",
    "Step-by-step instructions to contribute an IP and earn: how earning, tiers and the self-dealing rule work, how to store the wallet key " +
      "safely, register a node (via dominusnode_node_register or the node agent CLI), and run the node agent with exact commands and limits.",
    {},
    async () => ({ content: [{ type: "text", text: nodeSetupGuide(config) }] }),
  );
}
