import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

const STRIPE_PAY_MAX = 5;
const STRIPE_PAY_WINDOW_MS = 3_600_000;
const stripePayTimestamps: number[] = [];

function checkStripePayLimit(): boolean {
  const now = Date.now();
  while (stripePayTimestamps.length > 0 && now - stripePayTimestamps[0] > STRIPE_PAY_WINDOW_MS) {
    stripePayTimestamps.shift();
  }
  if (stripePayTimestamps.length > 100) stripePayTimestamps.length = 100;
  if (stripePayTimestamps.length >= STRIPE_PAY_MAX) return false;
  stripePayTimestamps.push(now);
  return true;
}

export function registerStripeTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_pay_stripe",
    "Create a Stripe checkout session to top up your Dominus Node wallet with a credit/debit card or Apple Pay/Google Pay/Link. Returns a checkout URL where the user completes payment. After payment, the wallet is credited automatically via webhook.",
    {
      amount_cents: z.number().int().min(500).max(100000).describe("Amount in cents to add to wallet (min 500 = $5.00, max 100000 = $1,000.00)"),
    },
    async (args) => {
      try {
        if (!checkStripePayLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 5 Stripe checkout sessions per hour. Please wait before creating another." }],
          };
        }
        const data = await httpClient.post<{
          sessionId: string;
          url: string;
        }>(
          "/api/wallet/topup/stripe",
          { amountCents: args.amount_cents },
        );

        const text = [
          `Stripe Checkout Session Created`,
          ``,
          `Session ID: ${data.sessionId}`,
          `Amount: $${(args.amount_cents / 100).toFixed(2)}`,
          ``,
          `Complete payment here: ${data.url}`,
          ``,
          `Accepts credit/debit cards, Apple Pay, Google Pay, and Link.`,
          `After payment, your wallet will be credited automatically.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Stripe payment error: ${(err instanceof Error ? err.message : String(err)).replace(/dn_(?:live|test)_[A-Za-z0-9_-]+/g, "[REDACTED]")}` }],
        };
      }
    },
  );
}
