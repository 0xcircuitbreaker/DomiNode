import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { signDocument, signerFromPrivateKey, coordKeyFingerprint, ed25519PublicKeyHex, COORDINATOR_DOC_DOMAIN, type CoordinatorDocument } from "@dominusnode/shared";
import { acceptCoordinatorDocument, applyCoordinator, type FetchLike } from "./coordinator.js";
import { loadConfig, ConfigError } from "./config.js";

const { privateKey } = generateKeyPairSync("ed25519");
const pub = ed25519PublicKeyHex(createPublicKey(privateKey));
const signer = signerFromPrivateKey(privateKey, pub);
const fp = coordKeyFingerprint(pub);

function doc(over: Partial<CoordinatorDocument> = {}) {
  const p: CoordinatorDocument = {
    type: "dominusnode-coordinator", doc_version: 1,
    coordinator_keys: [{ alg: "ed25519", public_key: pub, fingerprint: fp }],
    hostnames: ["coord.example.org"], site_name: "Ex", api_url: "https://api.coord.example.org",
    gateway: { http_proxy: "p:8080", socks5_proxy: "p:1080", tunnel_url: "wss://relay.coord.example.org/v1/tunnel" },
    policy: { version: 1, sha256: "a".repeat(64), url: "https://x" }, pricing_url: "https://x",
    operator: { name: "Ex", contact: null, abuse_contact: null }, software_version: "0.1.0",
    issued_at: new Date().toISOString(), ...over,
  };
  return signDocument(COORDINATOR_DOC_DOMAIN, p, [signer]);
}

describe("acceptCoordinatorDocument", () => {
  it("prints the fingerprint and refuses without --trust", () => {
    const lines: string[] = [];
    expect(() => acceptCoordinatorDocument("coord.example.org", doc(), undefined, (l) => lines.push(l))).toThrow(/--trust sha256:/);
    expect(lines.join("\n")).toContain(fp);
  });
  it("refuses a mismatched fingerprint", () => {
    expect(() => acceptCoordinatorDocument("coord.example.org", doc(), `sha256:${"0".repeat(64)}`, () => {})).toThrow(/does not match/);
  });
  it("accepts a matching fingerprint and returns endpoints and pins", () => {
    const r = acceptCoordinatorDocument("coord.example.org", doc(), fp.toUpperCase(), () => {});
    expect(r.gatewayUrl).toBe("wss://relay.coord.example.org/v1/tunnel");
    expect(r.coordPins).toEqual([pub]);
  });
  it("refuses a domain the document does not list", () => {
    expect(() => acceptCoordinatorDocument("other.example.org", doc(), fp, () => {})).toThrow(/hostnames/);
  });
  it("refuses tampered documents", () => {
    const d = doc();
    d.payload.api_url = "https://evil.example";
    expect(() => acceptCoordinatorDocument("coord.example.org", d, fp, () => {})).toThrow(ConfigError);
  });
  it("refuses non-TLS endpoints", () => {
    expect(() => acceptCoordinatorDocument("coord.example.org", doc({ api_url: "http://api.coord.example.org" }), fp, () => {})).toThrow(/https/);
  });
});

describe("applyCoordinator", () => {
  const fetchOk: FetchLike = async (url, init) => {
    expect(url).toBe("https://coord.example.org/.well-known/dominusnode/coordinator.json");
    expect(init.redirect).toBe("error");
    return { ok: true, status: 200, text: async () => JSON.stringify(doc()) };
  };
  it("is a no-op without DN_NODE_COORDINATOR (embedded defaults)", async () => {
    const cfg = loadConfig({ HOME: "/h" });
    expect(await applyCoordinator(cfg, { apiUrl: false, gatewayUrl: false }, () => {}, fetchOk)).toBe(cfg);
  });
  it("points the agent at the trusted coordinator", async () => {
    const cfg = loadConfig({ HOME: "/h", DN_NODE_COORDINATOR: "https://Coord.Example.org/", DN_NODE_TRUST: fp });
    const out = await applyCoordinator(cfg, { apiUrl: false, gatewayUrl: false }, () => {}, fetchOk);
    expect(out.apiUrl).toBe("https://api.coord.example.org/");
    expect(out.coordPins).toContain(pub);
  });
  it("fails closed on HTTP errors", async () => {
    const cfg = loadConfig({ HOME: "/h", DN_NODE_COORDINATOR: "coord.example.org", DN_NODE_TRUST: fp });
    await expect(applyCoordinator(cfg, { apiUrl: false, gatewayUrl: false }, () => {}, async () => ({ ok: false, status: 404, text: async () => "" }))).rejects.toThrow(/HTTP 404/);
  });
  it("rejects an invalid coordinator domain", () => {
    expect(() => loadConfig({ HOME: "/h", DN_NODE_COORDINATOR: "not a domain" })).toThrow(ConfigError);
  });
});

describe("review fixes", () => {
  const other = generateKeyPairSync("ed25519").privateKey;
  const otherPub = ed25519PublicKeyHex(createPublicKey(other));
  const otherFp = coordKeyFingerprint(otherPub);
  const withExtra = () => doc({ coordinator_keys: [{ alg: "ed25519", public_key: pub, fingerprint: fp }, { alg: "ed25519", public_key: otherPub, fingerprint: otherFp }] });
  const cfgFor = () => loadConfig({ HOME: "/h", DN_NODE_COORDINATOR: "coord.example.org", DN_NODE_TRUST: fp });

  it("pins only the confirmed signer, not unconfirmed extra keys", () => {
    const lines: string[] = [];
    const r = acceptCoordinatorDocument("coord.example.org", withExtra(), fp, (l) => lines.push(l));
    expect(r.coordPins).toEqual([pub]);
    expect(lines.join("\n")).toContain(otherFp);
  });
  it("pins extra keys confirmed through a comma-separated --trust", () => {
    const r = acceptCoordinatorDocument("coord.example.org", withExtra(), `${fp},${otherFp}`, () => {});
    expect(r.coordPins).toEqual([pub, otherPub]);
  });
  it("makes coordinator pins exclusive of the embedded official pins, keeping user pins", async () => {
    const userPin = "b".repeat(64);
    const cfg = loadConfig({ HOME: "/h", DN_NODE_COORDINATOR: "coord.example.org", DN_NODE_TRUST: fp, DN_NODE_COORD_PINS: userPin });
    const fetchDoc: FetchLike = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(doc()) });
    const out = await applyCoordinator(cfg, { apiUrl: false, gatewayUrl: false }, () => {}, fetchDoc);
    expect(out.coordPinsExclusive).toBe(true);
    expect([...out.coordPins].sort()).toEqual([pub, userPin].sort());
  });
  it("rejects an oversized Content-Length before reading the body", async () => {
    const text = vi.fn();
    const big: FetchLike = async () => ({ ok: true, status: 200, headers: new Headers({ "content-length": String(10 ** 9) }), text });
    await expect(applyCoordinator(cfgFor(), { apiUrl: false, gatewayUrl: false }, () => {}, big)).rejects.toThrow(/too large/);
    expect(text).not.toHaveBeenCalled();
  });
  it("stops reading a streamed body once it passes the cap", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); } });
    const endless: FetchLike = async () => ({ ok: true, status: 200, body });
    await expect(applyCoordinator(cfgFor(), { apiUrl: false, gatewayUrl: false }, () => {}, endless)).rejects.toThrow(/too large/);
    expect(pulled).toBeLessThan(10);
  });
  it("reads a normal streamed body", async () => {
    const ok: FetchLike = async () => new Response(JSON.stringify(doc()));
    const out = await applyCoordinator(cfgFor(), { apiUrl: false, gatewayUrl: false }, () => {}, ok);
    expect(out.gatewayUrl).toBe("wss://relay.coord.example.org/v1/tunnel");
  });
});
