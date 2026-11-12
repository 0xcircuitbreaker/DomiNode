import type { Request, Response, NextFunction } from "express";

/**
 * Human (email/password) auth is admin-only and off by default.
 *
 * ADMIN_HUMAN_LOGIN=true   enables /api/auth/{register,login,forgot-password,
 *                          reset-password,mfa/*}; otherwise they answer 404.
 * With it on, login only succeeds for users whose admin_role is not 'none'.
 * Registration stays closed unless ADMIN_BOOTSTRAP_EMAIL names the address
 * of the first admin and no admin exists yet.
 *
 * Read on every request so tests and operators can flip it without a rebuild.
 */
export function isHumanLoginEnabled(): boolean {
  return process.env["ADMIN_HUMAN_LOGIN"] === "true";
}

export function getBootstrapAdminEmail(): string | null {
  const v = (process.env["ADMIN_BOOTSTRAP_EMAIL"] ?? "").trim().toLowerCase();
  return v.length > 0 && v.length <= 254 && v.includes("@") ? v : null;
}

/** Paths (relative to /api/auth) that belong to human login. */
export function isHumanAuthPath(path: string): boolean {
  return (
    path === "/register" ||
    path === "/login" ||
    path === "/forgot-password" ||
    path === "/reset-password" ||
    path === "/mfa" ||
    path.startsWith("/mfa/")
  );
}

/** Router middleware: 404 for human-auth paths while ADMIN_HUMAN_LOGIN is off. */
export function humanAuthGate(req: Request, res: Response, next: NextFunction): void {
  if (!isHumanLoginEnabled() && isHumanAuthPath(req.path)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}
