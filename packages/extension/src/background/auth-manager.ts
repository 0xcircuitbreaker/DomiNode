import { apiPost, apiGet } from "../shared/api-client.js";
import { loadState, updateState } from "../shared/state.js";

// Singleton refresh promise to prevent concurrent refresh calls
let refreshPromise: Promise<string> | null = null;

interface LoginResponse {
  token?: string;
  refreshToken?: string;
  userId?: string;
  email?: string;
  mfaRequired?: boolean;
  mfaChallengeToken?: string;
}

interface VerifyKeyResponse {
  valid: boolean;
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
}

interface MfaVerifyResponse {
  token: string;
  refreshToken: string;
  userId: string;
  email: string;
}

interface RefreshResponse {
  token: string;
  refreshToken?: string;
}

export async function login(email: string, password: string): Promise<{ mfaRequired: boolean }> {
  const resp = await apiPost<LoginResponse>("/api/auth/login", { email, password });

  if (resp.mfaRequired) {
    await updateState({
      mfaPending: true,
      mfaChallengeToken: resp.mfaChallengeToken ?? null,
      lastError: null,
    });
    return { mfaRequired: true };
  }

  await updateState({
    accessToken: resp.token!,
    refreshToken: resp.refreshToken!,
    userId: resp.userId!,
    email: resp.email!,
    apiKey: null,
    mfaPending: false,
    mfaChallengeToken: null,
    lastError: null,
  });
  return { mfaRequired: false };
}

export async function verifyMfaCode(code: string, isBackupCode = false): Promise<void> {
  const state = await loadState();
  if (!state.mfaChallengeToken) {
    throw new Error("No MFA challenge in progress");
  }

  const resp = await apiPost<MfaVerifyResponse>("/api/auth/mfa/verify", {
    mfaChallengeToken: state.mfaChallengeToken,
    code,
    isBackupCode,
  });

  await updateState({
    accessToken: resp.token,
    refreshToken: resp.refreshToken,
    userId: resp.userId,
    email: resp.email,
    apiKey: null,
    mfaPending: false,
    mfaChallengeToken: null,
    lastError: null,
  });
}

export async function loginWithKey(apiKey: string): Promise<void> {
  const resp = await apiPost<VerifyKeyResponse>("/api/auth/verify-key", { apiKey });
  await updateState({
    accessToken: resp.token,
    refreshToken: resp.refreshToken,
    userId: resp.userId,
    email: resp.email,
    apiKey,
    mfaPending: false,
    mfaChallengeToken: null,
    lastError: null,
  });
}

export async function logout(): Promise<void> {
  // Best-effort server-side logout to revoke refresh tokens
  try {
    const state = await loadState();
    if (state.accessToken) {
      const { apiPost } = await import("../shared/api-client.js");
      await apiPost("/api/auth/logout", {}, state.accessToken);
    }
  } catch {
    // Best effort -- still proceed with local cleanup
  }

  // Clear auth state FIRST to prevent alarm handlers from using stale tokens
  await updateState({
    apiKey: null,
    proxyToken: null,
    proxyTokenExpiry: null,
    accessToken: null,
    refreshToken: null,
    userId: null,
    email: null,
    walletAddress: null,
    mfaPending: false,
    mfaChallengeToken: null,
    proxyEnabled: false,
    isConnected: false,
    balanceCents: 0,
    lastError: null,
  });

  // Then clear alarms and disable proxy adapter
  await chrome.alarms.clearAll();
  const { disableProxy } = await import("./proxy-controller.js");
  await disableProxy();
}

export function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const payloadB64 = parts[1];
    if (!payloadB64 || payloadB64.length > 4096) return true; // Cap payload size
    // Convert base64url to standard base64
    const base64 = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(base64));
    if (typeof payload !== "object" || payload === null) return true;
    // Strip prototype pollution keys from JWT payload
    delete payload.__proto__;
    delete payload.constructor;
    delete payload.prototype;
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return true;
    // Expired if within 60 seconds of expiry
    return payload.exp * 1000 < Date.now() + 60_000;
  } catch {
    return true;
  }
}

export async function refreshToken(): Promise<string> {
  // Singleton pattern: if a refresh is already in-flight, reuse it
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const state = await loadState();
      if (!state.refreshToken) throw new Error("No refresh token");

      const resp = await apiPost<RefreshResponse>("/api/auth/refresh", {
        refreshToken: state.refreshToken,
      });

      // Save both new access token and rotated refresh token
      const stateUpdate: Record<string, unknown> = { accessToken: resp.token, lastError: null };
      if (resp.refreshToken) {
        stateUpdate.refreshToken = resp.refreshToken;
      }
      await updateState(stateUpdate);
      return resp.token;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function getValidToken(): Promise<string> {
  const state = await loadState();
  if (!state.accessToken) throw new Error("Not authenticated");

  if (!isTokenExpired(state.accessToken)) {
    return state.accessToken;
  }

  return refreshToken();
}
