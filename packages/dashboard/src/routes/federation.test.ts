import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { DEFAULT_POLICY, policySha256, verifyCoordinatorDocument, verifyPolicyDocument } from "@dominusnode/shared";
import { createFederationRouter, loadDocSigner, buildCoordinatorPayload } from "./federation.js";

const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const env = {
  APP_URL: "https://dominusnode.com",
  COORDINATOR_HOSTNAMES: "dominusnode.com,dominusnode.example.org",
  COORD_SIGNING_KEY_FILE: "/k",
};
const policy = { version: 2, sha256: policySha256(DEFAULT_POLICY), body: structuredClone(DEFAULT_POLICY), createdAt: null };

async function get(router: express.Router, path: string) {
  const app = express();
  app.use(router);
  const srv = app.listen(0);
  try {
    const { port } = srv.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: (await r.json()) as unknown };
  } finally {
    srv.close();
  }
}

describe("federation documents", () => {
  const signer = loadDocSigner(env, () => pem)!;

  it("serves a verifiable coordinator document listing every hostname", async () => {
    const r = await get(createFederationRouter(env, signer, vi.fn().mockResolvedValue(policy)), "/.well-known/dominusnode/coordinator.json");
    expect(r.status).toBe(200);
    const v = verifyCoordinatorDocument(r.body);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.hostnames).toEqual(["dominusnode.com", "dominusnode.example.org"]);
      expect(v.payload.policy.sha256).toBe(policy.sha256);
      expect(v.payload.operator.contact).toBeNull();
    }
  });

  it("serves a signed policy document", async () => {
    const r = await get(createFederationRouter(env, signer, vi.fn().mockResolvedValue(policy)), "/.well-known/dominusnode/policy.json");
    expect(verifyPolicyDocument(r.body, [signer.publicKeyHex]).ok).toBe(true);
  });

  it("returns 503 without a signing key", async () => {
    const r = await get(createFederationRouter(env, null, vi.fn()), "/.well-known/dominusnode/coordinator.json");
    expect(r.status).toBe(503);
  });

  it("uses official branding only for a pinned key", () => {
    expect(buildCoordinatorPayload({ ...env, OFFICIAL_COORD_PUBKEYS: signer.publicKeyHex }, signer.publicKeyHex, policy).operator.name).toMatch(/Daedalus/);
    expect(buildCoordinatorPayload(env, signer.publicKeyHex, policy).operator.name).not.toMatch(/Daedalus/);
  });

  it("advertises the TLS proxy listeners first when enabled", () => {
    const off = buildCoordinatorPayload(env, signer.publicKeyHex, policy).gateway;
    expect(off.https_proxy).toBeUndefined();
    const on = buildCoordinatorPayload({ ...env, PROXY_PUBLIC_HOST: "proxy.example.org", PROXY_PUBLIC_TLS_PORT: "8444", PROXY_PUBLIC_SOCKS5_TLS_PORT: "1443" }, signer.publicKeyHex, policy).gateway;
    expect(on.https_proxy).toBe("proxy.example.org:8444");
    expect(on.socks5_tls_proxy).toBe("proxy.example.org:1443");
    expect(Object.keys(on)[0]).toBe("https_proxy");
  });

  it("requires APP_URL", () => {
    expect(() => buildCoordinatorPayload({}, signer.publicKeyHex, policy)).toThrow(/APP_URL/);
  });

  it("rejects a non-https APP_URL", () => {
    expect(() => buildCoordinatorPayload({ ...env, APP_URL: "http://dominusnode.com" }, signer.publicKeyHex, policy)).toThrow(/https/);
  });

  it("keeps coordinator.json and policy.json on the same policy version", async () => {
    const p2 = { ...policy, version: 3 };
    const getPolicy = vi.fn().mockResolvedValueOnce(policy).mockResolvedValue(p2);
    const router = createFederationRouter(env, signer, getPolicy);
    const c = await get(router, "/.well-known/dominusnode/coordinator.json");
    const p = await get(router, "/.well-known/dominusnode/policy.json");
    expect(getPolicy).toHaveBeenCalledTimes(1);
    const cv = verifyCoordinatorDocument(c.body);
    const pv = verifyPolicyDocument(p.body, [signer.publicKeyHex]);
    expect(cv.ok && pv.ok && cv.payload.policy.version === pv.payload.version && cv.payload.policy.sha256 === pv.payload.sha256).toBe(true);
  });
});
