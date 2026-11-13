import * as fs from "node:fs";

export interface McpConfig {
  apiKey: string | null;
  apiUrl: string;
  proxyHost: string;
  httpProxyPort: number;
  socks5ProxyPort: number;
  /**
   * TLS to the gateway (HTTPS proxy listener). Default https://<proxyHost>:8443; override with
   * DOMINUSNODE_PROXY_URL=https://host:port. null only with DOMINUSNODE_PROXY_INSECURE=1, in which
   * case fetches use the plaintext httpProxyPort (API key sent in clear).
   */
  proxyTls?: { port: number; ca?: Buffer } | null;
  fetchTimeoutMs: number;
  fetchMaxResponseBytes: number;
  mcpAgentSecret: string;
  /** Path to a 0600 file holding the owner wallet private key (node registration only). */
  walletKeyFile: string | null;
  /**
   * Optional 0600 key file of the CURRENT payout wallet, used only to co-sign a
   * payout-wallet change when it differs from the linked wallet.
   */
  payoutWalletKeyFile?: string | null;
  /** Where node_register writes the node credential file (mode 0600). */
  nodeKeyFile: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function parseConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const apiKey = env["DOMINUSNODE_API_KEY"] ?? null;

  // Validate format if provided, but allow null for bootstrap mode
  if (apiKey !== null && !apiKey.startsWith("dn_live_")) {
    throw new ConfigError("DOMINUSNODE_API_KEY must start with 'dn_live_'");
  }

  const apiUrl = (env["DOMINUSNODE_API_URL"] ?? "https://api.dominusnode.com").replace(/\/+$/, "");

  // Validate API URL protocol to prevent credential leakage to non-HTTPS endpoints
  try {
    const parsedApiUrl = new URL(apiUrl);
    if (parsedApiUrl.protocol !== "https:" && parsedApiUrl.protocol !== "http:") {
      throw new ConfigError("DOMINUSNODE_API_URL must use http: or https: protocol");
    }
    // Warn when http: is used for non-localhost (credentials sent in plaintext)
    if (parsedApiUrl.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsedApiUrl.hostname)) {
      process.stderr.write(
        "WARNING: DOMINUSNODE_API_URL uses http: — credentials will be sent in plaintext. Use https: in production.\n"
      );
    }
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError("DOMINUSNODE_API_URL is not a valid URL");
  }

  const proxyTls = parseProxyUrl(env["DOMINUSNODE_PROXY_URL"]);
  const proxyInsecure = env["DOMINUSNODE_PROXY_INSECURE"] === "1";
  if (proxyTls && proxyInsecure) {
    throw new ConfigError("DOMINUSNODE_PROXY_URL (TLS) and DOMINUSNODE_PROXY_INSECURE=1 are mutually exclusive");
  }
  if (proxyTls && env["DOMINUSNODE_PROXY_HOST"] !== undefined && env["DOMINUSNODE_PROXY_HOST"].toLowerCase() !== proxyTls.host) {
    throw new ConfigError("DOMINUSNODE_PROXY_URL and DOMINUSNODE_PROXY_HOST name different hosts");
  }
  const proxyHost = proxyTls?.host ?? env["DOMINUSNODE_PROXY_HOST"] ?? "proxy.dominusnode.com";

  // Validate proxyHost strictly to prevent SSRF via config injection
  if (!/^[a-zA-Z0-9.-]+$/.test(proxyHost)) {
    throw new ConfigError("DOMINUSNODE_PROXY_HOST contains invalid characters (only alphanumeric, dots, hyphens allowed)");
  }
  if (proxyHost.length > 253) {
    throw new ConfigError("DOMINUSNODE_PROXY_HOST exceeds maximum hostname length (253)");
  }
  // Block bare localhost and other loopback/private hostnames, unless the operator opts in
  // (DOMINUSNODE_ALLOW_LOCAL_GATEWAY=1) for a local demo or a self-hosted gateway on a LAN.
  const allowLocalGateway = env["DOMINUSNODE_ALLOW_LOCAL_GATEWAY"] === "1";
  const refuseLocal = (message: string): void => {
    if (!allowLocalGateway) throw new ConfigError(message);
  };
  const BLOCKED_PROXY_HOSTS = new Set([
    "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
    "0.0.0.0", "127.0.0.1",
  ]);
  const proxyHostLower = proxyHost.toLowerCase();
  if (
    BLOCKED_PROXY_HOSTS.has(proxyHostLower) ||
    proxyHostLower.endsWith(".internal") ||
    proxyHostLower.endsWith(".local") ||
    proxyHostLower.endsWith(".localhost")
  ) {
    refuseLocal("DOMINUSNODE_PROXY_HOST must not be a localhost/internal hostname (set DOMINUSNODE_ALLOW_LOCAL_GATEWAY=1 for a local or self-hosted gateway)");
  }
  // Block private IP ranges
  const ipMatch = proxyHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    // Block octal notation IPs (e.g., 0177.0.0.1) to prevent private IP bypass
    const octets = [ipMatch[1], ipMatch[2], ipMatch[3], ipMatch[4]];
    if (octets.some(o => o.startsWith("0") && o.length > 1)) {
      throw new ConfigError("DOMINUSNODE_PROXY_HOST must not use octal IP notation");
    }
    const a = parseInt(ipMatch[1], 10);
    const b = parseInt(ipMatch[2], 10);
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      refuseLocal("DOMINUSNODE_PROXY_HOST must not be a private/loopback IP address (set DOMINUSNODE_ALLOW_LOCAL_GATEWAY=1 for a local or self-hosted gateway)");
    }
  }

  if (allowLocalGateway) {
    process.stderr.write(
      `WARNING: DOMINUSNODE_ALLOW_LOCAL_GATEWAY=1: the proxy gateway host (${proxyHost}) is not checked against localhost/private addresses.\n`,
    );
  }

  const httpProxyPort = parsePort(env["DOMINUSNODE_HTTP_PROXY_PORT"], 8080, "DOMINUSNODE_HTTP_PROXY_PORT");
  const socks5ProxyPort = parsePort(env["DOMINUSNODE_SOCKS5_PROXY_PORT"], 1080, "DOMINUSNODE_SOCKS5_PROXY_PORT");

  const fetchTimeoutMs = parsePositiveInt(env["DOMINUSNODE_FETCH_TIMEOUT_MS"], 30_000, "DOMINUSNODE_FETCH_TIMEOUT_MS");
  if (fetchTimeoutMs > 120_000) {
    throw new ConfigError("DOMINUSNODE_FETCH_TIMEOUT_MS must not exceed 120000");
  }

  const fetchMaxResponseBytes = parsePositiveInt(
    env["DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES"],
    10 * 1024 * 1024,
    "DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES",
  );
  // Enforce upper bound to prevent config-based OOM (integration-patterns: 10MB cap)
  const MAX_FETCH_RESPONSE_BYTES = 10 * 1024 * 1024;
  if (fetchMaxResponseBytes > MAX_FETCH_RESPONSE_BYTES) {
    throw new ConfigError(`DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES must not exceed ${MAX_FETCH_RESPONSE_BYTES}`);
  }

  // Shared secret for MCP agent auto-verification (prevents header spoofing).
  // DOMINUSNODE_AGENT_SECRET is the documented name; MCP_AGENT_SECRET is a legacy alias.
  const mcpAgentSecret = env["DOMINUSNODE_AGENT_SECRET"] || env["MCP_AGENT_SECRET"] || "";

  // Enforce minimum strength when the secret is set
  if (mcpAgentSecret && mcpAgentSecret.length < 32) {
    throw new ConfigError("DOMINUSNODE_AGENT_SECRET (or MCP_AGENT_SECRET) must be at least 32 characters when set");
  }

  if (proxyInsecure) {
    process.stderr.write(
      "WARNING: DOMINUSNODE_PROXY_INSECURE=1 — proxy fetches use plaintext http to the gateway; the API key is sent in clear.\n",
    );
  }

  const walletKeyFile = parseFilePath(env["DOMINUSNODE_WALLET_KEY_FILE"], "DOMINUSNODE_WALLET_KEY_FILE");
  const payoutWalletKeyFile = parseFilePath(env["DOMINUSNODE_PAYOUT_WALLET_KEY_FILE"], "DOMINUSNODE_PAYOUT_WALLET_KEY_FILE");
  const nodeKeyFile =
    parseFilePath(env["DOMINUSNODE_NODE_KEY_FILE"], "DOMINUSNODE_NODE_KEY_FILE") ??
    `${env["HOME"] || env["USERPROFILE"] || "."}/.dominusnode/node.json`;

  return {
    apiKey,
    apiUrl,
    proxyHost,
    httpProxyPort,
    socks5ProxyPort,
    proxyTls: proxyInsecure
      ? null
      : { port: proxyTls?.port ?? 8443, ca: readProxyCa(env["DOMINUSNODE_PROXY_CA_FILE"]) },
    fetchTimeoutMs,
    fetchMaxResponseBytes,
    mcpAgentSecret,
    walletKeyFile,
    payoutWalletKeyFile,
    nodeKeyFile,
  };
}

/** DOMINUSNODE_PROXY_CA_FILE: extra PEM CA for a privately issued gateway cert. Verification stays on. */
function readProxyCa(value: string | undefined): Buffer | undefined {
  const p = parseFilePath(value, "DOMINUSNODE_PROXY_CA_FILE");
  if (!p) return undefined;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(p);
  } catch {
    throw new ConfigError("DOMINUSNODE_PROXY_CA_FILE could not be read");
  }
  if (buf.length > 256 * 1024 || !buf.toString("latin1").includes("-----BEGIN CERTIFICATE-----")) {
    throw new ConfigError("DOMINUSNODE_PROXY_CA_FILE must be a PEM certificate");
  }
  return buf;
}

/** DOMINUSNODE_PROXY_URL: https://host[:port] only (default port 8443); no credentials, path or query. */
function parseProxyUrl(value: string | undefined): { host: string; port: number } | null {
  if (value === undefined || value === "") return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new ConfigError("DOMINUSNODE_PROXY_URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new ConfigError("DOMINUSNODE_PROXY_URL must use https:// (TLS to the gateway)");
  if (u.username || u.password) throw new ConfigError("DOMINUSNODE_PROXY_URL must not contain credentials; use DOMINUSNODE_API_KEY");
  if ((u.pathname && u.pathname !== "/") || u.search || u.hash) throw new ConfigError("DOMINUSNODE_PROXY_URL must not have a path, query or fragment");
  return { host: u.hostname.toLowerCase(), port: u.port ? parsePort(u.port, 8443, "DOMINUSNODE_PROXY_URL port") : 8443 };
}

function parsePort(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1 || n > 65535) {
    throw new ConfigError(`${name} must be a valid port number (1-65535)`);
  }
  return n;
}

function parsePositiveInt(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  const n = parseInt(value, 10);
  if (isNaN(n) || n <= 0) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return n;
}

function parseFilePath(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (v === "") return null;
  if (v.length > 4096 || v.includes("\0") || /[\r\n]/.test(v)) {
    throw new ConfigError(`${name} is not a valid file path`);
  }
  return v;
}
