import type { HttpClient } from "../http.js";
import { invalidArg, ProtocolError } from "../errors.js";
import { Secret } from "../secret.js";
import { assertSigner, sign, type Signer } from "../signer.js";
import { buildAttestationMessage, assertSameMessage } from "../messages.js";
import { solvePow } from "../pow.js";
import { HEX64_RE, UUID_RE, qs, seg, validateIntRange, validateUuid } from "../validation.js";

export interface NodeChallenge {
  nonce: string;
  attestationText: string;
  attestationVersion: number;
  policyVersion: number;
  /** Server-built attestation message. The SDK rebuilds it and refuses to sign if it differs. */
  message: string;
  expiresAt: string;
  powChallenge: { challengeId: string; prefix: string; difficulty: number; algorithm: string; expiresAt: string };
}

export interface RegisterNodeOptions {
  /** EIP-191 signer for the wallet LINKED to this account. */
  signer: Signer;
  /** Node's ed25519 public key, 64 lowercase hex (optional; bound into the attestation). */
  nodePubkey?: string;
  /** Use a challenge from registerChallenge() (must have been requested with the same nodePubkey). Fetched if omitted. */
  challenge?: NodeChallenge;
  /** 1..1024 */
  maxStreams?: number;
  /** 1..10000 */
  maxGbDay?: number;
  /** PoW search cap (default 200,000,000). */
  maxPowIterations?: number;
}

export interface RegisteredNode {
  nodeId: string;
  status: string;
  attestationVersion: number;
  /** dn_node_ key, returned ONCE. Redacted when printed/serialised; call nodeKey.reveal() and store it 0600. */
  nodeKey: Secret;
}

/** Caller's own node. observedIp is the owner's own node address, never another party's. */
export interface NodeInfo {
  id: string;
  status: string;
  walletAddress: string;
  nodePubkey: string | null;
  attestationVersion: number;
  observedIp: string | null;
  country: string | null;
  ipClass: string | null;
  maxStreams: number | null;
  maxGbDay: number | null;
  reputation: number;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface NodeCaps {
  maxStreams?: number;
  gbPerDay?: number;
  reqPerSec?: number;
}

export interface UpdateCapsResult {
  id: string;
  status: string;
  caps: Required<{ [K in keyof NodeCaps]: number | null }>;
  effective: Required<{ [K in keyof NodeCaps]: number }>;
  appliesOn: "next_tunnel_connect" | string;
}

export interface TierView {
  id: number;
  name: string;
  rank: number;
  nodeShareBps: number;
  holdDays: number;
  maxNodes: number;
  dailyWithdrawLimitMusd: string;
}

export interface TierRequirement {
  required: number;
  current: number | null;
  met: boolean | null;
}

export interface NodeTier {
  tier: TierView;
  nextTier: TierView | null;
  progress: {
    tenureDays: TierRequirement;
    activeIps: TierRequirement;
    reputation: TierRequirement;
    uptimeBps: TierRequirement;
    noClawbackDays: TierRequirement | null;
  } | null;
  changedAt: string | null;
  uptimeGraceUntil: string | null;
  demotionReason: string | null;
}

const NODE_KEY_RE = /^dn_node_[0-9a-f]{64}$/;
const MAX_ATTESTATION_TEXT = 64 * 1024;

function normPubkey(v: string | undefined): string | null {
  if (v === undefined) return null;
  const k = typeof v === "string" ? v.toLowerCase() : "";
  if (!HEX64_RE.test(k)) throw invalidArg("nodePubkey must be 64 hex characters (32-byte ed25519 public key)");
  return k;
}

function checkChallenge(ch: NodeChallenge): void {
  if (!ch || typeof ch !== "object") throw new ProtocolError("invalid node challenge");
  if (typeof ch.nonce !== "string" || !HEX64_RE.test(ch.nonce)) throw new ProtocolError("invalid challenge nonce");
  if (typeof ch.attestationText !== "string" || !ch.attestationText || ch.attestationText.length > MAX_ATTESTATION_TEXT) {
    throw new ProtocolError("invalid attestation text");
  }
  if (!Number.isInteger(ch.attestationVersion) || ch.attestationVersion < 1 || ch.attestationVersion > 100_000) {
    throw new ProtocolError("invalid attestation version");
  }
  const p = ch.powChallenge;
  if (!p || typeof p.prefix !== "string" || typeof p.difficulty !== "number" || typeof p.challengeId !== "string" || !UUID_RE.test(p.challengeId)) {
    throw new ProtocolError("invalid PoW challenge");
  }
}

/** Relay nodes you own (earn by contributing an IP). All routes are /v1 agent routes. */
export class NodesResource {
  constructor(private http: HttpClient) {}

  /** POST /v1/nodes/challenge — nonce + attestation text + PoW puzzle (needs a linked wallet). */
  async registerChallenge(opts: { nodePubkey?: string } = {}): Promise<NodeChallenge> {
    const nodePubkey = normPubkey(opts.nodePubkey);
    return this.http.post("/v1/nodes/challenge", nodePubkey ? { nodePubkey } : {}, "agent");
  }

  /**
   * Full registration: challenge -> rebuild attestation locally (refuse on mismatch)
   * -> solve PoW -> signer.signMessage -> POST /v1/nodes. Returns the node key once.
   */
  async register(opts: RegisterNodeOptions): Promise<RegisteredNode> {
    const signer = assertSigner(opts?.signer);
    const nodePubkey = normPubkey(opts.nodePubkey);
    if (opts.maxStreams !== undefined) validateIntRange(opts.maxStreams, "maxStreams", 1, 1024);
    if (opts.maxGbDay !== undefined) validateIntRange(opts.maxGbDay, "maxGbDay", 1, 10_000);

    const ch = opts.challenge ?? await this.registerChallenge({ nodePubkey: nodePubkey ?? undefined });
    checkChallenge(ch);
    const message = buildAttestationMessage({
      wallet: signer.address,
      nonce: ch.nonce,
      attestationVersion: ch.attestationVersion,
      attestationText: ch.attestationText,
      nodePubkey,
    });
    assertSameMessage(ch.message, message, "node attestation");
    const powNonce = solvePow(ch.powChallenge.prefix, ch.powChallenge.difficulty, opts.maxPowIterations);
    const walletSignature = await sign(signer, message);

    const body: Record<string, unknown> = {
      nonce: ch.nonce,
      walletSignature,
      attestationVersion: ch.attestationVersion,
      pow: { challengeId: ch.powChallenge.challengeId, nonce: powNonce },
    };
    if (nodePubkey) body["nodePubkey"] = nodePubkey;
    if (opts.maxStreams !== undefined) body["maxStreams"] = opts.maxStreams;
    if (opts.maxGbDay !== undefined) body["maxGbDay"] = opts.maxGbDay;

    const r = await this.http.post<{ nodeId: string; nodeKey: string; status: string; attestationVersion: number }>("/v1/nodes", body, "agent");
    if (typeof r.nodeId !== "string" || !UUID_RE.test(r.nodeId)) throw new ProtocolError("invalid nodeId in response");
    if (typeof r.nodeKey !== "string" || !NODE_KEY_RE.test(r.nodeKey)) throw new ProtocolError("invalid node key in response");
    return { nodeId: r.nodeId, status: String(r.status), attestationVersion: r.attestationVersion, nodeKey: new Secret(r.nodeKey) };
  }

  /** GET /v1/nodes — limit 1..500 (default 100). */
  async list(opts: { limit?: number; offset?: number } = {}): Promise<{ nodes: NodeInfo[]; limit: number; offset: number }> {
    if (opts.limit !== undefined) validateIntRange(opts.limit, "limit", 1, 500);
    if (opts.offset !== undefined) validateIntRange(opts.offset, "offset", 0, 1_000_000);
    return this.http.get(`/v1/nodes${qs({ limit: opts.limit, offset: opts.offset })}`, "agent");
  }

  /** DELETE /v1/nodes/:id — irreversible. */
  async revoke(nodeId: string): Promise<{ id: string; status: string }> {
    return this.http.delete(`/v1/nodes/${seg(validateUuid(nodeId, "nodeId"))}`, "agent");
  }

  /** PATCH /v1/nodes/:id — lower caps only (each <= policy default, else CAP_ABOVE_DEFAULT). Applies on next tunnel connect. */
  async updateCaps(nodeId: string, caps: NodeCaps): Promise<UpdateCapsResult> {
    validateUuid(nodeId, "nodeId");
    const body: Record<string, number> = {};
    for (const k of ["maxStreams", "gbPerDay", "reqPerSec"] as const) {
      const v = caps?.[k];
      if (v !== undefined) body[k] = validateIntRange(v, k, 1, 1_000_000);
    }
    if (Object.keys(body).length === 0) throw invalidArg("updateCaps needs at least one of maxStreams, gbPerDay, reqPerSec");
    return this.http.patch(`/v1/nodes/${seg(nodeId)}`, body, "agent");
  }

  /** GET /v1/node/tier — current tier, next tier and progress. */
  async tier(): Promise<NodeTier> {
    return this.http.get("/v1/node/tier", "agent");
  }
}
