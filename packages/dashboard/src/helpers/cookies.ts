import type { Response, CookieOptions } from "express";

const ACCESS_COOKIE = "dominusnode_access";
const REFRESH_COOKIE = "dominusnode_refresh";

// secure flag should be true in production OR when explicitly configured
// (e.g., staging environments behind HTTPS that aren't NODE_ENV=production)
const isSecure = process.env.NODE_ENV === "production" || process.env["COOKIE_SECURE"] === "true";

const BASE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: isSecure,
  sameSite: "strict",
  path: "/api",
};

// Refresh cookie restricted to auth path only — minimizes exposure of long-lived credential
const REFRESH_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: isSecure,
  sameSite: "strict",
  path: "/api/auth",
};

const ACCESS_MAX_AGE = 15 * 60 * 1000; // 15 minutes
const REFRESH_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string,
): void {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...BASE_OPTIONS,
    maxAge: ACCESS_MAX_AGE,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...REFRESH_OPTIONS,
    maxAge: REFRESH_MAX_AGE,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...BASE_OPTIONS });
  res.clearCookie(REFRESH_COOKIE, { ...REFRESH_OPTIONS });
  // Also clear MFA challenge cookie (5-min TTL, but survives logout without this)
  res.clearCookie("dominusnode_mfa_challenge", {
    httpOnly: true,
    secure: isSecure,
    sameSite: "strict",
    path: "/api/auth/mfa",
  });
}

export function getAccessCookieName(): string {
  return ACCESS_COOKIE;
}

export function getRefreshCookieName(): string {
  return REFRESH_COOKIE;
}
