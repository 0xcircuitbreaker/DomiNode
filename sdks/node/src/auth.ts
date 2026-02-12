import type { HttpClient } from "./http.js";
import type { User, LoginResult, MfaStatus, MfaSetup } from "./types.js";

export class AuthResource {
  constructor(private http: HttpClient) {}

  async register(email: string, password: string): Promise<{ user: User; token?: string; refreshToken?: string }> {
    return this.http.post("/api/auth/register", { email, password }, false);
  }

  async login(email: string, password: string): Promise<LoginResult & { token?: string; refreshToken?: string }> {
    return this.http.post("/api/auth/login", { email, password }, false);
  }

  async verifyMfa(code: string, opts?: { mfaChallengeToken?: string; isBackupCode?: boolean }): Promise<{ user: User; token: string; refreshToken: string }> {
    return this.http.post("/api/auth/mfa/verify", { code, ...opts }, false);
  }

  async refresh(refreshToken: string): Promise<{ token: string; refreshToken?: string }> {
    return this.http.post("/api/auth/refresh", { refreshToken }, false);
  }

  async logout(): Promise<void> {
    await this.http.post("/api/auth/logout", {});
  }

  async me(): Promise<{ user: User }> {
    return this.http.get("/api/auth/me");
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await this.http.post("/api/auth/change-password", { currentPassword, newPassword });
  }

  async verifyKey(apiKey: string): Promise<{ valid: boolean; token: string; refreshToken: string; userId: string; email: string }> {
    return this.http.post("/api/auth/verify-key", { apiKey }, false);
  }

  async mfaSetup(): Promise<MfaSetup> {
    return this.http.post("/api/auth/mfa/setup", {});
  }

  async mfaEnable(code: string): Promise<{ enabled: boolean }> {
    return this.http.post("/api/auth/mfa/enable", { code });
  }

  async mfaDisable(password: string, code: string): Promise<{ enabled: boolean }> {
    return this.http.post("/api/auth/mfa/disable", { password, code });
  }

  async mfaStatus(): Promise<MfaStatus> {
    return this.http.get("/api/auth/mfa/status");
  }
}
