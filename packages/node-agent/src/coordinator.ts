/**
 * F2 (FEDERATION.md): join a coordinator by domain.
 *
 * DN_NODE_COORDINATOR=<domain> fetches https://<domain>/.well-known/dominusnode/coordinator.json,
 * verifies its ed25519 self-signature and freshness, checks the domain is one of
 * the document's hostnames, and prints the signing key fingerprint. The agent
 * refuses to continue unless DN_NODE_TRUST / --trust names that exact
 * fingerprint (trust on first use, with an explicit confirmation step).
 * Without DN_NODE_COORDINATOR the embedded official pins and URLs apply.
 */
import {
  COORDINATOR_DOC_PATH,
  MAX_FEDERATION_DOC_BYTES,
  normalizeFingerprint,
  verifyCoordinatorDocument,
  type CoordinatorDocument,
} from "@dominusnode/shared";
import { ConfigError, type AgentConfig } from "./config.js";

const FETCH_TIMEOUT_MS = 10_000;

export type FetchLike = (url: string, init: { redirect: "error"; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface ResolvedCoordinator {
  domain: string;
  fingerprint: string;
  apiUrl: string;
  gatewayUrl: string;
  coordPins: string[];
  document: CoordinatorDocument;
}

export async function fetchCoordinatorDocument(domain: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<unknown> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://${domain}${COORDINATOR_DOC_PATH}`, { redirect: "error", signal: ctl.signal });
    if (!res.ok) throw new ConfigError(`coordinator document fetch failed (HTTP ${res.status})`);
    const text = await res.text();
    if (Buffer.byteLength(text, "utf8") > MAX_FEDERATION_DOC_BYTES) throw new ConfigError("coordinator document too large");
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ConfigError("coordinator document is not JSON");
    }
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError("coordinator document could not be fetched");
  } finally {
    clearTimeout(timer);
  }
}

/** Verify a fetched document and apply the TOFU confirmation. Pure apart from `log`. */
export function acceptCoordinatorDocument(
  domain: string,
  doc: unknown,
  trust: string | undefined,
  log: (line: string) => void,
  now: number = Date.now(),
): ResolvedCoordinator {
  const v = verifyCoordinatorDocument(doc, { now });
  if (!v.ok) throw new ConfigError(`coordinator document rejected: ${v.reason}`);
  const p = v.payload;
  if (!p.hostnames.includes(domain)) throw new ConfigError("coordinator document does not list this domain in its hostnames");

  log(`coordinator ${domain} (${p.site_name}, operator: ${p.operator.name})`);
  log(`signing key fingerprint: ${v.fingerprint}`);

  const want = trust ? normalizeFingerprint(trust) : null;
  if (trust && !want) throw new ConfigError("DN_NODE_TRUST / --trust must be a sha256:<64 hex> fingerprint");
  if (want !== v.fingerprint) {
    throw new ConfigError(
      want
        ? "coordinator fingerprint does not match --trust; refusing to connect"
        : `not trusted yet: verify the fingerprint out of band, then rerun with --trust ${v.fingerprint}`,
    );
  }

  let api: URL;
  let gw: URL;
  try {
    api = new URL(p.api_url);
    gw = new URL(p.gateway.tunnel_url);
  } catch {
    throw new ConfigError("coordinator document has invalid URLs");
  }
  if (api.protocol !== "https:" || gw.protocol !== "wss:" || api.username || gw.username) {
    throw new ConfigError("coordinator document must use https:// and wss:// without credentials");
  }
  return {
    domain,
    fingerprint: v.fingerprint,
    apiUrl: api.toString(),
    gatewayUrl: gw.toString(),
    coordPins: p.coordinator_keys.map((k) => k.public_key),
    document: p,
  };
}

/**
 * If cfg.coordinator is set, resolve it and return a config pointed at that
 * coordinator (explicit DN_NODE_API_URL / DN_NODE_GATEWAY_URL still win).
 */
export async function applyCoordinator(
  cfg: AgentConfig,
  explicit: { apiUrl: boolean; gatewayUrl: boolean },
  log: (line: string) => void,
  fetchImpl?: FetchLike,
): Promise<AgentConfig> {
  if (!cfg.coordinator) return cfg;
  const doc = await fetchCoordinatorDocument(cfg.coordinator, fetchImpl);
  const r = acceptCoordinatorDocument(cfg.coordinator, doc, cfg.trust, log);
  return {
    ...cfg,
    apiUrl: explicit.apiUrl ? cfg.apiUrl : r.apiUrl,
    gatewayUrl: explicit.gatewayUrl ? cfg.gatewayUrl : r.gatewayUrl,
    coordPins: [...new Set([...cfg.coordPins, ...r.coordPins])],
  };
}
