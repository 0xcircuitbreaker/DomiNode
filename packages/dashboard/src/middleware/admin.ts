import type { Request, Response, NextFunction } from "express";
import { userRepo, hasMinRole } from "@dominusnode/shared";
import type { AdminRole } from "@dominusnode/shared";
import type { AuthenticatedRequest } from "./auth.js";

/**
 * Factory that creates a middleware requiring a minimum admin role.
 * Looks up the user from DB on every request (never trusts JWT alone).
 */
function requireMinRole(minRole: AdminRole, label: string) {
  return async function (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const { userId } = (req as AuthenticatedRequest).user;

    try {
      const user = await userRepo.findUserById(userId);
      if (!user || !hasMinRole(user.admin_role ?? "none", minRole)) {
        res.status(403).json({ error: `${label} access required` });
        return;
      }
      // Refresh role info on the request payload for downstream use
      (req as AuthenticatedRequest).user.isAdmin = user.is_admin;
      (req as AuthenticatedRequest).user.adminRole = user.admin_role;
      next();
    } catch {
      res.status(500).json({ error: "Authorization check failed" });
    }
  };
}

/**
 * Middleware that checks if the authenticated user is any admin role (admin+).
 * Must be used AFTER requireAuth middleware.
 */
export const requireAdmin = requireMinRole("admin", "Admin");

/**
 * Middleware requiring cybersecurity_admin or root_admin role.
 * Grants access to: bug bounties, credit operations, plus all admin duties.
 */
export const requireCybersecurityAdmin = requireMinRole("cybersecurity_admin", "Cybersecurity Admin");

/**
 * Middleware requiring root_admin role (the account in root_admin_identity).
 * Grants access to: role management (grant/revoke admin status).
 */
export const requireRootAdmin = requireMinRole("root_admin", "Root Admin");
