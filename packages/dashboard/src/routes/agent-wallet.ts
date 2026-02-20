import { Router } from "express";
import rateLimit from "express-rate-limit";
import { agenticWalletRepo, userRepo, createLogger, sanitizeString, SUPPORTED_CRYPTO } from "@dominusnode/shared";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const log = createLogger("api:agent-wallet");

// UUID v4 validation regex
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// R33 H-1: Per-user rate limit on financial agentic wallet operations
const financialLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many agentic wallet operations. Please try again later." },
  keyGenerator: (req) => (req as unknown as AuthenticatedRequest).user?.userId ?? "unknown",
});

router.use(requireAuth);

// POST /api/agent-wallet — Create a new agentic wallet
router.post("/", financialLimiter, async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;

    // R37 C-5: Require verified email before creating agentic wallets
    const agUser = await userRepo.findUserById(userId);
    if (!agUser || !agUser.email_verified) {
      res.status(403).json({ error: "Email verification required before creating agentic wallets" });
      return;
    }

    const label = sanitizeString(typeof req.body.label === "string" ? req.body.label : "", 100);
    const spendingLimitCents = parseInt(req.body.spendingLimitCents, 10);

    if (!label || label.length > 100) {
      res.status(400).json({ error: "Label must be 1-100 characters" });
      return;
    }

    if (!Number.isFinite(spendingLimitCents) || spendingLimitCents < 0 || spendingLimitCents > 1_000_000) {
      res.status(400).json({ error: "Spending limit must be between 0 and 1,000,000 cents ($10,000)" });
      return;
    }

    const wallet = await agenticWalletRepo.createWallet(userId, label, spendingLimitCents);
    log.info("agentic wallet created", { userId, walletId: wallet.id });

    res.status(201).json({
      id: wallet.id,
      label: wallet.label,
      balanceCents: wallet.balance_cents,
      spendingLimitCents: wallet.spending_limit_cents,
      status: wallet.status,
      createdAt: wallet.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Maximum of")) {
      res.status(409).json({ error: msg });
      return;
    }
    log.error("create agentic wallet failed", { error: msg });
    res.status(500).json({ error: "Failed to create agentic wallet" });
  }
});

// GET /api/agent-wallet — List all agentic wallets
router.get("/", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const wallets = await agenticWalletRepo.listWallets(userId);

    res.json({
      wallets: wallets.map((w) => ({
        id: w.id,
        label: w.label,
        balanceCents: w.balance_cents,
        spendingLimitCents: w.spending_limit_cents,
        status: w.status,
        createdAt: w.created_at,
      })),
    });
  } catch (err) {
    log.error("list agentic wallets failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to list agentic wallets" });
  }
});

// GET /api/agent-wallet/:id — Get single agentic wallet
router.get("/:id", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const walletId = req.params.id;

    if (!UUID_RE.test(walletId)) {
      res.status(400).json({ error: "Invalid wallet ID format" });
      return;
    }

    const wallet = await agenticWalletRepo.getWallet(walletId, userId);
    if (!wallet) {
      res.status(404).json({ error: "Agentic wallet not found" });
      return;
    }

    res.json({
      id: wallet.id,
      label: wallet.label,
      balanceCents: wallet.balance_cents,
      spendingLimitCents: wallet.spending_limit_cents,
      status: wallet.status,
      createdAt: wallet.created_at,
    });
  } catch (err) {
    log.error("get agentic wallet failed", { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: "Failed to get agentic wallet" });
  }
});

// POST /api/agent-wallet/:id/fund — Fund from main wallet
router.post("/:id/fund", financialLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;

    // R37 C-5: Require verified email before funding agentic wallets
    const fundUser = await userRepo.findUserById(userId);
    if (!fundUser || !fundUser.email_verified) {
      res.status(403).json({ error: "Email verification required before funding agentic wallets" });
      return;
    }

    const walletId = req.params.id as string;
    const amountCents = parseInt(req.body.amountCents, 10);

    if (!UUID_RE.test(walletId)) {
      res.status(400).json({ error: "Invalid wallet ID format" });
      return;
    }

    if (!Number.isFinite(amountCents) || amountCents < 100 || amountCents > 1_000_000) {
      res.status(400).json({ error: "Amount must be between 100 and 1,000,000 cents ($1 - $10,000)" });
      return;
    }

    const tx = await agenticWalletRepo.fundWallet(userId, walletId, amountCents);
    log.info("agentic wallet funded", { userId, walletId, amountCents });

    res.json({
      transaction: {
        id: tx.id,
        walletId: tx.wallet_id,
        type: tx.type,
        amountCents: tx.amount_cents,
        description: tx.description,
        createdAt: tx.created_at,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Insufficient balance") || msg.includes("balance cap")) {
      res.status(400).json({ error: msg });
      return;
    }
    if (msg.includes("not found") || msg.includes("not active")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("fund agentic wallet failed", { error: msg });
    res.status(500).json({ error: "Failed to fund agentic wallet" });
  }
});

// GET /api/agent-wallet/:id/transactions — Paginated transaction history
router.get("/:id/transactions", async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const walletId = req.params.id;

    if (!UUID_RE.test(walletId)) {
      res.status(400).json({ error: "Invalid wallet ID format" });
      return;
    }

    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string, 10) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string, 10) || 0);

    const transactions = await agenticWalletRepo.getTransactions(walletId, userId, limit, offset);

    res.json({
      transactions: transactions.map((tx) => ({
        id: tx.id,
        walletId: tx.wallet_id,
        type: tx.type,
        amountCents: tx.amount_cents,
        description: tx.description,
        sessionId: tx.session_id,
        createdAt: tx.created_at,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found")) {
      res.status(404).json({ error: "Agentic wallet not found" });
      return;
    }
    log.error("get agentic wallet transactions failed", { error: msg });
    res.status(500).json({ error: "Failed to get transactions" });
  }
});

// POST /api/agent-wallet/:id/freeze — Freeze wallet
router.post("/:id/freeze", financialLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const walletId = req.params.id as string;

    if (!UUID_RE.test(walletId)) {
      res.status(400).json({ error: "Invalid wallet ID format" });
      return;
    }

    const wallet = await agenticWalletRepo.freezeWallet(walletId, userId);
    log.info("agentic wallet frozen", { userId, walletId });

    res.json({
      id: wallet.id,
      label: wallet.label,
      balanceCents: wallet.balance_cents,
      spendingLimitCents: wallet.spending_limit_cents,
      status: wallet.status,
      createdAt: wallet.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("not active")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("freeze agentic wallet failed", { error: msg });
    res.status(500).json({ error: "Failed to freeze agentic wallet" });
  }
});

// R33 H-8: POST /api/agent-wallet/:id/unfreeze — Unfreeze wallet
router.post("/:id/unfreeze", financialLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const walletId = req.params.id as string;

    if (!UUID_RE.test(walletId)) {
      res.status(400).json({ error: "Invalid wallet ID format" });
      return;
    }

    const wallet = await agenticWalletRepo.unfreezeWallet(walletId, userId);
    log.info("agentic wallet unfrozen", { userId, walletId });

    res.json({
      id: wallet.id,
      label: wallet.label,
      balanceCents: wallet.balance_cents,
      spendingLimitCents: wallet.spending_limit_cents,
      status: wallet.status,
      createdAt: wallet.created_at,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("not frozen")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("unfreeze agentic wallet failed", { error: msg });
    res.status(500).json({ error: "Failed to unfreeze agentic wallet" });
  }
});

// DELETE /api/agent-wallet/:id — Delete wallet + refund balance to main
router.delete("/:id", financialLimiter, async (req, res) => {
  try {
    const { userId } = (req as unknown as AuthenticatedRequest).user;
    const walletId = req.params.id as string;

    if (!UUID_RE.test(walletId)) {
      res.status(400).json({ error: "Invalid wallet ID format" });
      return;
    }

    const result = await agenticWalletRepo.deleteWallet(walletId, userId);
    log.info("agentic wallet deleted", { userId, walletId, refundedCents: result.refundedCents });

    res.json({
      deleted: true,
      refundedCents: result.refundedCents,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Cannot delete")) {
      res.status(400).json({ error: msg });
      return;
    }
    if (msg.includes("not found")) {
      res.status(404).json({ error: msg });
      return;
    }
    log.error("delete agentic wallet failed", { error: msg });
    res.status(500).json({ error: "Failed to delete agentic wallet" });
  }
});

export default router;
