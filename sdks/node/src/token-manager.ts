import { TOKEN_REFRESH_BUFFER_MS } from "./constants.js";
import { AuthenticationError } from "./errors.js";
import { inspectSymbol } from "./secret.js";

export type RefreshFn = (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string }>;

/**
 * Holds the JWT access/refresh pair. Internal: not exported from the package.
 * clear() drops tokens but keeps refreshFn so the client can reconnect.
 */
export class TokenManager {
  #accessToken: string | null = null;
  #refreshToken: string | null = null;
  #refreshPromise: Promise<string> | null = null;
  #refreshFn: RefreshFn | null = null;

  setTokens(access: string, refresh?: string): void {
    this.#accessToken = access;
    if (refresh) this.#refreshToken = refresh;
  }

  setRefreshFunction(fn: RefreshFn): void {
    this.#refreshFn = fn;
  }

  hasRefreshFunction(): boolean {
    return this.#refreshFn !== null;
  }

  getAccessToken(): string | null { return this.#accessToken; }
  getRefreshToken(): string | null { return this.#refreshToken; }
  hasTokens(): boolean { return this.#accessToken !== null || this.#refreshToken !== null; }

  isExpired(token: string): boolean {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return true;
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (typeof payload.exp !== "number") return true;
      return payload.exp * 1000 < Date.now() + TOKEN_REFRESH_BUFFER_MS;
    } catch {
      return true;
    }
  }

  async getValidToken(): Promise<string> {
    if (this.#accessToken && !this.isExpired(this.#accessToken)) return this.#accessToken;
    return this.forceRefresh();
  }

  /** Refresh regardless of expiry (used after a 401). Concurrent callers share one refresh. */
  async forceRefresh(): Promise<string> {
    if (!this.#refreshToken || !this.#refreshFn) {
      throw new AuthenticationError("No valid token and cannot refresh");
    }
    if (this.#refreshPromise) return this.#refreshPromise;
    const fn = this.#refreshFn;
    const rt = this.#refreshToken;
    this.#refreshPromise = (async () => {
      try {
        const result = await fn(rt);
        this.#accessToken = result.accessToken;
        if (result.refreshToken) this.#refreshToken = result.refreshToken;
        return result.accessToken;
      } catch (err) {
        // Drop tokens so a broken refresh does not loop.
        this.#accessToken = null;
        this.#refreshToken = null;
        throw err;
      } finally {
        this.#refreshPromise = null;
      }
    })();
    return this.#refreshPromise;
  }

  /** Drop tokens. Does NOT null refreshFn (reconnecting must keep working). */
  clear(): void {
    this.#accessToken = null;
    this.#refreshToken = null;
    this.#refreshPromise = null;
  }

  toString(): string { return "TokenManager([REDACTED])"; }
  toJSON(): string { return "[REDACTED]"; }
  [inspectSymbol](): string { return this.toString(); }
}
