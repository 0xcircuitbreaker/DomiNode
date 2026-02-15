const TOKEN_REFRESH_BUFFER_MS = 60_000;

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
      },
      body: JSON.stringify({ apiKey }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error", // R17: Reject redirects — prevents credential leakage
    });

    if (!res.ok) {
      await res.text(); // consume body but don't expose raw response
      throw new Error(`Failed to verify API key (HTTP ${res.status})`);
    }

    const data = safeJsonParse<{ accessToken: string; refreshToken: string }>(await res.text());
    this.accessToken = data.accessToken;
    this.refreshTokenValue = data.refreshToken;
  }

  isExpired(token: string): boolean {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return true;
      const payload = JSON.parse(
        Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
      );
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

  async forceRefresh(): Promise<string> {
    if (!this.refreshTokenValue && !this.apiKey) {
      throw new Error("No refresh token or API key available — cannot recover");
    }

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
            },
            body: JSON.stringify({ refreshToken: this.refreshTokenValue }),
            signal: AbortSignal.timeout(30_000),
            redirect: "error", // R17: Reject redirects
          });

          if (res.ok) {
            const data = safeJsonParse<{ accessToken: string; refreshToken?: string }>(await res.text());
            this.accessToken = data.accessToken;
            if (data.refreshToken) {
              this.refreshTokenValue = data.refreshToken;
            }
            return this.accessToken;
          }

          // Refresh failed — consume body before falling through
          await res.text();
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

  clear(): void {
    this.accessToken = null;
    this.refreshTokenValue = null;
    this.refreshPromise = null;
    this.apiKey = null;
  }
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function stripDangerousKeys(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) {
      delete record[key];
    } else if (record[key] && typeof record[key] === "object") {
      stripDangerousKeys(record[key]);
    }
  }
}

function safeJsonParse<T>(text: string): T {
  const parsed = JSON.parse(text);
  stripDangerousKeys(parsed);
  return parsed as T;
}
