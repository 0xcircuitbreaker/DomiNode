import * as crypto from "node:crypto";
import type { HttpClient } from "./http.js";
import type { User, LoginResult, MfaStatus, MfaSetup } from "./types.js";

const POW_MAX_NONCE = 100_000_000;

function countLeadingZeroBits(hash: Buffer): number {
  let count = 0;
  for (const byte of hash) {
    if (byte === 0) {
      count += 8;
    } else {
      let mask = 0x80;
      while (mask && !(byte & mask)) {
        count += 1;
        mask >>= 1;
      }
      break;
    }
  }
  return count;
}

export class AuthResource {
  constructor(private http: HttpClient) {}

  private async solvePoW(): Promise<{ challengeId: string; nonce: number } | null> {
    try {
      const challenge = await this.http.post<{
        challengeId: string;
        prefix: string;
        difficulty: number;
        algorithm: string;
        expiresAt: string;
      }>("/api/auth/pow/challenge", {}, false);

      const { challengeId, prefix } = challenge;
      const difficulty = Math.min(challenge.difficulty, 32);

      for (let nonce = 0; nonce < POW_MAX_NONCE; nonce++) {
        const hash = crypto.createHash("sha256").update(prefix + nonce).digest();
        if (countLeadingZeroBits(hash) >= difficulty) {
          return { challengeId, nonce };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async register(email: string, password: string): Promise<{ user: User; token?: string; refreshToken?: string }> {
    const pow = await this.solvePoW();
    const body: Record<string, unknown> = { email, password };
    if (pow) {
      body.pow = pow;
    }
    return this.http.post("/api/auth/register", body, false);
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
