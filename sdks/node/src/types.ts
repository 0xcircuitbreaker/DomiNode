/** Shared types. Resource-specific types live next to their resource. */

/** Server money value: exact integer µUSD string plus a 6-decimal USD string. 1 USD = 1,000,000 µUSD. */
export interface Money {
  musd: string;
  usd: string;
}

export interface DominusNodeConfig {
  /** API base URL (default https://api.dominusnode.com). */
  baseUrl?: string;
  /** Proxy gateway host for proxy.buildUrl()/proxy.fetch() (default proxy.dominusnode.com). */
  proxyHost?: string;
  httpProxyPort?: number;
  socks5ProxyPort?: number;
  /**
   * Talk TLS to the gateway (HTTPS proxy listener, PROXY_TLS_PORT): the API key in
   * Proxy-Authorization is encrypted on the wire. `true` uses port 8443 and the
   * system CA roots. Default (2.2+): on, port 8443 (self-hosted coordinators
   * usually publish 8444: pass `{ port: 8444 }`). Pass `false` for plaintext
   * 8080/1080 (local dev only; production gateways refuse credentials there).
   */
  gatewayTls?: boolean | GatewayTlsConfig;
  /** Connect immediately with an existing JWT pair (e.g. from walletAuth.verify()). */
  accessToken?: string;
  refreshToken?: string;
  /** Custom fetch implementation (tests, instrumentation). Must not follow redirects. */
  fetch?: typeof fetch;
}

export interface GatewayTlsConfig {
  /** HTTPS proxy port (default 8443). */
  port?: number;
  /** Extra CA (PEM) for a privately issued gateway certificate. Verification is never disabled. */
  ca?: string | Buffer;
  /** TLS server name when proxyHost is an IP literal. */
  servername?: string;
}

export interface User {
  id: string;
  email: string;
  wallet_address?: string | null;
  email_verified?: boolean;
}

/** Result of connectWithKey(). */
export interface ConnectResult {
  /**
   * True when the account has MFA enabled: /api/auth/verify-key refused to issue
   * a JWT. The API key is still kept and /v1 agent routes (network, nodes, credits,
   * payouts, session reports) work; JWT-only /api routes raise AuthenticationError.
   */
  mfaRequired: boolean;
  userId?: string;
}
