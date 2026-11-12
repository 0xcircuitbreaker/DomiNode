/**
 * Federation documents (BOOTSTRAP_PLAN §1.3 F1, F6, F8; FEDERATION.md).
 *
 * A coordinator publishes signed JSON documents under /.well-known/dominusnode/:
 *   coordinator.json  identity: keys, hostnames, endpoints, policy hash, contacts
 *   policy.json       the active network policy, versioned and hashed
 *
 * Envelope: { payload, signatures: [{ alg: "ed25519", public_key, sig }] }.
 * Each signature covers `${domain}\n${canonicalJson(payload)}` where domain
 * separates document types (a policy signature can never verify as an
 * identity document, and neither can verify as a tunnel CHALLENGE).
 *
 * Nothing in here hardcodes a hostname: a coordinator may answer on several
 * domains (the `hostnames` list), and which keys count as "official" is
 * configuration supplied by the caller.
 */
import { createHash, type KeyObject } from "node:crypto";
import { canonicalJson, type NetworkPolicy } from "./policy.js";
import { ed25519PublicKeyFromHex, signEd25519, verifyEd25519 } from "./tunnel/auth-sig.js";

export const COORDINATOR_DOC_DOMAIN = "dominode-coordinator-v1";
export const POLICY_DOC_DOMAIN = "dominode-policy-v1";
export const COORDINATOR_DOC_PATH = "/.well-known/dominusnode/coordinator.json";
export const POLICY_DOC_PATH = "/.well-known/dominusnode/policy.json";
export const MAX_FEDERATION_DOC_BYTES = 300 * 1024;
/** Documents older than this (by issued_at) are stale unless the caller says otherwise. */
export const DEFAULT_DOC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_SIGNATURES = 8;

const HEX64 = /^[0-9a-f]{64}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export interface DocSignature {
  alg: "ed25519";
  public_key: string;
  sig: string;
}

export interface SignedDocument<T> {
  payload: T;
  signatures: DocSignature[];
}

export interface DocSigner {
  sign: (msg: Buffer) => string;
  publicKeyHex: string;
}

export interface CoordinatorKey {
  alg: "ed25519";
  public_key: string;
  fingerprint: string;
}

export interface CoordinatorDocument {
  type: "dominusnode-coordinator";
  doc_version: 1;
  coordinator_keys: CoordinatorKey[];
  hostnames: string[];
  site_name: string;
  api_url: string;
  gateway: { http_proxy: string; socks5_proxy: string; tunnel_url: string };
  policy: { version: number; sha256: string; url: string };
  pricing_url: string;
  operator: { name: string; contact: string | null; abuse_contact: string | null };
  software_version: string;
  issued_at: string;
}

export interface PolicyDocument {
  type: "dominusnode-policy";
  doc_version: 1;
  version: number;
  sha256: string;
  policy: NetworkPolicy;
  issued_at: string;
}

/** Fingerprint of a raw ed25519 public key: "sha256:" + hex SHA-256 of the 32 key bytes. */
export function coordKeyFingerprint(pubHex: string): string {
  if (!HEX64.test(pubHex)) throw new Error("public key must be 64 lowercase hex chars");
  return `sha256:${createHash("sha256").update(Buffer.from(pubHex, "hex")).digest("hex")}`;
}

/** Normalise user input ("SHA256:AB:CD..." / bare hex) to the canonical fingerprint form, or null. */
export function normalizeFingerprint(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/^sha256:/, "").replace(/[:\s]/g, "");
  return HEX64.test(s) ? `sha256:${s}` : null;
}

export function federationMessage(domain: string, payload: unknown): Buffer {
  return Buffer.from(`${domain}\n${canonicalJson(payload)}`, "utf8");
}

export function signDocument<T>(domain: string, payload: T, signers: readonly DocSigner[]): SignedDocument<T> {
  if (signers.length === 0) throw new Error("at least one signer is required");
  const msg = federationMessage(domain, payload);
  return {
    payload,
    signatures: signers.map((s) => ({ alg: "ed25519" as const, public_key: s.publicKeyHex, sig: s.sign(msg) })),
  };
}

export function signerFromPrivateKey(key: KeyObject, publicKeyHex: string): DocSigner {
  return { sign: (msg) => signEd25519(key, msg), publicKeyHex };
}

export interface VerifyOptions {
  now?: number;
  maxAgeMs?: number;
  /** If set, a signature must come from one of these keys (pins); otherwise any key the payload lists (TOFU). */
  trustedPubkeys?: readonly string[];
}

export type VerifyResult<T> =
  | { ok: true; payload: T; signerPublicKey: string; fingerprint: string }
  | { ok: false; reason: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Verify a signed document. A signature counts only if its key is listed in
 * the payload's own key set (`listedKeys`) AND, when pins are given, pinned.
 * Freshness is checked on payload.issued_at.
 */
export function verifySignedDocument<T>(
  domain: string,
  doc: unknown,
  listedKeys: (payload: Record<string, unknown>) => string[] | null,
  opts: VerifyOptions = {},
): VerifyResult<T> {
  if (!isObj(doc) || !isObj(doc.payload) || !Array.isArray(doc.signatures)) return { ok: false, reason: "malformed document" };
  if (doc.signatures.length === 0 || doc.signatures.length > MAX_SIGNATURES) return { ok: false, reason: "bad signature count" };
  const payload = doc.payload;
  const listed = listedKeys(payload);
  if (!listed || listed.length === 0) return { ok: false, reason: "payload lists no keys" };

  const now = opts.now ?? Date.now();
  const issued = typeof payload.issued_at === "string" ? Date.parse(payload.issued_at) : NaN;
  if (!Number.isFinite(issued)) return { ok: false, reason: "missing issued_at" };
  if (issued > now + MAX_CLOCK_SKEW_MS) return { ok: false, reason: "issued_at is in the future" };
  if (now - issued > (opts.maxAgeMs ?? DEFAULT_DOC_MAX_AGE_MS)) return { ok: false, reason: "document is stale" };

  const pins = opts.trustedPubkeys ? new Set(opts.trustedPubkeys.map((p) => p.toLowerCase())) : null;
  const msg = federationMessage(domain, payload);
  for (const s of doc.signatures) {
    if (!isObj(s) || s.alg !== "ed25519" || typeof s.public_key !== "string") continue;
    const pub = s.public_key;
    if (!listed.includes(pub)) continue;
    if (pins && !pins.has(pub)) continue;
    if (verifyEd25519(pub, msg, s.sig)) {
      return { ok: true, payload: payload as T, signerPublicKey: pub, fingerprint: coordKeyFingerprint(pub) };
    }
  }
  return { ok: false, reason: pins ? "no valid signature from a trusted key" : "no valid signature" };
}

function coordinatorKeys(p: Record<string, unknown>): string[] | null {
  if (p.type !== "dominusnode-coordinator" || p.doc_version !== 1) return null;
  if (!Array.isArray(p.coordinator_keys) || p.coordinator_keys.length > 16) return null;
  const out: string[] = [];
  for (const k of p.coordinator_keys) {
    if (!isObj(k) || k.alg !== "ed25519" || typeof k.public_key !== "string" || !HEX64.test(k.public_key)) return null;
    if (k.fingerprint !== coordKeyFingerprint(k.public_key)) return null;
    out.push(k.public_key);
  }
  if (!Array.isArray(p.hostnames) || p.hostnames.length === 0 || p.hostnames.length > 32) return null;
  if (!p.hostnames.every((h) => typeof h === "string" && HOST_RE.test(h))) return null;
  if (!isObj(p.gateway) || typeof p.gateway.tunnel_url !== "string" || typeof p.api_url !== "string") return null;
  return out;
}

export function verifyCoordinatorDocument(doc: unknown, opts: VerifyOptions = {}): VerifyResult<CoordinatorDocument> {
  return verifySignedDocument<CoordinatorDocument>(COORDINATOR_DOC_DOMAIN, doc, coordinatorKeys, opts);
}

/**
 * Verify a policy document against the coordinator keys (taken from a verified
 * coordinator document or pins) and check the hash matches the body.
 */
export function verifyPolicyDocument(doc: unknown, coordinatorPubkeys: readonly string[], opts: VerifyOptions = {}): VerifyResult<PolicyDocument> {
  const keys = coordinatorPubkeys.map((k) => k.toLowerCase());
  // A policy file is a durable versioned artifact (version + sha256 pin the
  // content), so it does not go stale unless the caller asks for a max age.
  const r = verifySignedDocument<PolicyDocument>(POLICY_DOC_DOMAIN, doc, (p) => {
    if (p.type !== "dominusnode-policy" || p.doc_version !== 1 || !isObj(p.policy)) return null;
    return keys;
  }, { ...opts, maxAgeMs: opts.maxAgeMs ?? Number.POSITIVE_INFINITY, trustedPubkeys: keys });
  if (!r.ok) return r;
  const sha = createHash("sha256").update(canonicalJson(r.payload.policy), "utf8").digest("hex");
  if (sha !== r.payload.sha256) return { ok: false, reason: "policy hash mismatch" };
  return r;
}

export function buildPolicyDocument(version: number, policy: NetworkPolicy, issuedAt: Date = new Date()): PolicyDocument {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error("policy version must be a positive integer");
  return {
    type: "dominusnode-policy",
    doc_version: 1,
    version,
    sha256: createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex"),
    policy,
    issued_at: issuedAt.toISOString(),
  };
}

/** Parse a comma list of hostnames (lowercased, deduped, validated). Throws on junk. */
export function parseHostnameList(raw: string): string[] {
  const out = [...new Set(raw.split(",").map((h) => h.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))];
  for (const h of out) if (!HOST_RE.test(h)) throw new Error(`invalid hostname: ${h.slice(0, 64)}`);
  return out;
}

/** Parse a comma list of ed25519 public keys (hex, lowercased, deduped). Throws on junk. */
export function parsePubkeyList(raw: string | undefined): string[] {
  const out = [...new Set((raw ?? "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean))];
  for (const p of out) if (!HEX64.test(p)) throw new Error(`invalid ed25519 public key: ${p.slice(0, 16)}...`);
  return out;
}

// ── F8: fork branding ────────────────────────────────────────────────────────

export const OFFICIAL_SITE_NAME = "Dominus Node";
export const OFFICIAL_OPERATOR_NAME = "Daedalus Development Group";
export const OFFICIAL_CONTACT = "mailto:0xcircuitbreaker@protonmail.com";
const GENERIC_SITE_NAME = "DominusNode-compatible relay";
const GENERIC_OPERATOR_NAME = "Independent operator";
const RESERVED_NAME_RE = /daedalus|\bddg\b|dominus\s*node\s*official/i;

export interface Branding {
  official: boolean;
  siteName: string;
  operatorName: string;
  contact: string | null;
  abuseContact: string | null;
}

/**
 * Branding for this coordinator. The official DDG names and default contact
 * appear only when the coordinator's key is one of the official pins
 * (OFFICIAL_COORD_PUBKEYS). Forks get neutral defaults, and a configured name
 * that claims the DDG operator is replaced rather than shown.
 */
export function resolveBranding(env: NodeJS.ProcessEnv, coordPubkeys: readonly string[]): Branding {
  const official = parsePubkeyList(env["OFFICIAL_COORD_PUBKEYS"]);
  const isOfficial = coordPubkeys.some((k) => official.includes(k.toLowerCase()));
  const clean = (v: string | undefined, max: number): string | null => {
    const s = (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
    return s || null;
  };
  let siteName = clean(env["SITE_NAME"], 64) ?? (isOfficial ? OFFICIAL_SITE_NAME : GENERIC_SITE_NAME);
  let operatorName = clean(env["OPERATOR_NAME"], 128) ?? (isOfficial ? OFFICIAL_OPERATOR_NAME : GENERIC_OPERATOR_NAME);
  if (!isOfficial) {
    if (RESERVED_NAME_RE.test(siteName)) siteName = GENERIC_SITE_NAME;
    if (RESERVED_NAME_RE.test(operatorName)) operatorName = GENERIC_OPERATOR_NAME;
  }
  const contact = clean(env["OPERATOR_CONTACT"], 256) ?? (isOfficial ? OFFICIAL_CONTACT : null);
  const abuseContact = clean(env["ABUSE_CONTACT"], 256) ?? contact;
  return { official: isOfficial, siteName, operatorName, contact, abuseContact };
}

export function hasPublicKey(pubHex: string): boolean {
  return ed25519PublicKeyFromHex(pubHex) !== null;
}
