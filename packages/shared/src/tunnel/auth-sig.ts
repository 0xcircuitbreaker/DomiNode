/**
 * Tunnel handshake signatures (DESIGN.md §2.4, commit 20).
 *
 * CHALLENGE: the coordinator signs
 *   "dominode-challenge-v1" || nonce(32) || u64be(policyVersion) || u64be(serverTime) || u8(binding)
 * with its ed25519 key; nodes verify against a pinned public-key list.
 *
 * AUTH: the node signs
 *   "dominode-tunnel-v1" || nonce(32) || nodeId(utf8, 36) || exporter(32 | empty)
 * with the ed25519 key whose public half was stored at registration.
 * `exporter` is the TLS keying-material exporter of the connection (RFC 5705,
 * label EXPORTER_LABEL) when both ends see the same TLS session ("tls-exporter").
 * When the gateway sits behind a TLS-terminating proxy it cannot see the node's
 * TLS session, so it announces binding "none" in the (signed) CHALLENGE and
 * the AUTH signature binds to the single-use nonce only.
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const CHALLENGE_DOMAIN = "dominode-challenge-v1";
export const AUTH_DOMAIN = "dominode-tunnel-v1";
export const EXPORTER_LABEL = "EXPORTER-dominode-tunnel-v1";
export const EXPORTER_LENGTH = 32;
export type ChannelBinding = "tls-exporter" | "none";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** DER SPKI prefix for a raw 32-byte ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function u64(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid integer");
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

export function challengeMessage(nonceHex: string, policyVersion: number, serverTime: number, binding: ChannelBinding): Buffer {
  if (!HEX64.test(nonceHex)) throw new Error("invalid nonce");
  return Buffer.concat([
    Buffer.from(CHALLENGE_DOMAIN, "utf8"), Buffer.from(nonceHex, "hex"), u64(policyVersion), u64(serverTime),
    Buffer.from([binding === "tls-exporter" ? 1 : 0]),
  ]);
}

export function authMessage(nonceHex: string, nodeId: string, exporter: Buffer | null): Buffer {
  if (!HEX64.test(nonceHex)) throw new Error("invalid nonce");
  if (!UUID_RE.test(nodeId)) throw new Error("invalid nodeId");
  if (exporter && exporter.length !== EXPORTER_LENGTH) throw new Error("invalid exporter");
  return Buffer.concat([Buffer.from(AUTH_DOMAIN, "utf8"), Buffer.from(nonceHex, "hex"), Buffer.from(nodeId, "utf8"), exporter ?? Buffer.alloc(0)]);
}

/** Raw 32-byte ed25519 public key (hex) -> KeyObject; null when malformed. */
export function ed25519PublicKeyFromHex(hex: string): KeyObject | null {
  if (typeof hex !== "string" || !HEX64.test(hex)) return null;
  try {
    return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
  } catch {
    return null;
  }
}

export function ed25519PublicKeyHex(key: KeyObject): string {
  return (key.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
}

/** PEM (pkcs8) ed25519 private key; throws unless it is ed25519. */
export function loadEd25519PrivateKey(pem: string): KeyObject {
  const k = createPrivateKey({ key: pem, format: "pem" });
  if (k.asymmetricKeyType !== "ed25519") throw new Error("key is not ed25519");
  return k;
}

export function signEd25519(key: KeyObject, msg: Buffer): string {
  return sign(null, msg, key).toString("hex");
}

/** Constant-format verify: false on any malformed input. */
export function verifyEd25519(pubHex: string, msg: Buffer, sigHex: unknown): boolean {
  if (typeof sigHex !== "string" || !HEX128.test(sigHex)) return false;
  const pub = ed25519PublicKeyFromHex(pubHex);
  if (!pub) return false;
  try {
    return verify(null, msg, pub, Buffer.from(sigHex, "hex"));
  } catch {
    return false;
  }
}
