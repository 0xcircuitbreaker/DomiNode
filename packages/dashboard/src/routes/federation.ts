import { Router } from "express";
import type { Request, Response } from "express";
import { readFileSync, statSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import {
  createLogger,
  getPublicProxyPorts,
  policyRepo,
  loadEd25519PrivateKey,
  ed25519PublicKeyHex,
  signerFromPrivateKey,
  signDocument,
  coordKeyFingerprint,
  parseHostnameList,
  parsePubkeyList,
  resolveBranding,
  buildPolicyDocument,
  COORDINATOR_DOC_DOMAIN,
  COORDINATOR_DOC_PATH,
  POLICY_DOC_DOMAIN,
  POLICY_DOC_PATH,
  type CoordinatorDocument,
  type DocSigner,
  type ActivePolicy,
} from "@dominusnode/shared";

/**
 * F1 + F6 (FEDERATION.md): signed coordinator identity and policy documents.
 * Signed with the same ed25519 key the gateway uses for tunnel CHALLENGEs
 * (COORD_SIGNING_KEY_FILE), under a different signature domain.
 */
const log = createLogger("api:federation");
const MAX_KEY_FILE_BYTES = 16 * 1024;
const CACHE_MS = 5 * 60 * 1000;

export const SOFTWARE_VERSION = "0.1.0";

export function loadDocSigner(env: NodeJS.ProcessEnv, read: (p: string) => string = (p) => {
  const st = statSync(p);
  if (!st.isFile() || st.size > MAX_KEY_FILE_BYTES) throw new Error("not a regular key file");
  return readFileSync(p, "utf8");
}): DocSigner | null {
  const path = (env["COORD_SIGNING_KEY_FILE"] ?? "").trim();
  if (!path) return null;
  try {
    const key = loadEd25519PrivateKey(read(path));
    return signerFromPrivateKey(key, ed25519PublicKeyHex(createPublicKey(key)));
  } catch {
    log.error("COORD_SIGNING_KEY_FILE unusable; federation documents disabled");
    return null;
  }
}

/** Build the unsigned coordinator payload from env + the active policy. Pure. */
export function buildCoordinatorPayload(
  env: NodeJS.ProcessEnv,
  signerPub: string,
  policy: Pick<ActivePolicy, "version" | "sha256">,
  issuedAt: Date = new Date(),
): CoordinatorDocument {
  const apiUrl = (env["APP_URL"] ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]/.test(apiUrl)) throw new Error("APP_URL must be an https:// URL for the coordinator document (node agents refuse http)");
  const hostRaw = env["COORDINATOR_HOSTNAMES"] ?? env["DOMINUSNODE_DOMAIN"] ?? new URL(apiUrl).hostname;
  const hostnames = parseHostnameList(hostRaw);
  if (hostnames.length === 0) throw new Error("COORDINATOR_HOSTNAMES is empty");
  const proxyHost = env["PROXY_PUBLIC_HOST"] ?? `proxy.${hostnames[0]}`;
  const tunnelUrl = env["COORD_TUNNEL_URL"] ?? `wss://relay.${hostnames[0]}/v1/tunnel`;
  if (!tunnelUrl.startsWith("wss://")) throw new Error("COORD_TUNNEL_URL must use wss://");
  const pubs = [signerPub, ...parsePubkeyList(env["COORD_ADDITIONAL_PUBKEYS"]).filter((k) => k !== signerPub)];
  const branding = resolveBranding(env, [signerPub]);
  const ports = getPublicProxyPorts(env);
  return {
    type: "dominusnode-coordinator",
    doc_version: 1,
    coordinator_keys: pubs.map((k) => ({ alg: "ed25519" as const, public_key: k, fingerprint: coordKeyFingerprint(k) })),
    hostnames,
    site_name: branding.siteName,
    api_url: apiUrl,
    gateway: {
      // TLS listeners first: agents should send credentials only over TLS.
      ...(ports.tls !== null ? { https_proxy: `${proxyHost}:${ports.tls}` } : {}),
      ...(ports.socks5Tls !== null ? { socks5_tls_proxy: `${proxyHost}:${ports.socks5Tls}` } : {}),
      http_proxy: `${proxyHost}:${env["PROXY_HTTP_PORT"] ?? ports.http}`,
      socks5_proxy: `${proxyHost}:${ports.socks5}`,
      tunnel_url: tunnelUrl,
    },
    policy: { version: policy.version, sha256: policy.sha256, url: `${apiUrl}${POLICY_DOC_PATH}` },
    pricing_url: `${apiUrl}/v1/network/pricing`,
    operator: { name: branding.operatorName, contact: branding.contact, abuse_contact: branding.abuseContact },
    software_version: SOFTWARE_VERSION,
    issued_at: issuedAt.toISOString(),
  };
}

export function createFederationRouter(env: NodeJS.ProcessEnv = process.env, signer: DocSigner | null = loadDocSigner(env), getPolicy: () => Promise<ActivePolicy> = () => policyRepo.getActivePolicy()): Router {
  const router = Router();
  // Both documents are built from one policy read and cached under one
  // timestamp, so coordinator.json never advertises a policy hash that
  // policy.json does not serve.
  let cache: { at: number; coordinator: string; policy: string } | null = null;

  async function documents(): Promise<{ coordinator: string; policy: string }> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache;
    const p = await getPolicy();
    const built = {
      at: Date.now(),
      coordinator: JSON.stringify(signDocument(COORDINATOR_DOC_DOMAIN, buildCoordinatorPayload(env, signer!.publicKeyHex, p), [signer!])),
      policy: JSON.stringify(signDocument(POLICY_DOC_DOMAIN, buildPolicyDocument(p.version, p.body), [signer!])),
    };
    cache = built;
    return built;
  }

  async function serve(res: Response, name: "coordinator" | "policy"): Promise<void> {
    if (!signer) {
      res.status(503).json({ error: "federation documents are not configured on this coordinator" });
      return;
    }
    let body: string;
    try {
      body = (await documents())[name];
    } catch (err) {
      log.error("federation document build failed", { name, error: err instanceof Error ? err.message : String(err) });
      res.status(503).json({ error: "document unavailable" });
      return;
    }
    res.set("Cache-Control", "public, max-age=300").type("application/json").send(body);
  }

  router.get(COORDINATOR_DOC_PATH, (_req: Request, res: Response) => {
    void serve(res, "coordinator");
  });
  router.get(POLICY_DOC_PATH, (_req: Request, res: Response) => {
    void serve(res, "policy");
  });
  return router;
}
