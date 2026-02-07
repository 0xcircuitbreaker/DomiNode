import Stripe from "stripe";
import { walletRepo, invoiceRepo, createLogger } from "@dominode/shared";

const log = createLogger("billing:stripe");

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
  const stripe = getStripe();
  const successUrl = process.env["STRIPE_SUCCESS_URL"] ?? "http://localhost:5173/wallet?topup=success";
  const cancelUrl = process.env["STRIPE_CANCEL_URL"] ?? "http://localhost:5173/wallet?topup=cancel";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: amountCents,
          product_data: {
            name: "DomiNode Wallet Top-Up",
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

  try {
    await walletRepo.creditWallet(
      userId,
      amountCents,
      "stripe",
      session.id,
      `Stripe top-up $${(amountCents / 100).toFixed(2)}`,
    );
    await invoiceRepo.completeInvoice(invoice.id);
    log.info("wallet credited via Stripe", { userId, amountCents });
    return { userId, amountCents };
  } catch (err) {
    if (err instanceof Error && err.message.includes("duplicate")) {
      log.info("duplicate Stripe webhook ignored", { sessionId: session.id });
      return { userId, amountCents };
    }
    throw err;
  }
}
