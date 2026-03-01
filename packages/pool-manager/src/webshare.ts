import * as crypto from "node:crypto";
import { BLOCKED_COUNTRY_CODES } from "@dominusnode/shared";

// ─── Config ─────────────────────────────────────────────────────────

export interface WebsharePoolConfig {
  username: string;
  password: string;
}

export interface WebshareConfig {
  proxyHost: string;
  httpPort: number;
  socks5Port: number;
  dc: WebsharePoolConfig;
  residential: WebsharePoolConfig;
  apiKey: string;
  apiBaseUrl: string;
}

export function getConfig(): WebshareConfig {
  // C-2: Validate WEBSHARE_PROXY_HOST — block SSRF via config injection
  const proxyHost = process.env["WEBSHARE_PROXY_HOST"] ?? "p.webshare.io";
  if (/[\s\/\\@]/.test(proxyHost)) {
    throw new Error("WEBSHARE_PROXY_HOST must be a plain hostname");
  }
  const lowerHost = proxyHost.toLowerCase();
  if (lowerHost === "localhost" || lowerHost === "127.0.0.1" || lowerHost === "0.0.0.0" ||
      lowerHost.endsWith(".internal") || lowerHost.endsWith(".local") || lowerHost.endsWith(".localhost")) {
    throw new Error("WEBSHARE_PROXY_HOST must not be a private/internal hostname");
  }
  const ipParts = proxyHost.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipParts) {
    const a = parseInt(ipParts[1], 10);
    const b = parseInt(ipParts[2], 10);
    if (a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) {
      throw new Error("WEBSHARE_PROXY_HOST must not be a private/loopback IP");
    }
  }

  // H-3: Validate WEBSHARE_API_BASE_URL — enforce HTTPS, no query/fragment
  const apiBaseUrl = process.env["WEBSHARE_API_BASE_URL"] ?? "https://proxy.webshare.io/api/v2";
  try {
    const parsed = new URL(apiBaseUrl);
    if (parsed.protocol !== "https:") {
      throw new Error("WEBSHARE_API_BASE_URL must use HTTPS");
    }
    if (parsed.hash || parsed.search) {
      throw new Error("WEBSHARE_API_BASE_URL must not contain query string or fragment");
    }
  } catch (e) {
    if (e instanceof TypeError) throw new Error("WEBSHARE_API_BASE_URL is not a valid URL");
    throw e;
  }

  return {
    proxyHost,
    httpPort: parseInt(process.env["WEBSHARE_HTTP_PORT"] ?? "80", 10),
    socks5Port: parseInt(process.env["WEBSHARE_SOCKS5_PORT"] ?? "1080", 10),
    dc: {
      username: process.env["WEBSHARE_DC_USERNAME"] ?? "",
      password: process.env["WEBSHARE_DC_PASSWORD"] ?? "",
    },
    residential: {
      username: process.env["WEBSHARE_RES_USERNAME"] ?? "",
      password: process.env["WEBSHARE_RES_PASSWORD"] ?? "",
    },
    apiKey: process.env["WEBSHARE_API_KEY"] ?? "",
    apiBaseUrl,
  };
}

export function validateConfig(): void {
  const config = getConfig();
  const hasDC = config.dc.username && config.dc.password;
  const hasRes = config.residential.username && config.residential.password;
  if (!hasDC && !hasRes) {
    throw new Error(
      "At least one Webshare pool must be configured: " +
      "set WEBSHARE_DC_USERNAME/WEBSHARE_DC_PASSWORD or " +
      "WEBSHARE_RES_USERNAME/WEBSHARE_RES_PASSWORD",
    );
  }
}

// ─── Proxy Building ─────────────────────────────────────────────────

export type WebsharePool = "dc" | "residential";

export interface ProxyOptions {
  country?: string;
  state?: string;
  city?: string;
  asn?: number;
  sticky?: boolean;
  sessionId?: string;
  proxyType?: WebsharePool | "auto";
}

export interface UpstreamProxy {
  host: string;
  port: number;
  username: string;
  password: string;
  proxyAuth: string; // base64-encoded "username:password"
}

export function generateStickySession(): string {
  return crypto.randomBytes(4).toString("hex");
}

export function buildUpstreamProxy(pool: WebsharePool, options?: ProxyOptions): UpstreamProxy {
  const config = getConfig();
  const poolConfig = pool === "dc" ? config.dc : config.residential;

  if (!poolConfig.username || !poolConfig.password) {
    throw new Error(`Webshare ${pool} pool credentials not configured`);
  }

  // Build username with geo-targeting and session options
  // Webshare format: username-country-US-rotate:password@host:port
  let username = poolConfig.username;

  if (options?.country) {
    const country = options.country.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) {
      throw new Error("Invalid country code: must be exactly 2 ASCII letters");
    }
    if (BLOCKED_COUNTRY_CODES.has(country)) {
      throw new Error(`Country ${country} is sanctioned and cannot be used as proxy exit`);
    }
    username += `-country-${country}`;
  }

  // Webshare only supports country-level geo targeting — warn and ignore state/city/ASN
  if (options?.state) {
    // Silently ignored — Webshare does not support state targeting
  }
  if (options?.city) {
    // Silently ignored — Webshare does not support city targeting
  }
  if (options?.asn) {
    // Silently ignored — Webshare does not support ASN targeting
  }

  // Session handling: -rotate for rotating, -session-XXXXX for sticky
  if (options?.sticky || options?.sessionId) {
    const sessionId = options?.sessionId ?? generateStickySession();
    if (!/^[a-zA-Z0-9]+$/.test(sessionId)) {
      throw new Error("Invalid sessionId: must be alphanumeric only");
    }
    if (sessionId.length > 255) {
      throw new Error("Invalid sessionId: must be 255 characters or fewer");
    }
    username += `-session-${sessionId}`;
  } else {
    username += "-rotate";
  }

  const password = poolConfig.password;
  const proxyAuth = Buffer.from(`${username}:${password}`).toString("base64");

  const proxy: UpstreamProxy = {
    host: config.proxyHost,
    port: config.httpPort,
    username,
    password,
    proxyAuth,
  };

  // Make sensitive fields non-enumerable to prevent accidental logging/serialization
  Object.defineProperties(proxy, {
    password: { enumerable: false },
    proxyAuth: { enumerable: false },
  });

  return proxy;
}

// ─── Bandwidth API ──────────────────────────────────────────────────

export interface BandwidthUsage {
  usedBytes: number;
  totalBytes: number;
  remainingBytes: number;
}

export async function getBandwidthUsage(): Promise<BandwidthUsage> {
  const config = getConfig();
  if (!config.apiKey) {
    throw new Error("WEBSHARE_API_KEY is required for bandwidth monitoring");
  }

  const resp = await fetch(`${config.apiBaseUrl}/subscription/plan/`, {
    method: "GET",
    headers: {
      Authorization: `Token ${config.apiKey}`,
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000), // prevent indefinite hang
  });

  if (!resp.ok) {
    // Don't include response body in error — may contain account/credential details
    await resp.body?.cancel(); // Drain without buffering
    throw new Error(`Webshare bandwidth API failed: ${resp.status}`);
  }

  // Response size limit to prevent OOM from oversized upstream response
  const respText = await resp.text();
  if (respText.length > 1_048_576) {
    throw new Error("Webshare bandwidth API response too large");
  }
  const data = JSON.parse(respText) as Record<string, unknown>;
  const usedBytes = typeof data["bandwidth_used"] === "number" ? data["bandwidth_used"] : 0;
  const totalBytes = typeof data["bandwidth_limit"] === "number" ? data["bandwidth_limit"] : 0;

  return {
    usedBytes,
    totalBytes,
    remainingBytes: Math.max(0, totalBytes - usedBytes),
  };
}

// ─── Static Proxy List (for Webshare "Proxy Servers" DC plans) ─────

export interface StaticProxy {
  address: string;
  port: number;
  username: string;
  password: string;
  countryCode: string;
}

const MAX_PROXY_LIST_RESPONSE = 10 * 1024 * 1024; // 10 MB safety cap
const MAX_PROXY_LIST_PAGES = 20; // prevent infinite pagination

// C-3: Validate proxy_address is a valid non-private IPv4
function isValidProxyAddress(address: string): boolean {
  const m = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[4], 10)];
  if (parts.some(p => p > 255)) return false;
  if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127) return false;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
  if (parts[0] === 192 && parts[1] === 168) return false;
  if (parts[0] === 169 && parts[1] === 254) return false;
  return true;
}

/**
 * Fetch the static proxy list from Webshare API.
 * Used for "Proxy Servers" (DC) plans where you get individual IP:port proxies
 * instead of gateway access through p.webshare.io.
 */
export async function fetchProxyList(): Promise<StaticProxy[]> {
  const config = getConfig();
  if (!config.apiKey) {
    throw new Error("WEBSHARE_API_KEY is required to fetch DC proxy list");
  }

  const proxies: StaticProxy[] = [];
  let page = 1;
  const pageSize = 250;

  while (page <= MAX_PROXY_LIST_PAGES) {
    const url = `${config.apiBaseUrl}/proxy/list/?mode=direct&page=${page}&page_size=${pageSize}`;
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Token ${config.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      await resp.body?.cancel(); // Drain body to release connection back to pool
      throw new Error(`Webshare proxy list API failed: ${resp.status}`);
    }

    const text = await resp.text();
    if (text.length > MAX_PROXY_LIST_RESPONSE) {
      throw new Error("Webshare proxy list response too large");
    }

    const data = JSON.parse(text) as Record<string, unknown>;
    const results = Array.isArray(data["results"]) ? data["results"] : [];

    for (const r of results) {
      if (
        typeof r === "object" && r !== null &&
        typeof (r as Record<string, unknown>)["proxy_address"] === "string" &&
        typeof (r as Record<string, unknown>)["port"] === "number"
      ) {
        const rec = r as Record<string, unknown>;
        // Only include valid proxies
        if (rec["valid"] === false) continue;
        // C-3: Validate proxy_address is a valid non-private IPv4
        const proxyAddress = rec["proxy_address"] as string;
        if (!isValidProxyAddress(proxyAddress)) continue;
        // H-4: Validate port range
        const port = rec["port"] as number;
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const cc = typeof rec["country_code"] === "string"
          ? (rec["country_code"] as string).toUpperCase()
          : "";
        // Skip proxies in sanctioned countries at ingestion time
        if (cc && BLOCKED_COUNTRY_CODES.has(cc)) continue;
        const entry: StaticProxy = {
          address: proxyAddress,
          port,
          username: typeof rec["username"] === "string" ? rec["username"] : "",
          password: typeof rec["password"] === "string" ? rec["password"] : "",
          countryCode: cc,
        };
        // Make password non-enumerable to prevent accidental serialization
        Object.defineProperty(entry, "password", { enumerable: false, writable: true, configurable: true });
        proxies.push(entry);
      }
    }

    // Stop if no more pages
    if (!data["next"] || results.length < pageSize) break;
    page++;
  }

  return proxies;
}

/**
 * In-memory pool of static DC proxies with round-robin selection.
 * Fetches the list from Webshare API on init and refreshes periodically.
 */
export class StaticProxyPool {
  private proxies: StaticProxy[] = [];
  private index = 0;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _ready = false;
  private _lastError: string | null = null;

  /** Fetch the proxy list and start periodic refresh (5 min). */
  async init(): Promise<void> {
    await this.refresh();
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(() => { /* logged in refresh() */ });
    }, 300_000);
    this.refreshTimer.unref();
  }

  private async refresh(): Promise<void> {
    try {
      const list = await fetchProxyList();
      if (list.length > 0) {
        this.proxies = list;
        // Keep index within bounds after refresh
        if (this.index >= list.length) this.index = 0;
        this._ready = true;
        this._lastError = null;
      } else if (!this._ready) {
        this._lastError = "Webshare proxy list returned 0 proxies";
      }
    } catch (err) {
      // Truncate error to avoid storing sensitive upstream details
      const rawMsg = err instanceof Error ? err.message : String(err);
      this._lastError = rawMsg.slice(0, 100);
      // On refresh failure, keep existing proxies if we have them
      if (this.proxies.length === 0) {
        this._ready = false;
      }
    }
  }

  /**
   * Get the next proxy via round-robin. Optionally filter by country.
   * For sticky sessions, uses the sessionId hash to pick a consistent proxy.
   */
  getProxy(options?: ProxyOptions): UpstreamProxy {
    if (this.proxies.length === 0) {
      // Don't expose _lastError details — may contain upstream API info
      throw new Error("No DC proxies available — proxy list not yet loaded");
    }

    let candidates = this.proxies;

    // Country filter — match against proxy's country_code from Webshare API
    if (options?.country) {
      const upper = options.country.toUpperCase();
      if (BLOCKED_COUNTRY_CODES.has(upper)) {
        throw new Error(`Country ${upper} is sanctioned and cannot be used as proxy exit`);
      }
      const filtered = this.proxies.filter((p) => p.countryCode === upper);
      // Fail explicitly instead of silently falling back to unfiltered pool
      if (filtered.length === 0) {
        throw new Error(`No DC proxies available for country ${upper}`);
      }
      candidates = filtered;
    }

    // Sticky session: hash sessionId to pick a consistent proxy
    let idx: number;
    if (options?.sessionId || options?.sticky) {
      const seed = options?.sessionId ?? crypto.randomBytes(4).toString("hex");
      let hash = 0;
      for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
      }
      idx = Math.abs(hash) % candidates.length;
    } else {
      idx = this.index % candidates.length;
      this.index = (this.index + 1) % this.proxies.length;
    }

    const proxy = candidates[idx];
    const proxyAuth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");

    const result: UpstreamProxy = {
      host: proxy.address,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      proxyAuth,
    };

    Object.defineProperties(result, {
      password: { enumerable: false },
      proxyAuth: { enumerable: false },
    });

    return result;
  }

  get count(): number {
    return this.proxies.length;
  }

  get ready(): boolean {
    return this._ready;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    // Scrub credentials from memory on destroy
    for (const p of this.proxies) {
      p.username = "";
      p.password = "";
    }
    this.proxies = [];
    this._ready = false;
  }
}
