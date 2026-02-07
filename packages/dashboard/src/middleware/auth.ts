import type { Request, Response, NextFunction } from "express";
import { verifyJwt, userRepo } from "@dominode/shared";
import type { JwtPayload } from "@dominode/shared";

export interface AuthenticatedRequest extends Request {
  user: JwtPayload;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header required (Bearer token)" });
    return;
  }

  const token = authHeader.slice(7);
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
  } catch {
    res.status(500).json({ error: "Authentication check failed" });
    return;
  }

  (req as AuthenticatedRequest).user = payload;
  next();
}
