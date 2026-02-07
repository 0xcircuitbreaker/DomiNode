import type { Request, Response, NextFunction } from "express";
import { userRepo } from "@dominode/shared";
import type { AuthenticatedRequest } from "./auth.js";

/**
 * Middleware that checks if the authenticated user is an admin.
 * Must be used AFTER requireAuth middleware.
 * Returns 403 if user is not admin.
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const { userId } = (req as AuthenticatedRequest).user;

  try {
    const user = await userRepo.findUserById(userId);
    if (!user || !user.is_admin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    next();
  } catch {
    res.status(500).json({ error: "Authorization check failed" });
  }
}
