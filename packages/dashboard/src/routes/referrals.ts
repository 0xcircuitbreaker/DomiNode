import { Router } from "express";
import * as crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { referralRepo, userRepo, createLogger, sanitizeString } from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const log = createLogger("api:referrals");

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Referral codes: 8 alphanumeric characters
const CODE_REGEX = /^[A-Za-z0-9]{4,20}$/;

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function generateCode(): string {
  // 8 alphanumeric chars, readable (no 0/O/I/l)
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i]! % chars.length];
  }
  return code;
}

// All routes require auth
router.use(requireAuth);

// Rate limiters
const createCodeLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthenticatedRequest).user.userId,
  message: { error: "Too many referral codes created. Try again later." },
});

const redeemPromoLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthenticatedRequest).user.userId,
  message: { error: "Too many promo redemptions. Try again later." },
});

const payoutLimiter = rateLimit({
  windowMs: 24 * 60 * 60_000,
  max: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthenticatedRequest).user.userId,
  message: { error: "Commission payout limited to once per day." },
});

// ─── Referral Codes ──────────────────────────────────────────────────

// POST /api/referrals/code — create referral code
router.post("/code", createCodeLimiter, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const codeUser = await userRepo.findUserById(authReq.user.userId);
    if (!codeUser?.email_verified) {
      res.status(403).json({ error: "Email verification required to create referral codes", code: "EMAIL_NOT_VERIFIED" });
      return;
    }

    const rawCode = generateCode();
    const codeHash = hashCode(rawCode.toUpperCase());
    const codePrefix = rawCode.slice(0, 4);

    const maxUses = typeof req.body?.maxUses === "number" && req.body.maxUses > 0
      ? Math.min(req.body.maxUses, 100000) : 0;
    // Referrals no longer pay a balance bonus (free credit comes only from the
    // starter-credit grant ledger), so new codes carry no credit amount.
    const creditCents = 0;

    const code = await referralRepo.createReferralCode(
      authReq.user.userId,
      codeHash,
      codePrefix,
      { maxUses, creditCents },
    );

    log.info("referral code created", { userId: authReq.user.userId, codeId: code.id });
    res.status(201).json({
      code: rawCode,
      id: code.id,
      prefix: code.code_prefix,
      maxUses: code.max_uses,
      creditCents: code.credit_cents,
      expiresAt: code.expires_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create referral code";
    if (msg.includes("Maximum")) {
      res.status(400).json({ error: msg });
      return;
    }
    log.error("create referral code failed", { error: msg });
    res.status(500).json({ error: "Failed to create referral code" });
  }
});

// GET /api/referrals/codes — list own codes
router.get("/codes", async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const codes = await referralRepo.listReferralCodes(authReq.user.userId);
    res.json({
      codes: codes.map((c) => ({
        id: c.id,
        prefix: c.code_prefix,
        maxUses: c.max_uses,
        uses: c.uses,
        creditCents: c.credit_cents,
        active: c.active,
        expiresAt: c.expires_at,
        createdAt: c.created_at,
      })),
    });
  } catch (err) {
    log.error("list referral codes failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list referral codes" });
  }
});

// DELETE /api/referrals/codes/:id — disable code
router.delete("/codes/:id", async (req, res) => {
  try {
    const authReq = req as unknown as AuthenticatedRequest;
    const codeId = req.params.id ?? "";
    if (!UUID_REGEX.test(codeId)) {
      res.status(400).json({ error: "Invalid code ID" });
      return;
    }
    const disabled = await referralRepo.disableReferralCode(authReq.user.userId, codeId);
    if (!disabled) {
      res.status(404).json({ error: "Code not found or already disabled" });
      return;
    }
    res.json({ success: true });
  } catch (err) {
    log.error("disable referral code failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to disable referral code" });
  }
});

// GET /api/referrals/stats — referral + affiliate stats
router.get("/stats", async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const [refStats, affStats] = await Promise.all([
      referralRepo.getReferralStats(authReq.user.userId),
      referralRepo.getAffiliateStats(authReq.user.userId),
    ]);
    res.json({ referral: refStats, affiliate: affStats });
  } catch (err) {
    log.error("get referral stats failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get stats" });
  }
});

// GET /api/referrals/referees — list referred users (masked email)
router.get("/referees", async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const referees = await referralRepo.listAffiliateReferees(authReq.user.userId);
    res.json({ referees });
  } catch (err) {
    log.error("list referees failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list referees" });
  }
});

// GET /api/referrals/commissions — affiliate commission history
router.get("/commissions", async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const commissions = await referralRepo.listCommissions(authReq.user.userId);
    res.json({
      commissions: commissions.map((c) => ({
        id: c.id,
        topupCents: c.topup_cents,
        commissionCents: c.commission_cents,
        commissionRate: c.commission_rate,
        status: c.status,
        creditedAt: c.credited_at,
        createdAt: c.created_at,
      })),
    });
  } catch (err) {
    log.error("list commissions failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list commissions" });
  }
});

// POST /api/referrals/commissions/payout — request commission payout
router.post("/commissions/payout", payoutLimiter, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const payoutUser = await userRepo.findUserById(authReq.user.userId);
    if (!payoutUser?.email_verified) {
      res.status(403).json({ error: "Email verification required for payouts", code: "EMAIL_NOT_VERIFIED" });
      return;
    }
    const totalCents = await referralRepo.creditPendingCommissions(authReq.user.userId);
    if (totalCents === 0) {
      res.json({ success: true, amountCents: 0, message: "No pending commissions to pay out" });
      return;
    }
    log.info("commission payout", { userId: authReq.user.userId, amountCents: totalCents });
    res.json({ success: true, amountCents: totalCents });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Payout failed";
    if (msg.includes("balance cap")) {
      res.status(400).json({ error: msg });
      return;
    }
    log.error("commission payout failed", { error: msg });
    res.status(500).json({ error: "Payout failed" });
  }
});

// GET /api/referrals/loyalty — current loyalty tier + status
router.get("/loyalty", async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const status = await referralRepo.calculateLoyaltyStatus(authReq.user.userId);
    res.json(status);
  } catch (err) {
    log.error("get loyalty status failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get loyalty status" });
  }
});

// GET /api/referrals/loyalty/history — loyalty reward history
router.get("/loyalty/history", async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const history = await referralRepo.getLoyaltyHistory(authReq.user.userId);
    res.json({ rewards: history });
  } catch (err) {
    log.error("get loyalty history failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get loyalty history" });
  }
});

// POST /api/referrals/promo/redeem — redeem a promo code
router.post("/promo/redeem", redeemPromoLimiter, async (req, res) => {
  try {
    const authReq = req as AuthenticatedRequest;
    const code = typeof req.body?.code === "string" ? sanitizeString(req.body.code.trim().toUpperCase(), 20) : "";
    if (!code || !CODE_REGEX.test(code)) {
      res.status(400).json({ error: "Invalid promo code format" });
      return;
    }

    const codeHash = hashCode(code);
    const redemption = await referralRepo.redeemPromoCode(codeHash, authReq.user.userId);
    if (!redemption) {
      res.status(404).json({ error: "Invalid or expired promo code" });
      return;
    }

    log.info("promo code redeemed", { userId: authReq.user.userId, creditCents: redemption.credit_cents });
    res.json({ success: true, creditCents: redemption.credit_cents });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Redemption failed";
    if (msg.includes("already redeemed") || msg.includes("balance cap")) {
      res.status(400).json({ error: msg });
      return;
    }
    log.error("promo redemption failed", { error: msg });
    res.status(500).json({ error: "Failed to redeem promo code" });
  }
});

// GET /api/referrals/promo/check/:code — check if promo code is valid
// NOTE: This endpoint IS behind requireAuth (applied via router.use above).
// For unauthenticated promo checks (landing pages), mount a separate route in server.ts.
const promoCheckLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many promo checks. Try again later." },
});

// Apply promoCheckLimiter to rate-limit this endpoint
// Only return { valid: true/false } — do NOT leak creditCents or remainingUses
// (reveals internal business data and enables code enumeration/value probing)
router.get("/promo/check/:code", promoCheckLimiter, async (req, res) => {
  try {
    const code = typeof req.params.code === "string" ? sanitizeString(req.params.code.trim().toUpperCase(), 20) : "";
    if (!code || !CODE_REGEX.test(code)) {
      res.status(400).json({ valid: false, error: "Invalid code format" });
      return;
    }
    const codeHash = hashCode(code);
    const promo = await referralRepo.findPromoCodeByHash(codeHash);
    // Identical response shape for valid/invalid to prevent enumeration
    res.json({ valid: !!promo });
  } catch (err) {
    log.error("promo check failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ valid: false, error: "Check failed" });
  }
});

export default router;
