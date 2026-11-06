import type { HttpClient } from "../http.js";
import type { DominusNodeConfig } from "../types.js";
import { DEFAULT_PROXY_HOST, DEFAULT_HTTP_PROXY_PORT, DEFAULT_SOCKS5_PROXY_PORT } from "../constants.js";
import { AuthenticationError, invalidArg } from "../errors.js";
import { buildProxyUsername, proxyFetch, type ProxyRoutingOptions, type ProxyFetchOptions, type ProxyFetchResponse } from "../proxy-fetch.js";
import type { LookupAll } from "../ssrf.js";
import { validateApiKey } from "./auth.js";

export interface ProxyUrlOptions extends ProxyRoutingOptions {
  /** "http" (default; CONNECT for https targets) or "socks5". */
  protocol?: "http" | "socks5";
  /** Override the connected API key. */
  apiKey?: string;
}

export interface ProxyHealth {
  status: string;
  activeSessions: number;
  uptimeSeconds: number;
}

function validPort(p: unknown, name: string): number {
  if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535) throw invalidArg(`${name} must be a TCP port`);
  return p;
}

/**
 * Proxy gateway helpers. The API key goes in the PASSWORD; routing flags go in the
 * USERNAME, hyphen-joined (country-US-class-residential-session-abc123-allowhttp-1).
 */
export class ProxyResource {
  readonly #host: string;
  readonly #httpPort: number;
  readonly #socksPort: number;
  #lookup: LookupAll | undefined;

  constructor(private http: HttpClient, config: DominusNodeConfig, private apiKey: () => string | null) {
    const host = config.proxyHost ?? DEFAULT_PROXY_HOST;
    if (typeof host !== "string" || !/^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:.]+\]$/.test(host)) throw invalidArg("proxyHost contains invalid characters");
    this.#host = host;
    this.#httpPort = validPort(config.httpProxyPort ?? DEFAULT_HTTP_PROXY_PORT, "httpProxyPort");
    this.#socksPort = validPort(config.socks5ProxyPort ?? DEFAULT_SOCKS5_PROXY_PORT, "socks5ProxyPort");
  }

  /** @internal Inject a DNS resolver (tests). */
  setLookup(lookup: LookupAll | undefined): void { this.#lookup = lookup; }

  #key(override?: string): string {
    const k = override ?? this.apiKey();
    if (!k) throw new AuthenticationError("proxy access needs an API key: call connectWithKey() or pass apiKey");
    return validateApiKey(k);
  }

  /** Gateway username for the given routing flags ("relay" when none). */
  buildUsername(opts: ProxyRoutingOptions = {}): string {
    return buildProxyUsername(opts);
  }

  /** e.g. http://country-US-class-dc:dn_live_...@proxy.dominusnode.com:8080. The result CONTAINS the key: do not log it. */
  buildUrl(opts: ProxyUrlOptions = {}): string {
    const protocol = opts.protocol ?? "http";
    if (protocol !== "http" && protocol !== "socks5") throw invalidArg("protocol must be http or socks5");
    const port = protocol === "socks5" ? this.#socksPort : this.#httpPort;
    const user = buildProxyUsername(opts);
    return `${protocol}://${encodeURIComponent(user)}:${encodeURIComponent(this.#key(opts.apiKey))}@${this.#host}:${port}`;
  }

  /**
   * GET/HEAD a URL through the relay. Ports 80/443 only; private/local targets and names that
   * resolve to private addresses are refused; redirects are returned, not followed; body capped
   * at 10 MB; http:// needs allowHttp.
   */
  async fetch(url: string, opts: ProxyFetchOptions & { apiKey?: string } = {}): Promise<ProxyFetchResponse> {
    const { apiKey, ...rest } = opts;
    return proxyFetch({ host: this.#host.replace(/^\[|\]$/g, ""), port: this.#httpPort, lookup: this.#lookup }, this.#key(apiKey), url, rest);
  }

  /** GET /api/proxy/health (no auth). */
  async getHealth(): Promise<ProxyHealth> {
    return this.http.get("/api/proxy/health", "none");
  }

  /** GET /api/proxy/config */
  async getConfig(): Promise<Record<string, unknown>> {
    return this.http.get("/api/proxy/config");
  }
}
