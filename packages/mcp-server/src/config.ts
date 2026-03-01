export interface McpConfig {
  apiKey: string | null;
  apiUrl: string;
  proxyHost: string;
  httpProxyPort: number;
  socks5ProxyPort: number;
  fetchTimeoutMs: number;
  fetchMaxResponseBytes: number;
  mcpAgentSecret: string;
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

  const proxyHost = env["DOMINUSNODE_PROXY_HOST"] ?? "proxy.dominusnode.com";

  // Validate proxyHost strictly to prevent SSRF via config injection
  if (!/^[a-zA-Z0-9.\-]+$/.test(proxyHost)) {
    throw new ConfigError("DOMINUSNODE_PROXY_HOST contains invalid characters (only alphanumeric, dots, hyphens allowed)");
  }
  if (proxyHost.length > 253) {
    throw new ConfigError("DOMINUSNODE_PROXY_HOST exceeds maximum hostname length (253)");
  }
  // Block bare localhost and other loopback/private hostnames
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
    throw new ConfigError("DOMINUSNODE_PROXY_HOST must not be a localhost/internal hostname");
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
      throw new ConfigError("DOMINUSNODE_PROXY_HOST must not be a private/loopback IP address");
    }
  }

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
  // Enforce upper bound to prevent config-based OOM
  const MAX_FETCH_RESPONSE_BYTES = 50 * 1024 * 1024; // 50MB hard cap
  if (fetchMaxResponseBytes > MAX_FETCH_RESPONSE_BYTES) {
    throw new ConfigError(`DOMINUSNODE_FETCH_MAX_RESPONSE_BYTES must not exceed ${MAX_FETCH_RESPONSE_BYTES}`);
  }

  // Shared secret for MCP agent auto-verification (prevents header spoofing)
  const mcpAgentSecret = env["MCP_AGENT_SECRET"] ?? "";

  // Enforce minimum strength when MCP_AGENT_SECRET is set
  if (mcpAgentSecret && mcpAgentSecret.length < 32) {
    throw new ConfigError("MCP_AGENT_SECRET must be at least 32 characters when set");
  }

  return {
    apiKey,
    apiUrl,
    proxyHost,
    httpProxyPort,
    socks5ProxyPort,
    fetchTimeoutMs,
    fetchMaxResponseBytes,
    mcpAgentSecret,
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
