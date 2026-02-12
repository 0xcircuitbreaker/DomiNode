import type { Request, Response, NextFunction } from "express";
import { verifyJwt, userRepo } from "@dominode/shared";
import type { JwtPayload } from "@dominode/shared";

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

function extractToken(req: Request): string | null {
  // Priority: cookie > Bearer header
  // This supports both browser (cookies) and extension (Bearer) simultaneously
  const cookieToken = req.cookies?.dominode_access;
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const payload = verifyJwt(token);

  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  // Verify user still exists and is active (handles suspended/deleted users)
  try {
    const user = await userRepo.findUserById(payload.userId);
    if (!user || user.status !== "active") {
      res.status(401).json({ error: "Account is no longer active" });
      return;
    }
    // Refresh isAdmin from DB to prevent stale JWT claims (up to 15 min lag)
    payload.isAdmin = user.is_admin === true;
  } catch {
    res.status(500).json({ error: "Authentication check failed" });
    return;
  }

  (req as AuthenticatedRequest).user = payload;
  next();
}
