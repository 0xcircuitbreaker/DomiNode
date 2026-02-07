import { Router } from "express";
import {
  userRepo,
  walletRepo,
  hashPassword,
  verifyPassword,
  createTokenPair,
  verifyRefreshToken,
  signJwt,
  isValidEmail,
  validatePassword,
  sanitizeString,
  createLogger,
} from "@dominode/shared";

const router = Router();
const log = createLogger("api:auth");

// POST /api/auth/register
router.post("/register", async (req, res) => {
  try {
    const email = sanitizeString(req.body.email ?? "", 254).toLowerCase();
    const password = req.body.password ?? "";

    if (!isValidEmail(email)) {
      res.status(400).json({ error: "Invalid email address" });
      return;
    }

    const pwError = validatePassword(password);
    if (pwError) {
      res.status(400).json({ error: pwError });
      return;
    }

    const passwordHash = await hashPassword(password);

    let user;
    try {
      user = await userRepo.createUser(email, passwordHash);
    } catch (err) {
      // Unique constraint violation → don't reveal whether email exists
      if (err instanceof Error && (err.message.includes("duplicate") || err.message.includes("unique"))) {
        res.status(409).json({ error: "Registration failed. Please try a different email." });
        return;
      }
      throw err;
    }

    await walletRepo.createWallet(user.id);

    const tokens = createTokenPair({ userId: user.id, email: user.email });

    log.info("user registered", { userId: user.id });

    res.status(201).json({
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        is_admin: user.is_admin ?? false,
      },
    });
  } catch (err) {
    log.error("registration failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const email = sanitizeString(req.body.email ?? "", 254).toLowerCase();
    const password = req.body.password ?? "";

    const user = await userRepo.findUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    // Check password BEFORE revealing account status (prevents enumeration)
    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (user.status !== "active") {
      res.status(403).json({ error: "Account is suspended or disabled" });
      return;
    }

    const tokens = createTokenPair({ userId: user.id, email: user.email });

    log.info("user logged in", { userId: user.id });

    res.json({
      token: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        is_admin: user.is_admin ?? false,
      },
    });
  } catch (err) {
    log.error("login failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/auth/refresh — exchange refresh token for new access token
router.post("/refresh", async (req, res) => {
  try {
    const refreshToken = req.body.refreshToken ?? "";
    if (!refreshToken) {
      res.status(400).json({ error: "Refresh token required" });
      return;
    }

    const payload = verifyRefreshToken(refreshToken);
    if (!payload) {
      res.status(401).json({ error: "Invalid or expired refresh token" });
      return;
    }

    // Verify user still exists and is active
    const user = await userRepo.findUserById(payload.userId);
    if (!user || user.status !== "active") {
      res.status(401).json({ error: "Account is no longer active" });
      return;
    }

    // H11: Check if password was changed after refresh token was issued
    // If user has a password_changed_at field and it's after the token iat, reject
    if (payload.iat && user.password_changed_at) {
      const tokenIssuedAt = payload.iat * 1000; // JWT iat is in seconds
      if (new Date(user.password_changed_at).getTime() > tokenIssuedAt) {
        res.status(401).json({ error: "Token invalidated by password change" });
        return;
      }
    }

    // Issue new access token only (don't rotate refresh token on every call)
    const accessToken = signJwt({ userId: user.id, email: user.email });

    res.json({ token: accessToken });
  } catch (err) {
    log.error("token refresh failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Token refresh failed" });
  }
});

export default router;
