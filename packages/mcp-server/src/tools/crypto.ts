import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

const SUPPORTED_CRYPTO = ["BTC", "ETH", "LTC", "XMR", "ZEC", "USDC", "SOL", "USDT", "DAI", "BNB"] as const;

const CRYPTO_PAY_MAX = 5;
const CRYPTO_PAY_WINDOW_MS = 3_600_000;
const cryptoPayTimestamps: number[] = [];

function checkCryptoPayLimit(): boolean {
  const now = Date.now();
  while (cryptoPayTimestamps.length > 0 && now - cryptoPayTimestamps[0] > CRYPTO_PAY_WINDOW_MS) {
    cryptoPayTimestamps.shift();
  }
  if (cryptoPayTimestamps.length > 100) cryptoPayTimestamps.length = 100;
  if (cryptoPayTimestamps.length >= CRYPTO_PAY_MAX) return false;
  cryptoPayTimestamps.push(now);
  return true;
}

export function registerCryptoTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_pay_crypto",
    "Create a cryptocurrency payment invoice to top up your Dominus Node wallet. Supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, and BNB. Returns a payment address and amount. Privacy coins (XMR, ZEC) provide anonymous billing — no identity linked to payment.",
    {
      amount_usd: z.number().min(1).max(10000).describe("Amount in USD to add to wallet (min $1)"),
      currency: z.enum(SUPPORTED_CRYPTO).describe("Cryptocurrency to pay with (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB)"),
    },
    async (args) => {
      try {
        if (!checkCryptoPayLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 5 crypto payment invoices per hour. Please wait before creating another." }],
          };
        }
        const data = await httpClient.post<{
          invoiceId: string;
          invoiceUrl: string;
          payCurrency: string;
          priceAmount: number;
        }>(
          "/api/wallet/topup/crypto",
          { amountUsd: args.amount_usd, currency: args.currency },
        );

        const text = [
          `Crypto Payment Invoice Created`,
          ``,
          `Invoice ID: ${data.invoiceId}`,
          `Amount: $${args.amount_usd} USD`,
          `Currency: ${data.payCurrency}`,
          `Price Amount: ${data.priceAmount}`,
          ``,
          `Pay here: ${data.invoiceUrl}`,
          ``,
          `The invoice page has full payment details (address, exact amount, expiration).`,
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

  // TODO: dominusnode_check_payment is disabled — the backend endpoint
  // GET /api/wallet/crypto/status/:invoiceId does not exist yet.
  // Re-enable this tool once the backend implements payment status polling.
  //
  // server.tool(
  //   "dominusnode_check_payment",
  //   "Check the status of a cryptocurrency payment invoice. Returns whether payment has been received and confirmed.",
  //   {
  //     invoice_id: z.string().min(1).max(100).describe("Invoice ID from dominusnode_pay_crypto"),
  //   },
  //   async (args) => {
  //     try {
  //       const data = await httpClient.get<{
  //         invoiceId: string;
  //         status: string;
  //         payAmount: number;
  //         payCurrency: string;
  //         actuallyPaid: number;
  //         outcomeAmount: number;
  //         outcomeCurrency: string;
  //       }>(`/api/wallet/crypto/status/${encodeURIComponent(args.invoice_id)}`);
  //
  //       const statusEmoji: Record<string, string> = {
  //         waiting: "Waiting for payment...",
  //         confirming: "Payment detected, confirming...",
  //         confirmed: "Payment confirmed!",
  //         finished: "Payment complete! Wallet credited.",
  //         failed: "Payment failed.",
  //         expired: "Invoice expired.",
  //       };
  //
  //       const text = [
  //         `Payment Status: ${statusEmoji[data.status] ?? data.status}`,
  //         `Invoice: ${data.invoiceId}`,
  //         `Expected: ${data.payAmount} ${data.payCurrency}`,
  //         `Received: ${data.actuallyPaid} ${data.payCurrency}`,
  //         data.status === "finished"
  //           ? `Wallet credited: $${(data.outcomeAmount / 100).toFixed(2)} USD`
  //           : "",
  //       ].filter(Boolean).join("\n");
  //
  //       return { content: [{ type: "text", text }] };
  //     } catch (err) {
  //       return {
  //         isError: true,
  //         content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  //       };
  //     }
  //   },
  // );
}
