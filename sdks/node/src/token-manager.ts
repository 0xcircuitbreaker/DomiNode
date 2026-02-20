import { TOKEN_REFRESH_BUFFER_MS } from "./constants.js";
import { AuthenticationError } from "./errors.js";

export class TokenManager {
  private accessToken: string | null = null;
  private refreshTokenValue: string | null = null;
  private refreshPromise: Promise<string> | null = null;
  private refreshFn: ((refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string }>) | null = null;

  setTokens(access: string, refresh?: string): void {
    this.accessToken = access;
    if (refresh) this.refreshTokenValue = refresh;
  }

  setRefreshFunction(fn: (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string }>): void {
    this.refreshFn = fn;
  }

  getAccessToken(): string | null {
    return this.accessToken;
  }

  getRefreshToken(): string | null {
    return this.refreshTokenValue;
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

    if (!this.refreshTokenValue || !this.refreshFn) {
      throw new AuthenticationError("No valid token and cannot refresh");
    }

    // Singleton refresh
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const result = await this.refreshFn!(this.refreshTokenValue!);
        this.accessToken = result.accessToken;
        if (result.refreshToken) {
          this.refreshTokenValue = result.refreshToken;
        }
        return this.accessToken;
      } catch (err) {
        // Clear tokens on refresh failure to prevent rapid-fire retry loops
        this.accessToken = null;
        this.refreshTokenValue = null;
        throw err;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Force a token refresh regardless of expiry state.
   * Used after a 401 response to avoid re-using a rejected token.
   */
  async forceRefresh(): Promise<string> {
    if (!this.refreshTokenValue || !this.refreshFn) {
      throw new AuthenticationError("No valid token and cannot refresh");
    }

    // Singleton refresh (reuse in-flight refresh if one is already happening)
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      try {
        const result = await this.refreshFn!(this.refreshTokenValue!);
        this.accessToken = result.accessToken;
        if (result.refreshToken) {
          this.refreshTokenValue = result.refreshToken;
        }
        return this.accessToken;
      } catch (err) {
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
  }
}
