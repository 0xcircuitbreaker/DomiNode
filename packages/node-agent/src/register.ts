/**
 * Node registration (DESIGN.md §3, §10): challenge -> PoW -> EIP-191 attestation
 * signed with the owner wallet key (read from a FILE, never argv) -> store the
 * returned dn_node_ key with mode 0600.
 */
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Wallet } from "ethers";
import { scrub } from "./tunnel-client.js";
import { stripDangerousKeys } from "./shared.js";
import { buildAttestationMessage } from "@dominusnode/shared";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ATTESTATION_TEXT = 20_000;
const HEX64 = /^[0-9a-f]{64}$/;
const NODE_KEY_RE = /^dn_node_[0-9a-f]{64}$/;
const UUIDISH = /^[A-Za-z0-9-]{1,64}$/;

export interface StoredNode {
  nodeId: string;
  nodeKey: string;
  nodePubkey: string;
  /** PKCS#8 PEM ed25519 private key for channel binding (commit 20). */
  nodePrivateKeyPem: string;
  apiUrl: string;
  createdAt: string;
}

export class RegisterError extends Error {
  constructor(message: string) {
    super(scrub(message));
    this.name = "RegisterError";
  }
}

export function countLeadingZeroBits(buf: Buffer): number {
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

export function solvePow(prefix: string, difficulty: number, maxIterations = 100_000_000): string {
  if (!Number.isInteger(difficulty) || difficulty < 1 || difficulty > 32) throw new RegisterError("invalid PoW difficulty");
  for (let n = 0; n < maxIterations; n++) {
    const h = createHash("sha256").update(prefix + n.toString()).digest();
    if (countLeadingZeroBits(h) >= difficulty) return n.toString();
  }
  throw new RegisterError("PoW not solved within iteration cap");
}

export { buildAttestationMessage };

/** Read the owner wallet private key from a file. Refuses group/world-readable files. */
export function readWalletKey(file: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new RegisterError("wallet key file not readable");
  }
  if (!st.isFile()) throw new RegisterError("wallet key path is not a file");
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new RegisterError("wallet key file must not be group/world accessible (chmod 600)");
  }
  if (st.size > 4096) throw new RegisterError("wallet key file too large");
  const raw = fs.readFileSync(file, "utf8").trim();
  const key = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new RegisterError("wallet key file must contain a 32-byte hex private key");
  return key;
}

/**
 * Write the node file without ever replacing an existing one: data goes to a
 * temp file, then linkSync (fails with EEXIST if the target appeared meanwhile).
 */
export function writeNodeFile(file: string, data: StoredNode): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    const st = fs.statSync(dir);
    if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(tmp, 0o600);
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new RegisterError("node key file already exists; refusing to overwrite");
      // Filesystems without hard links: fall back to an exclusive create.
      fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readNodeFile(file: string): StoredNode {
  const st = fs.statSync(file);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
    throw new RegisterError("node key file must be mode 0600");
  }
  if (st.size > 64 * 1024) throw new RegisterError("node key file too large");
  const v = stripDangerousKeys(JSON.parse(fs.readFileSync(file, "utf8"))) as Partial<StoredNode>;
  if (typeof v.nodeKey !== "string" || !NODE_KEY_RE.test(v.nodeKey)) throw new RegisterError("node key file is invalid");
  if (typeof v.nodeId !== "string" || !UUIDISH.test(v.nodeId)) throw new RegisterError("node key file is invalid");
  return v as StoredNode;
}

/** Read a response body, aborting as soon as it exceeds `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const cl = res.headers.get("content-length");
  if (cl !== null && Number(cl) > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new RegisterError("response too large");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new RegisterError("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function postJson(fetchFn: typeof fetch, url: string, apiKey: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "X-DominusNode-Agent": "node-agent" },
    body: JSON.stringify(body),
  });
  const text = await readCapped(res, MAX_RESPONSE_BYTES);
  let parsed: unknown;
  try {
    parsed = stripDangerousKeys(JSON.parse(text));
  } catch {
    throw new RegisterError(`unexpected response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
      ? (parsed as { error: string }).error.slice(0, 200) : `HTTP ${res.status}`;
    throw new RegisterError(`registration request failed: ${msg}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RegisterError("unexpected response shape");
  return parsed as Record<string, unknown>;
}

export interface RegisterOptions {
  apiUrl: string;
  /** dn_live_ API key or wallet JWT of the owner (from env, never argv). */
  apiKey: string;
  walletKeyFile: string;
  outFile: string;
  fetchFn?: typeof fetch;
}

export async function registerNode(opts: RegisterOptions): Promise<StoredNode> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.apiUrl.replace(/\/+$/, "");
  if (fs.existsSync(opts.outFile)) throw new RegisterError("node key file already exists; refusing to overwrite");
  const walletKey = readWalletKey(opts.walletKeyFile);
  const wallet = new Wallet(walletKey);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const nodePubkey = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");

  const ch = await postJson(fetchFn, `${base}/v1/nodes/challenge`, opts.apiKey, { nodePubkey });
  const nonce = ch["nonce"];
  const text = ch["attestationText"];
  const version = ch["attestationVersion"];
  const pow = ch["powChallenge"] as { prefix?: unknown; difficulty?: unknown; challengeId?: unknown } | undefined;
  if (typeof nonce !== "string" || !HEX64.test(nonce)) throw new RegisterError("invalid challenge nonce");
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_ATTESTATION_TEXT) throw new RegisterError("invalid attestation text");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 100_000) throw new RegisterError("invalid attestation version");
  if (!pow || typeof pow.prefix !== "string" || pow.prefix.length > 256 || typeof pow.difficulty !== "number") {
    throw new RegisterError("invalid PoW challenge");
  }

  const message = buildAttestationMessage({
    wallet: wallet.address, nonce, attestationVersion: version, attestationText: text, nodePubkey,
  });
  // Never sign the server's string blindly: if it sent one, it must equal ours.
  if (ch["message"] !== undefined && ch["message"] !== message) {
    throw new RegisterError("server attestation message does not match local builder (wrong wallet linked or protocol mismatch)");
  }
  const powNonce = solvePow(pow.prefix, pow.difficulty);
  const walletSignature = await wallet.signMessage(message);
  if (!/^0x[0-9a-fA-F]{130}$/.test(walletSignature)) throw new RegisterError("signature has unexpected format");

  const reg = await postJson(fetchFn, `${base}/v1/nodes`, opts.apiKey, {
    nonce,
    walletSignature,
    nodePubkey,
    attestationVersion: version,
    pow: { ...(typeof pow.challengeId === "string" ? { challengeId: pow.challengeId } : {}), prefix: pow.prefix, nonce: powNonce },
  });
  const nodeId = reg["nodeId"];
  const nodeKey = reg["nodeKey"];
  if (typeof nodeId !== "string" || !UUIDISH.test(nodeId)) throw new RegisterError("invalid nodeId in response");
  if (typeof nodeKey !== "string" || !NODE_KEY_RE.test(nodeKey)) throw new RegisterError("invalid node key in response");

  const stored: StoredNode = {
    nodeId,
    nodeKey,
    nodePubkey,
    nodePrivateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    apiUrl: base,
    createdAt: new Date().toISOString(),
  };
  writeNodeFile(opts.outFile, stored);
  return stored;
}
