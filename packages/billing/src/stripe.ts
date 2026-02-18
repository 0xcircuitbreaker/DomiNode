import Stripe from "stripe";
import { walletRepo, invoiceRepo, createLogger } from "@dominusnode/shared";

const log = createLogger("billing:stripe");

function validateRedirectUrl(envVar: string, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${envVar} is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${envVar} must use http or https protocol: ${url}`);
  }
  const allowedOrigins = (process.env["CORS_ORIGINS"] ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim());
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new Error(`${envVar} origin ${parsed.origin} is not in CORS_ORIGINS (${allowedOrigins.join(", ")})`);
  }
}

const STRIPE_SUCCESS_URL = process.env["STRIPE_SUCCESS_URL"] ?? "http://localhost:5173/wallet?topup=success";
const STRIPE_CANCEL_URL = process.env["STRIPE_CANCEL_URL"] ?? "http://localhost:5173/wallet?topup=cancel";

// Redirect URL validation is deferred to first use (createCheckoutSession) to
// prevent module-level crashes when CORS_ORIGINS doesn't include the redirect URL origin
let redirectUrlsValidated = false;

let stripeInstance: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeInstance) {
    const key = process.env["STRIPE_SECRET_KEY"];
    if (!key) throw new Error("STRIPE_SECRET_KEY is required");
    stripeInstance = new Stripe(key);
  }
  return stripeInstance;
}

export async function createCheckoutSession(
  userId: string,
  amountCents: number,
): Promise<{ sessionId: string; url: string }> {
  // R30 C-2: Defense-in-depth validation (callers should also validate)
  if (!Number.isInteger(amountCents) || amountCents < 500 || amountCents > 100_000) {
    throw new Error("Invalid top-up amount: must be integer between 500 and 100000 cents");
  }

  // Validate redirect URLs on first use (deferred from module load to prevent import crash)
  if (!redirectUrlsValidated) {
    validateRedirectUrl("STRIPE_SUCCESS_URL", STRIPE_SUCCESS_URL);
    validateRedirectUrl("STRIPE_CANCEL_URL", STRIPE_CANCEL_URL);
    redirectUrlsValidated = true;
  }

  const stripe = getStripe();
  const successUrl = STRIPE_SUCCESS_URL;
  const cancelUrl = STRIPE_CANCEL_URL;

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: "Dominus Node Wallet Top-Up",
            description: `Add $${(amountCents / 100).toFixed(2)} to your proxy balance`,
          },
        },
        quantity: 1,
      },
    ],
    metadata: {
      userId,
      amountCents: String(amountCents),
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  await invoiceRepo.createInvoice(userId, "stripe", session.id, amountCents);

  log.info("checkout session created", { userId, amountCents, sessionId: session.id });

  return {
    sessionId: session.id,
    url: session.url ?? "",
  };
}

export async function handleCheckoutWebhook(
  rawBody: Buffer,
  signature: string,
): Promise<{ userId: string; amountCents: number } | null> {
  const stripe = getStripe();
  const webhookSecret = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET is required");

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    log.error("webhook signature verification failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (event.type !== "checkout.session.completed") {
    return null;
  }

  const session = event.data.object as Stripe.Checkout.Session;

  // R24 H-3: Verify payment is actually completed — some payment methods can fire completed without paid status
  if (session.payment_status !== "paid") {
    log.warn("checkout session completed but payment_status is not paid", {
      sessionId: session.id, paymentStatus: session.payment_status,
    });
    return null;
  }

  const amountCents = session.amount_total ?? 0;

  if (amountCents <= 0) {
    log.error("invalid amount in checkout session", { sessionId: session.id, amountCents });
    return null;
  }

  // Look up the invoice we created at checkout time
  const invoice = await invoiceRepo.findInvoice("stripe", session.id);
  if (!invoice) {
    log.error("no matching invoice found for Stripe session", { sessionId: session.id });
    return null;
  }

  // R30 H-3: Reject webhooks for invoices that have been permanently failed
  if (invoice.status === "failed") {
    log.warn("webhook received for failed invoice, ignoring", { externalId: session.id });
    return null;
  }

  // Verify the Stripe payment amount matches what we originally requested
  if (invoice.amount_cents !== amountCents) {
    log.error("amount mismatch between invoice and Stripe session", {
      sessionId: session.id,
      invoiceAmountCents: invoice.amount_cents,
      stripeAmountCents: amountCents,
    });
    return null;
  }

  const userId = invoice.user_id;

  // Atomically mark invoice as completed — only one concurrent webhook
  // can succeed here since UPDATE ... WHERE status='pending' is atomic.
  const claimed = await invoiceRepo.completeInvoice(invoice.id);
  if (!claimed) {
    log.info("duplicate Stripe webhook ignored (invoice already completed)", { sessionId: session.id });
    return { userId, amountCents: invoice.amount_cents };
  }

  // R31 H-2: Credit invoice.amount_cents (our stored truth) not Stripe's amount_total
  // — prevents crediting a manipulated amount if Stripe session data were ever tampered with.
  // (The amounts are verified equal above, but defense-in-depth: trust our DB value.)
  const creditAmountCents = invoice.amount_cents;
  try {
    await walletRepo.creditWallet(
      userId,
      creditAmountCents,
      "stripe",
      session.id,
      `Stripe top-up $${(creditAmountCents / 100).toFixed(2)}`,
    );
  } catch (creditErr) {
    // R30 C-1: Do NOT revert to pending — this creates infinite retry loops.
    // Mark as failed; operator can manually reconcile if needed.
    log.error("wallet credit failed after invoice completion — marking invoice as failed", {
      invoiceId: invoice.id, userId, sessionId: session.id,
      error: creditErr instanceof Error ? creditErr.message : String(creditErr),
    });
    try { await invoiceRepo.markCreditFailed(invoice.id); } catch { /* best effort */ }
    throw creditErr;
  }
  log.info("wallet credited via Stripe", { userId, amountCents: creditAmountCents });
  return { userId, amountCents: creditAmountCents };
}
