import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import {
  signDocument, signerFromPrivateKey, verifyCoordinatorDocument, verifyPolicyDocument, buildPolicyDocument,
  coordKeyFingerprint, normalizeFingerprint, resolveBranding, securityTxtContact, parseHostnameList, parsePubkeyList,
  COORDINATOR_DOC_DOMAIN, POLICY_DOC_DOMAIN, OFFICIAL_OPERATOR_NAME, OFFICIAL_CONTACT,
  type CoordinatorDocument,
} from "./federation.js";
import { ed25519PublicKeyHex } from "./tunnel/auth-sig.js";
import { DEFAULT_POLICY } from "./policy.js";

function newSigner() {
  const { privateKey } = generateKeyPairSync("ed25519");
  return signerFromPrivateKey(privateKey, ed25519PublicKeyHex(createPublicKey(privateKey)));
}

function payload(pub: string, issued = new Date()): CoordinatorDocument {
  return {
    type: "dominusnode-coordinator", doc_version: 1,
    coordinator_keys: [{ alg: "ed25519", public_key: pub, fingerprint: coordKeyFingerprint(pub) }],
    hostnames: ["dominusnode.com", "dominusnode.example.org"],
    site_name: "Test", api_url: "https://dominusnode.com",
    gateway: { http_proxy: "proxy.dominusnode.com:8080", socks5_proxy: "proxy.dominusnode.com:1080", tunnel_url: "wss://relay.dominusnode.com/v1/tunnel" },
    policy: { version: 1, sha256: "a".repeat(64), url: "https://dominusnode.com/.well-known/dominusnode/policy.json" },
    pricing_url: "https://dominusnode.com/v1/network/pricing",
    operator: { name: "Op", contact: null, abuse_contact: null },
    software_version: "0.1.0", issued_at: issued.toISOString(),
  };
}

describe("coordinator document", () => {
  const s = newSigner();
  it("verifies a self-signed document and reports the fingerprint", () => {
    const r = verifyCoordinatorDocument(signDocument(COORDINATOR_DOC_DOMAIN, payload(s.publicKeyHex), [s]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.fingerprint).toBe(coordKeyFingerprint(s.publicKeyHex));
  });
  it("rejects tampering", () => {
    const d = signDocument(COORDINATOR_DOC_DOMAIN, payload(s.publicKeyHex), [s]);
    d.payload.gateway.tunnel_url = "wss://evil.example/v1/tunnel";
    expect(verifyCoordinatorDocument(d).ok).toBe(false);
  });
  it("rejects a signature from a key the payload does not list", () => {
    const other = newSigner();
    expect(verifyCoordinatorDocument(signDocument(COORDINATOR_DOC_DOMAIN, payload(s.publicKeyHex), [other])).ok).toBe(false);
  });
  it("rejects a valid self-signature when pins require another key", () => {
    const d = signDocument(COORDINATOR_DOC_DOMAIN, payload(s.publicKeyHex), [s]);
    expect(verifyCoordinatorDocument(d, { trustedPubkeys: [newSigner().publicKeyHex] }).ok).toBe(false);
  });
  it("rejects stale and future documents", () => {
    const old = signDocument(COORDINATOR_DOC_DOMAIN, payload(s.publicKeyHex, new Date(Date.now() - 8 * 86400_000)), [s]);
    expect(verifyCoordinatorDocument(old)).toEqual({ ok: false, reason: "document is stale" });
    const fut = signDocument(COORDINATOR_DOC_DOMAIN, payload(s.publicKeyHex, new Date(Date.now() + 3600_000)), [s]);
    expect(verifyCoordinatorDocument(fut).ok).toBe(false);
  });
  it("does not accept a policy-domain signature as a coordinator document", () => {
    expect(verifyCoordinatorDocument(signDocument(POLICY_DOC_DOMAIN, payload(s.publicKeyHex), [s])).ok).toBe(false);
  });
  it("rejects a wrong fingerprint in the key list", () => {
    const p = payload(s.publicKeyHex);
    p.coordinator_keys[0].fingerprint = `sha256:${"0".repeat(64)}`;
    expect(verifyCoordinatorDocument(signDocument(COORDINATOR_DOC_DOMAIN, p, [s])).ok).toBe(false);
  });
});

describe("policy document", () => {
  const s = newSigner();
  it("round-trips and checks the signer", () => {
    const d = signDocument(POLICY_DOC_DOMAIN, buildPolicyDocument(4, structuredClone(DEFAULT_POLICY)), [s]);
    expect(verifyPolicyDocument(d, [s.publicKeyHex]).ok).toBe(true);
    expect(verifyPolicyDocument(d, [newSigner().publicKeyHex]).ok).toBe(false);
  });
  it("rejects a body that no longer matches its signed hash", () => {
    const doc = buildPolicyDocument(4, structuredClone(DEFAULT_POLICY));
    doc.policy.plaintext = "allow";
    const d = signDocument(POLICY_DOC_DOMAIN, doc, [s]);
    expect(verifyPolicyDocument(d, [s.publicKeyHex])).toEqual({ ok: false, reason: "policy hash mismatch" });
  });
});

describe("helpers", () => {
  it("normalizes fingerprints", () => {
    const fp = coordKeyFingerprint("ab".repeat(32));
    expect(normalizeFingerprint(fp.toUpperCase())).toBe(fp);
    expect(normalizeFingerprint("nope")).toBeNull();
  });
  it("parses hostname lists", () => {
    expect(parseHostnameList("DominusNode.com, dominusnode.example.org.,dominusnode.com")).toEqual(["dominusnode.com", "dominusnode.example.org"]);
    expect(() => parseHostnameList("bad host")).toThrow();
  });
});

describe("resolveBranding (F8)", () => {
  const pub = "cd".repeat(32);
  it("shows the official name and contact only for an official pin", () => {
    const b = resolveBranding({ OFFICIAL_COORD_PUBKEYS: pub }, [pub]);
    expect(b).toMatchObject({ official: true, operatorName: OFFICIAL_OPERATOR_NAME, contact: OFFICIAL_CONTACT });
  });
  it("forks get neutral defaults and no official contact", () => {
    const b = resolveBranding({}, [pub]);
    expect(b.official).toBe(false);
    expect(b.operatorName).not.toMatch(/Daedalus/);
    expect(b.contact).toBeNull();
  });
  it("forks cannot claim the DDG name, but can set their own", () => {
    expect(resolveBranding({ OPERATOR_NAME: "Daedalus Development Group" }, [pub]).operatorName).not.toMatch(/Daedalus/);
    const b = resolveBranding({ SITE_NAME: "Acme Relay", OPERATOR_NAME: "Acme", OPERATOR_CONTACT: "mailto:ops@acme.example", ABUSE_CONTACT: "mailto:abuse@acme.example" }, [pub]);
    expect(b).toMatchObject({ siteName: "Acme Relay", operatorName: "Acme", abuseContact: "mailto:abuse@acme.example" });
  });
});

describe("federation review fixes", () => {
  it("a signed policy file still verifies 30 days after export", () => {
    const s = newSigner();
    const issued = new Date("2026-01-01T00:00:00Z");
    const d = signDocument(POLICY_DOC_DOMAIN, buildPolicyDocument(4, DEFAULT_POLICY, issued), [s]);
    const later = issued.getTime() + 30 * 24 * 60 * 60 * 1000;
    expect(verifyPolicyDocument(d, [s.publicKeyHex], { now: later }).ok).toBe(true);
    expect(verifyPolicyDocument(d, [s.publicKeyHex.toUpperCase()], { now: later }).ok).toBe(true);
    expect(verifyPolicyDocument(d, [s.publicKeyHex], { now: later, maxAgeMs: 1000 }).ok).toBe(false);
  });
  it("parsePubkeyList rejects malformed entries instead of dropping them", () => {
    const k = "a".repeat(64);
    expect(parsePubkeyList(` ${k.toUpperCase()} ,${k}`)).toEqual([k]);
    expect(() => parsePubkeyList(`${k},abc`)).toThrow(/invalid/);
    expect(parsePubkeyList(undefined)).toEqual([]);
  });
});

describe("securityTxtContact", () => {
  it("turns a bare address into a mailto: URI and keeps URIs", () => {
    expect(securityTxtContact("ops@example.org")).toBe("mailto:ops@example.org");
    expect(securityTxtContact("mailto:ops@example.org")).toBe("mailto:ops@example.org");
    expect(securityTxtContact("https://example.org/security")).toBe("https://example.org/security");
  });
});
