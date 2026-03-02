import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

const PAYPAL_PAY_MAX = 5;
const PAYPAL_PAY_WINDOW_MS = 3_600_000;
const paypalPayTimestamps: number[] = [];

function checkPaypalPayLimit(): boolean {
  const now = Date.now();
  while (paypalPayTimestamps.length > 0 && now - paypalPayTimestamps[0] > PAYPAL_PAY_WINDOW_MS) {
    paypalPayTimestamps.shift();
  }
  if (paypalPayTimestamps.length > 100) paypalPayTimestamps.length = 100;
  if (paypalPayTimestamps.length >= PAYPAL_PAY_MAX) return false;
  paypalPayTimestamps.push(now);
  return true;
}

export function registerPaypalTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_pay_paypal",
    "Create a PayPal payment order to top up your Dominus Node wallet. Returns an approval URL where you complete the payment. After approval, the wallet is credited automatically via webhook, or you can use the capture endpoint. Lower fees than Stripe for PayPal users.",
    {
      amount_cents: z.number().int().min(500).max(100000).describe("Amount in cents to add to wallet (min 500 = $5.00, max 100000 = $1,000.00)"),
    },
    async (args) => {
      try {
        if (!checkPaypalPayLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 5 PayPal orders per hour. Please wait before creating another." }],
          };
        }
        const data = await httpClient.post<{
          orderId: string;
          approvalUrl: string;
          amountCents: number;
        }>(
          "/api/wallet/topup/paypal",
          { amountCents: args.amount_cents },
        );

        const text = [
          `PayPal Payment Order Created`,
          ``,
          `Order ID: ${data.orderId}`,
          `Amount: $${(data.amountCents / 100).toFixed(2)}`,
          ``,
          `Approve payment here: ${data.approvalUrl}`,
          ``,
          `After approving, your wallet will be credited automatically.`,
          `You can also check the status using dominusnode_check_payment with the order ID.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `PayPal payment error: ${(err instanceof Error ? err.message : String(err)).replace(/dn_(?:live|test)_[A-Za-z0-9_-]+/g, "[REDACTED]")}` }],
        };
      }
    },
  );
}
