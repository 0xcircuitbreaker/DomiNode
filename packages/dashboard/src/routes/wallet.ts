import { Router } from "express";
import rateLimit from "express-rate-limit";
import {
  walletRepo,
  userRepo,
  usageRepo,
  invoiceRepo,
  validateTopupAmount,
  isValidCryptoCurrency,
  SUPPORTED_CRYPTO,
  createLogger,
  sanitizeString,
} from "@dominusnode/shared";
import type { SupportedCrypto } from "@dominusnode/shared";
import { createCheckoutSession } from "@dominusnode/billing";
import { createCryptoInvoice } from "@dominusnode/billing";
import { createPaypalOrder, capturePaypalOrder } from "@dominusnode/billing";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const log = createLogger("api:wallet");

// R29 C-2: Per-user rate limit on top-up endpoints to prevent invoice spam
const topupLimiter = rateLimit({
  windowMs: 60 * 60_000, // 1 hour
  max: 10, // 10 top-up attempts per hour per user
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many top-up attempts. Please try again later." },
  keyGenerator: (req) => (req as AuthenticatedRequest).user?.userId ?? "unknown",
});

router.use(requireAuth);

// GET /api/wallet
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const wallet = await walletRepo.getWallet(userId);

    if (!wallet) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }

    res.json({
      balanceCents: wallet.balance_cents,
      balanceUsd: Number((wallet.balance_cents / 100).toFixed(2)),
      currency: wallet.currency,
      lastToppedUp: wallet.last_topped_up,
    });
  } catch (err) {
    log.error("wallet fetch failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to fetch wallet" });
  }
});

// GET /api/wallet/transactions
router.get("/transactions", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    // R19 H-2: Cap at 100 to match walletRepo internal limit (was 200, repo caps at 100)
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

    const transactions = await walletRepo.getTransactions(userId, limit, offset);

    res.json({
      transactions: transactions.map((tx) => ({
        id: tx.id,
        type: tx.type,
        amountCents: tx.amount_cents,
        amountUsd: Number((tx.amount_cents / 100).toFixed(2)),
        description: tx.description,
        paymentProvider: tx.payment_provider,
        createdAt: tx.created_at,
      })),
    });
  } catch (err) {
    log.error("transactions fetch failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// POST /api/wallet/topup/stripe
router.post("/topup/stripe", topupLimiter, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    // R36: Require email verification before accepting payments
    const currentUser = await userRepo.findUserById(userId);
    if (!currentUser || !currentUser.email_verified) {
      res.status(403).json({ error: "Please verify your email address before topping up" });
      return;
    }

    const amountCents = parseInt(req.body.amountCents, 10);

    const error = validateTopupAmount(amountCents);
    if (error) {
      res.status(400).json({ error });
      return;
    }

    // R29 C-3: Pre-check wallet balance cap before creating checkout session.
    // Without this, user pays real money but creditWallet fails at MAX_BALANCE_CENTS,
    // resulting in a lost payment.
    const MAX_BALANCE_CENTS = 1_000_000; // $10,000 — matches wallet-repo.ts
    const wallet = await walletRepo.getWallet(userId);
    if (wallet && wallet.balance_cents + amountCents > MAX_BALANCE_CENTS) {
      res.status(400).json({
        error: `Top-up would exceed maximum wallet balance of $10,000. Current balance: $${(wallet.balance_cents / 100).toFixed(2)}`,
      });
      return;
    }

    const session = await createCheckoutSession(userId, amountCents);

    log.info("stripe checkout created", { userId, amountCents });

    res.json({
      sessionId: session.sessionId,
      url: session.url,
    });
  } catch (err) {
    log.error("stripe checkout failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// POST /api/wallet/topup/crypto
router.post("/topup/crypto", topupLimiter, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    // R36: Require email verification before accepting payments
    const cryptoUser = await userRepo.findUserById(userId);
    if (!cryptoUser || !cryptoUser.email_verified) {
      res.status(403).json({ error: "Please verify your email address before topping up" });
      return;
    }

    const amountUsd = parseFloat(req.body.amountUsd);
    const currency = (req.body.currency ?? "").toLowerCase();

    // R23 H-4: Explicit NaN/Infinity check + integer-cents validation
    if (!Number.isFinite(amountUsd) || amountUsd < 10 || amountUsd > 1000) {
      res.status(400).json({ error: "Amount must be between $10 and $1,000" });
      return;
    }
    const amountCents = Math.round(amountUsd * 100);
    if (amountCents < 1000 || amountCents > 100_000) {
      res.status(400).json({ error: "Amount must be between $10 and $1,000" });
      return;
    }

    if (!isValidCryptoCurrency(currency)) {
      res.status(400).json({
        error: `Unsupported currency. Supported: ${SUPPORTED_CRYPTO.join(", ")}`,
      });
      return;
    }

    // R29 C-3: Pre-check wallet balance cap before creating crypto invoice
    const MAX_CRYPTO_BALANCE_CENTS = 1_000_000; // $10,000
    const cryptoWallet = await walletRepo.getWallet(userId);
    if (cryptoWallet && cryptoWallet.balance_cents + amountCents > MAX_CRYPTO_BALANCE_CENTS) {
      res.status(400).json({
        error: `Top-up would exceed maximum wallet balance of $10,000. Current balance: $${(cryptoWallet.balance_cents / 100).toFixed(2)}`,
      });
      return;
    }

    const invoice = await createCryptoInvoice(userId, amountUsd, currency as SupportedCrypto);

    log.info("crypto invoice created", { userId, amountUsd, currency });

    res.json({
      invoiceId: invoice.invoiceId,
      invoiceUrl: invoice.invoiceUrl,
      payCurrency: invoice.payCurrency,
      priceAmount: invoice.priceAmount,
    });
  } catch (err) {
    log.error("crypto invoice failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create crypto invoice" });
  }
});

// R36 H-3: Rate limit payment status polling to prevent abuse
const statusPollLimiter = rateLimit({
  windowMs: 5 * 60_000, // 5 minutes
  max: 30, // 30 checks per 5 min per user
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment status checks. Please wait a moment." },
  keyGenerator: (req) => (req as unknown as AuthenticatedRequest).user?.userId ?? "unknown",
});

// GET /api/wallet/crypto/status/:invoiceId
router.get("/crypto/status/:invoiceId", statusPollLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const invoiceId = sanitizeString((req.params as { invoiceId: string }).invoiceId ?? "", 128);

    if (!invoiceId) {
      res.status(400).json({ error: "Invoice ID is required" });
      return;
    }

    // UUID format validation
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(invoiceId)) {
      res.status(400).json({ error: "Invalid invoice ID format" });
      return;
    }

    const invoice = await invoiceRepo.findInvoiceById(invoiceId, userId);
    if (!invoice) {
      res.status(404).json({ error: "Invoice not found" });
      return;
    }

    res.json({
      invoiceId: invoice.id,
      status: invoice.status,
      amountCents: invoice.amount_cents,
      provider: invoice.provider,
      createdAt: invoice.created_at,
    });
  } catch (err) {
    log.error("crypto status check failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to check payment status" });
  }
});

// POST /api/wallet/topup/paypal
router.post("/topup/paypal", topupLimiter, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    // Require email verification before accepting payments
    const paypalUser = await userRepo.findUserById(userId);
    if (!paypalUser || !paypalUser.email_verified) {
      res.status(403).json({ error: "Please verify your email address before topping up" });
      return;
    }

    const amountCents = parseInt(req.body.amountCents, 10);

    const error = validateTopupAmount(amountCents);
    if (error) {
      res.status(400).json({ error });
      return;
    }

    // Pre-check wallet balance cap
    const MAX_PAYPAL_BALANCE_CENTS = 1_000_000; // $10,000
    const paypalWallet = await walletRepo.getWallet(userId);
    if (paypalWallet && paypalWallet.balance_cents + amountCents > MAX_PAYPAL_BALANCE_CENTS) {
      res.status(400).json({
        error: `Top-up would exceed maximum wallet balance of $10,000. Current balance: $${(paypalWallet.balance_cents / 100).toFixed(2)}`,
      });
      return;
    }

    const order = await createPaypalOrder(userId, amountCents);

    log.info("paypal order created", { userId, amountCents });

    res.json({
      orderId: order.orderId,
      approvalUrl: order.approvalUrl,
      amountCents: order.amountCents,
    });
  } catch (err) {
    log.error("paypal order failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to create PayPal order" });
  }
});

// POST /api/wallet/paypal/capture/:orderId
router.post("/paypal/capture/:orderId", topupLimiter, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    // Require email verification before capturing payments
    const captureUser = await userRepo.findUserById(userId);
    if (!captureUser || !captureUser.email_verified) {
      res.status(403).json({ error: "Please verify your email address before capturing payments" });
      return;
    }

    const orderId = sanitizeString((req.params as { orderId: string }).orderId ?? "", 128);

    if (!orderId) {
      res.status(400).json({ error: "Order ID is required" });
      return;
    }

    const result = await capturePaypalOrder(orderId, userId);

    if (!result) {
      res.status(400).json({ error: "Failed to capture PayPal order" });
      return;
    }

    log.info("paypal order captured", { userId, orderId, amountCents: result.amountCents });

    res.json({
      success: true,
      amountCents: result.amountCents,
    });
  } catch (err) {
    log.error("paypal capture failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to capture PayPal payment" });
  }
});

// GET /api/wallet/paypal/status/:orderId
router.get("/paypal/status/:orderId", statusPollLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const orderId = sanitizeString((req.params as { orderId: string }).orderId ?? "", 128);

    if (!orderId) {
      res.status(400).json({ error: "Order ID is required" });
      return;
    }

    const invoice = await invoiceRepo.findInvoiceByExternalId("paypal", orderId, userId);
    if (!invoice) {
      res.status(404).json({ error: "PayPal order not found" });
      return;
    }

    res.json({
      orderId,
      status: invoice.status,
      amountCents: invoice.amount_cents,
      provider: "paypal",
      createdAt: invoice.created_at,
    });
  } catch (err) {
    log.error("paypal status check failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to check PayPal order status" });
  }
});

// GET /api/wallet/forecast
router.get("/forecast", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    const wallet = await walletRepo.getWallet(userId);
    if (!wallet) {
      res.status(404).json({ error: "Wallet not found" });
      return;
    }

    const now = new Date();

    // Current period: last 7 days
    const currentStart = new Date(now);
    currentStart.setDate(currentStart.getDate() - 7);
    const currentUsage = await usageRepo.getUsageByDay(userId, currentStart, now);

    // Previous period: 7-14 days ago
    const prevStart = new Date(now);
    prevStart.setDate(prevStart.getDate() - 14);
    const prevUsage = await usageRepo.getUsageByDay(userId, prevStart, currentStart);

    const currentTotalCents = currentUsage.reduce((s, d) => s + d.total_cost_cents, 0);
    const prevTotalCents = prevUsage.reduce((s, d) => s + d.total_cost_cents, 0);

    const currentDays = Math.max(currentUsage.length, 1);
    const dailyAvgCents = Math.round(currentTotalCents / currentDays);

    const daysRemaining = dailyAvgCents > 0
      ? Number((wallet.balance_cents / dailyAvgCents).toFixed(1))
      : null; // null = no spending, balance lasts indefinitely

    let trend: "up" | "down" | "stable" = "stable";
    let trendPct = 0;

    if (prevTotalCents > 0) {
      const change = ((currentTotalCents - prevTotalCents) / prevTotalCents) * 100;
      trendPct = Math.round(Math.abs(change));
      if (change > 5) trend = "up";
      else if (change < -5) trend = "down";
    } else if (currentTotalCents > 0) {
      trend = "up";
      trendPct = 100;
    }

    res.json({
      dailyAvgCents,
      daysRemaining,
      trend,
      trendPct,
    });
  } catch (err) {
    log.error("forecast fetch failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to compute forecast" });
  }
});

export default router;
