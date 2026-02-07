import { Router } from "express";
import {
  walletRepo,
  validateTopupAmount,
  isValidCryptoCurrency,
  createLogger,
} from "@dominode/shared";
import type { SupportedCrypto } from "@dominode/shared";
import { createCheckoutSession } from "@dominode/billing";
import { createCryptoInvoice } from "@dominode/billing";
import { requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
const log = createLogger("api:wallet");

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
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;

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
router.post("/topup/stripe", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const amountCents = parseInt(req.body.amountCents, 10);

    const error = validateTopupAmount(amountCents);
    if (error) {
      res.status(400).json({ error });
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
router.post("/topup/crypto", async (req, res) => {
  try {
    const { userId } = (req as AuthenticatedRequest).user;
    const amountUsd = parseFloat(req.body.amountUsd);
    const currency = (req.body.currency ?? "").toLowerCase();

    if (!amountUsd || amountUsd < 5 || amountUsd > 1000) {
      res.status(400).json({ error: "Amount must be between $5 and $1,000" });
      return;
    }

    if (!isValidCryptoCurrency(currency)) {
      res.status(400).json({
        error: "Unsupported currency. Supported: btc, eth, xmr, sol, zec",
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

export default router;
