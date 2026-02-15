export interface McpConfig {
  apiKey: string | null;
  apiUrl: string;
  proxyHost: string;
  httpProxyPort: number;
  socks5ProxyPort: number;
  fetchTimeoutMs: number;
  fetchMaxResponseBytes: number;
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

  const proxyHost = env["DOMINUSNODE_PROXY_HOST"] ?? "proxy.dominusnode.com";

  const httpProxyPort = parsePort(env["DOMINUSNODE_HTTP_PROXY_PORT"], 8080, "DOMINUSNODE_HTTP_PROXY_PORT");
  const socks5ProxyPort = parsePort(env["DOMINUSNODE_SOCKS5_PROXY_PORT"], 1080, "DOMINUSNODE_SOCKS5_PROXY_PORT");

  const fetchTimeoutMs = parsePositiveInt(env["DOMINUSNODE_FETCH_TIMEOUT_MS"], 30_000, "DOMINUSNODE_FETCH_TIMEOUT_MS");
  if (fetchTimeoutMs > 120_000) {
    throw new ConfigError("DOMINUSNODE_FETCH_TIMEOUT_MS must not exceed 120000");
  }

  const fetchMaxResponseBytes = parsePositiveInt(
    env["DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES"],
    5 * 1024 * 1024,
    "DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES",
  );

  return {
    apiKey,
    apiUrl,
    proxyHost,
    httpProxyPort,
    socks5ProxyPort,
    fetchTimeoutMs,
    fetchMaxResponseBytes,
  };
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
