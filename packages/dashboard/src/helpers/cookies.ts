import type { Response, CookieOptions } from "express";

const ACCESS_COOKIE = "dominode_access";
const REFRESH_COOKIE = "dominode_refresh";

// R15 H-4: secure flag should be true in production OR when explicitly configured
// (e.g., staging environments behind HTTPS that aren't NODE_ENV=production)
const isSecure = process.env.NODE_ENV === "production" || process.env["COOKIE_SECURE"] === "true";

const BASE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: isSecure,
  sameSite: "strict",
  path: "/api",
};

// Refresh cookie restricted to auth path only — minimizes exposure of long-lived credential (R13 H-5)
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
}

export function getAccessCookieName(): string {
  return ACCESS_COOKIE;
}

export function getRefreshCookieName(): string {
  return REFRESH_COOKIE;
}
