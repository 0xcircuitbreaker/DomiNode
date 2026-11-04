import type { Request, Response, NextFunction } from "express";
import { verifyJwt, userRepo, hashApiKey, isWalletEmail } from "@dominusnode/shared";
import type { AuthenticatedRequest } from "./auth.js";

/**
 * Agent principal (DESIGN.md §10): either a `dn_live_`/`dn_test_` API key or a
 * JWT belonging to a wallet-identity user (signed in via EIP-191). Wallet users
 * are verified by signature, so routes behind this middleware skip the
 * email-verification gate for them. This middleware never calls reCAPTCHA or
 * MFA. `dn_node_` keys and human (email/password) JWTs are rejected.
 */
export interface AgentPrincipal {
  userId: string;
  email: string;
  walletAddress: string | null;
  via: "api_key" | "wallet_jwt";
  /** True for wallet users (signature-verified) or email-verified API-key owners. */
  verified: boolean;
}

export interface AgentRequest extends AuthenticatedRequest {
  agent: AgentPrincipal;
}

const MAX_TOKEN_LEN = 4096;

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  if (!t || t.length > MAX_TOKEN_LEN) return null;
  return t;
}

export async function requireAgentPrincipal(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Bearer header only: cookies are a human-browser channel and CSRF-prone.
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  if (token.startsWith("dn_node_")) {
    res.status(401).json({ error: "Node keys cannot be used for this endpoint" });
    return;
  }

  try {
    let principal: AgentPrincipal;
    if (token.startsWith("dn_live_") || token.startsWith("dn_test_")) {
      const found = await userRepo.findUserByApiKeyHash(hashApiKey(token));
      if (!found || found.user.status !== "active") {
        res.status(401).json({ error: "Invalid API key" });
        return;
      }
      const u = found.user;
      const wallet = u.wallet_address ? u.wallet_address.toLowerCase() : null;
      principal = {
        userId: u.id,
        email: u.email,
        walletAddress: wallet,
        via: "api_key",
        verified: isWalletEmail(u.email) || u.email_verified === true,
      };
    } else {
      const payload = verifyJwt(token);
      if (!payload) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
      }
      const u = await userRepo.findUserById(payload.userId);
      if (!u || u.status !== "active") {
        res.status(401).json({ error: "Account is no longer active" });
        return;
      }
      if (!isWalletEmail(u.email) || !u.wallet_address) {
        res.status(403).json({ error: "Agent endpoints require an API key or wallet sign-in" });
        return;
      }
      principal = {
        userId: u.id,
        email: u.email,
        walletAddress: u.wallet_address.toLowerCase(),
        via: "wallet_jwt",
        verified: true,
      };
    }
    const r = req as AgentRequest;
    r.agent = principal;
    r.user = { userId: principal.userId, email: principal.email };
    next();
  } catch {
    res.status(500).json({ error: "Authentication check failed" });
  }
}
