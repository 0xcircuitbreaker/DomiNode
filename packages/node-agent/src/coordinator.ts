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

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text?(): Promise<string>;
}
export type FetchLike = (url: string, init: { redirect: "error"; signal: AbortSignal }) => Promise<FetchResponseLike>;

/** Read a response body, aborting as soon as it exceeds `max` bytes. */
async function readCapped(res: FetchResponseLike, max: number, ctl: AbortController): Promise<string> {
  const len = res.headers?.get("content-length");
  if (len != null && /^\d+$/.test(len.trim()) && Number(len) > max) {
    ctl.abort();
    throw new ConfigError("coordinator document too large");
  }
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => {});
        ctl.abort();
        throw new ConfigError("coordinator document too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString("utf8");
  }
  if (!res.text) throw new ConfigError("coordinator document could not be read");
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > max) throw new ConfigError("coordinator document too large");
  return text;
}

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
    const text = await readCapped(res, MAX_FEDERATION_DOC_BYTES, ctl);
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

  const extra = p.coordinator_keys.filter((k) => k.public_key.toLowerCase() !== v.signerPublicKey);
  for (const k of extra) log(`additional coordinator key (trusted only if listed in --trust): ${k.fingerprint}`);

  const wanted = new Set<string>();
  for (const part of (trust ?? "").split(",").map((t) => t.trim()).filter(Boolean)) {
    const fp = normalizeFingerprint(part);
    if (!fp) throw new ConfigError("DN_NODE_TRUST / --trust must be sha256:<64 hex> fingerprints, comma-separated");
    wanted.add(fp);
  }
  if (!wanted.has(v.fingerprint)) {
    throw new ConfigError(
      wanted.size > 0
        ? "coordinator fingerprint does not match --trust; refusing to connect"
        : `not trusted yet: verify the fingerprint out of band, then rerun with --trust ${v.fingerprint}`,
    );
  }
  // Only keys the operator confirmed by fingerprint become tunnel pins.
  const confirmed = [v.signerPublicKey, ...extra.filter((k) => wanted.has(k.fingerprint)).map((k) => k.public_key.toLowerCase())];

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
    coordPins: [...new Set(confirmed)],
    document: p,
  };
}

/**
 * If cfg.coordinator is set, resolve it and return a config pointed at that
 * coordinator (explicit DN_NODE_API_URL / DN_NODE_GATEWAY_URL still win).
 * The tunnel pins become exclusive: the confirmed coordinator key(s) plus any
 * pins the user set in DN_NODE_COORD_PINS, without the embedded official pins.
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
    coordPinsExclusive: true,
  };
}
