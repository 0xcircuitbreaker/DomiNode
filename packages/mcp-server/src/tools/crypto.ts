import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

const SUPPORTED_CRYPTO = ["BTC", "ETH", "XMR", "SOL", "ZEC", "USDC", "USDT"] as const;

export function registerCryptoTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_pay_crypto",
    "Create a cryptocurrency payment invoice to top up your Dominus Node wallet. Supports BTC, ETH, XMR (Monero), SOL, ZEC (Zcash), USDC, and USDT. Returns a payment address and amount. Privacy coins (XMR, ZEC) provide anonymous billing — no identity linked to payment.",
    {
      amount_usd: z.number().min(1).max(10000).describe("Amount in USD to add to wallet (min $1)"),
      currency: z.enum(SUPPORTED_CRYPTO).describe("Cryptocurrency to pay with (BTC, ETH, XMR, SOL, ZEC, USDC, USDT)"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{
          invoice_id: string;
          pay_address: string;
          pay_amount: number;
          pay_currency: string;
          price_amount: number;
          price_currency: string;
          status: string;
          expiration_estimate_date: string;
        }>(
          "/api/wallet/topup/crypto",
          { amount: args.amount_usd, currency: args.currency },
        );

        const text = [
          `Crypto Payment Invoice Created`,
          ``,
          `Invoice ID: ${data.invoice_id}`,
          `Amount: $${args.amount_usd} USD`,
          `Pay: ${data.pay_amount} ${data.pay_currency}`,
          ``,
          `Send exactly ${data.pay_amount} ${data.pay_currency} to:`,
          `  ${data.pay_address}`,
          ``,
          `Status: ${data.status}`,
          `Expires: ${data.expiration_estimate_date}`,
          ``,
          `Use dominusnode_check_payment to check payment status.`,
          args.currency === "XMR" || args.currency === "ZEC"
            ? `\nPrivacy note: ${args.currency} provides untraceable payment — no identity linked.`
            : "",
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Payment error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_check_payment",
    "Check the status of a cryptocurrency payment invoice. Returns whether payment has been received and confirmed.",
    {
      invoice_id: z.string().min(1).max(100).describe("Invoice ID from dominusnode_pay_crypto"),
    },
    async (args) => {
      try {
        const data = await httpClient.get<{
          invoice_id: string;
          status: string;
          pay_amount: number;
          pay_currency: string;
          actually_paid: number;
          outcome_amount: number;
          outcome_currency: string;
        }>(`/api/wallet/crypto/status/${encodeURIComponent(args.invoice_id)}`);

        const statusEmoji: Record<string, string> = {
          waiting: "Waiting for payment...",
          confirming: "Payment detected, confirming...",
          confirmed: "Payment confirmed!",
          finished: "Payment complete! Wallet credited.",
          failed: "Payment failed.",
          expired: "Invoice expired.",
        };

        const text = [
          `Payment Status: ${statusEmoji[data.status] ?? data.status}`,
          `Invoice: ${data.invoice_id}`,
          `Expected: ${data.pay_amount} ${data.pay_currency}`,
          `Received: ${data.actually_paid} ${data.pay_currency}`,
          data.status === "finished"
            ? `Wallet credited: $${(data.outcome_amount / 100).toFixed(2)} USD`
            : "",
        ].filter(Boolean).join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
