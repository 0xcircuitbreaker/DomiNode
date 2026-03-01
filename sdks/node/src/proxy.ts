import type { HttpClient } from "./http.js";
import type { ProxyUrlOptions, ProxyHealth, ProxyConfig, DominusNodeConfig } from "./types.js";
import {
  DEFAULT_PROXY_HOST,
  DEFAULT_HTTP_PROXY_PORT,
  DEFAULT_SOCKS5_PROXY_PORT,
} from "./constants.js";

export interface ProxyHealthResponse {
  status: string;
  activeSessions: number;
  uptimeSeconds: number;
}

export interface ProxyStatusResponse {
  status: string;
  activeSessions: number;
  userActiveSessions: number;
  avgLatencyMs: number;
  providers: Array<{
    name: string;
    state: string;
    consecutiveFailures: number;
    totalRequests: number;
    totalErrors: number;
    avgLatencyMs: number;
    fallbackOnly: boolean;
  }>;
  endpoints: {
    http: string;
    socks5: string;
  };
  supportedCountries: string[];
  uptimeSeconds: number;
}

export class ProxyResource {
  private proxyHost: string;
  private httpPort: number;
  private socks5Port: number;

  constructor(private http: HttpClient, config: DominusNodeConfig) {
    this.proxyHost = config.proxyHost ?? DEFAULT_PROXY_HOST;
    // Validate proxyHost to prevent URL injection via crafted hostnames
    if (/[\s\/\\@?#]/.test(this.proxyHost)) {
      throw new Error("proxyHost contains invalid characters");
    }
    this.httpPort = config.httpProxyPort ?? DEFAULT_HTTP_PROXY_PORT;
    this.socks5Port = config.socks5ProxyPort ?? DEFAULT_SOCKS5_PROXY_PORT;
  }

  /**
   * Build a proxy URL string for use with HTTP clients.
   *
   * The returned URL includes authentication via the username field.
   * Geo-targeting and sticky sessions are encoded in the username portion
   * following Dominus Node proxy conventions.
   *
   * @param apiKey - The API key to authenticate proxy requests.
   * @param opts   - Optional targeting parameters (protocol, country, etc.).
   * @returns A fully-formed proxy URL string.
   *
   * @example
   * ```ts
   * const url = client.proxy.buildUrl("dn_live_abc123");
   * // => "http://user:dn_live_abc123@proxy.dominusnode.com:8080"
   *
   * const socksUrl = client.proxy.buildUrl("dn_live_abc123", { protocol: "socks5", country: "US" });
   * // => "socks5://user-country-US:dn_live_abc123@proxy.dominusnode.com:1080"
   * ```
   */
  buildUrl(apiKey: string, opts?: ProxyUrlOptions): string {
    const protocol = opts?.protocol ?? "http";
    const port = protocol === "socks5" ? this.socks5Port : this.httpPort;

    // Build username with geo-targeting parameters (URL-encoded to prevent injection)
    const userParts: string[] = ["user"];
    if (opts?.country) userParts.push(`country-${encodeURIComponent(opts.country)}`);
    if (opts?.state) userParts.push(`state-${encodeURIComponent(opts.state)}`);
    if (opts?.city) userParts.push(`city-${encodeURIComponent(opts.city)}`);
    if (opts?.asn) userParts.push(`asn-${encodeURIComponent(String(opts.asn))}`);
    if (opts?.sessionId) userParts.push(`session-${encodeURIComponent(opts.sessionId)}`);

    const username = userParts.join("-");

    return `${protocol}://${username}:${encodeURIComponent(apiKey)}@${this.proxyHost}:${port}`;
  }

  /** Get public proxy health status (does not require authentication). */
  async getHealth(): Promise<ProxyHealthResponse> {
    return this.http.get("/api/proxy/health", false);
  }

  /** Get detailed proxy status including provider info (requires authentication). */
  async getStatus(): Promise<ProxyStatusResponse> {
    return this.http.get("/api/proxy/status");
  }

  /** Get proxy server configuration (requires authentication). */
  async getConfig(): Promise<ProxyConfig> {
    return this.http.get("/api/proxy/config");
  }
}
