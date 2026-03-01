const TOKEN_REFRESH_BUFFER_MS = 60_000;

// Maximum response body size for token endpoint responses (1MB)
const MAX_TOKEN_RESPONSE_BYTES = 1_048_576;

export class TokenManager {
  private accessToken: string | null = null;
  private refreshTokenValue: string | null = null;
  private refreshPromise: Promise<string> | null = null;
  private apiUrl: string;
  private apiKey: string | null = null;

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl;
  }

  async initialize(apiKey: string): Promise<void> {
    this.apiKey = apiKey;

    const res = await fetch(`${this.apiUrl}/api/auth/verify-key`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "dominusnode-mcp-server/1.0.0",
        "X-DominusNode-Agent": "mcp", // MCP identification
      },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error", // Reject redirects — prevents credential leakage
    });

    if (!res.ok) {
      // Cancel body instead of buffering — prevents OOM from oversized error response
      await res.body?.cancel();
      throw new Error(`Failed to verify API key (HTTP ${res.status})`);
    }

    // Response size limit to prevent OOM
    const verifyText = await res.text();
    if (verifyText.length > MAX_TOKEN_RESPONSE_BYTES) {
      throw new Error("Token verification response too large");
    }
    // Backend returns { token, refreshToken } — accept both field names
    const data = safeJsonParse<{ token?: string; accessToken?: string; refreshToken: string }>(verifyText);
    const accessToken = data.accessToken ?? data.token;
    if (!accessToken) {
      throw new Error("No access token in verify-key response");
    }
    // Route through setTokens to enforce type+length validation
    this.setTokens(accessToken, data.refreshToken);
  }

  isExpired(token: string): boolean {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return true;
      const payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
      );
      // Strip prototype pollution keys from JWT payload
      if (payload && typeof payload === "object") {
        for (const key of ["__proto__", "constructor", "prototype"]) {
          delete (payload as Record<string, unknown>)[key];
        }
      }
      // Validate exp is a finite number — undefined/NaN comparison always returns false
      if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return true;
      return payload.exp * 1000 < Date.now() + TOKEN_REFRESH_BUFFER_MS;
    } catch {
      return true;
    }
  }

  async getValidToken(): Promise<string> {
    if (this.accessToken && !this.isExpired(this.accessToken)) {
      return this.accessToken;
    }
    return this.forceRefresh();
  }

  // Rate limit forceRefresh to prevent self-inflicted DDoS
  private lastRefreshAttempt = 0;
  private static readonly MIN_REFRESH_INTERVAL_MS = 5_000; // 5 seconds between refreshes

  async forceRefresh(): Promise<string> {
    if (!this.refreshTokenValue && !this.apiKey) {
      throw new Error("No refresh token or API key available — cannot recover");
    }

    // Prevent refresh amplification — min 5s between attempts
    const now = Date.now();
    if (now - this.lastRefreshAttempt < TokenManager.MIN_REFRESH_INTERVAL_MS) {
      if (this.accessToken) return this.accessToken;
      throw new Error("Token refresh rate limited — try again shortly");
    }
    this.lastRefreshAttempt = now;

    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        // Try refresh token first if available
        if (this.refreshTokenValue) {
          const res = await fetch(`${this.apiUrl}/api/auth/refresh`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "dominusnode-mcp-server/1.0.0",
              "X-DominusNode-Agent": "mcp", // MCP identification
            },
            body: JSON.stringify({ refreshToken: this.refreshTokenValue }),
            signal: AbortSignal.timeout(30_000),
            redirect: "error", // Reject redirects
          });

          if (res.ok) {
            const refreshText = await res.text();
            if (refreshText.length > MAX_TOKEN_RESPONSE_BYTES) {
              throw new Error("Token refresh response too large");
            }
            // Backend returns { token, refreshToken } — accept both field names
            const data = safeJsonParse<{ token?: string; accessToken?: string; refreshToken?: string }>(refreshText);
            const accessToken = data.accessToken ?? data.token;
            if (!accessToken) {
              throw new Error("No access token in refresh response");
            }
            // Route through setTokens to enforce type+length validation
            this.setTokens(accessToken, data.refreshToken ?? this.refreshTokenValue!);
            return this.accessToken!;
          }

          // Cancel body instead of buffering — prevents OOM from oversized error response
          await res.body?.cancel();
        }

        // Fallback: re-initialize with stored API key
        if (this.apiKey) {
          await this.initialize(this.apiKey);
          return this.accessToken!;
        }

        throw new Error("Token refresh failed and no API key available for re-initialization");
      } catch (err) {
        // Only null tokens, NOT apiKey — allows future recovery
        this.accessToken = null;
        this.refreshTokenValue = null;
        throw err;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /** Store tokens from external auth flow (e.g., registration, wallet auth in bootstrap mode) */
  setTokens(accessToken: string, refreshToken: string): void {
    // Validate token type and length before storage
    if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
      throw new Error("Tokens must be strings");
    }
    if (!accessToken || !refreshToken) {
      throw new Error("Tokens cannot be empty");
    }
    if (accessToken.length > 10_000 || refreshToken.length > 10_000) {
      throw new Error("Token exceeds maximum length");
    }
    this.accessToken = accessToken;
    this.refreshTokenValue = refreshToken;
  }

  clear(): void {
    // Best-effort credential clearing. JavaScript strings are immutable and
    // garbage-collected — old values persist in memory until GC reclaims them.
    // True memory zeroing is not possible in Node.js. This is a known limitation.
    // For maximum security, keep token lifetimes short (15min access, 7d refresh).
    this.accessToken = null;
    this.refreshTokenValue = null;
    this.refreshPromise = null;
    this.apiKey = null;
  }
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

// Depth limit prevents stack overflow on deeply nested JSON
function stripDangerousKeys(obj: unknown, depth = 0): void {
  if (depth > 50 || !obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item, depth + 1);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete record[key];
    } else if (record[key] && typeof record[key] === "object") {
      stripDangerousKeys(record[key], depth + 1);
    }
  }
}

function safeJsonParse<T>(text: string): T {
  const parsed = JSON.parse(text);
  stripDangerousKeys(parsed);
  return parsed as T;
}
