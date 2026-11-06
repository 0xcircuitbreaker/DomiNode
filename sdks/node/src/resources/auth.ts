import type { HttpClient } from "../http.js";
import type { User } from "../types.js";
import { invalidArg } from "../errors.js";

export interface VerifyKeyResponse {
  valid: boolean;
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
}

const API_KEY_RE = /^dn_(live|test)_[A-Za-z0-9_-]{8,200}$/;

export function validateApiKey(apiKey: unknown): string {
  if (typeof apiKey !== "string" || !API_KEY_RE.test(apiKey)) throw invalidArg("apiKey must be a dn_live_ or dn_test_ key");
  return apiKey;
}

/** Token plumbing. Human email/password, registration and MFA flows are admin-panel only and not in the SDK. */
export class AuthResource {
  constructor(private http: HttpClient) {}

  /** POST /api/auth/verify-key — exchange an API key for a JWT pair (no auth). */
  async verifyKey(apiKey: string): Promise<VerifyKeyResponse> {
    return this.http.post("/api/auth/verify-key", { apiKey: validateApiKey(apiKey) }, "none");
  }

  /** POST /api/auth/refresh — rotate the refresh token (family rotation). */
  async refresh(refreshToken: string): Promise<{ token: string; refreshToken?: string }> {
    if (typeof refreshToken !== "string" || !refreshToken) throw invalidArg("refreshToken is required");
    return this.http.post("/api/auth/refresh", { refreshToken }, "none");
  }

  /** POST /api/auth/logout — revoke refresh tokens server-side. */
  async logout(): Promise<void> {
    await this.http.post("/api/auth/logout", {});
  }

  /** GET /api/auth/me */
  async me(): Promise<{ user: User }> {
    return this.http.get("/api/auth/me");
  }
}
