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

// R36 C-6: Rate limit check_payment to prevent polling abuse
const CHECK_PAYMENT_MAX = 30;
const CHECK_PAYMENT_WINDOW_MS = 300_000; // 5 minutes
const checkPaymentTimestamps: number[] = [];

function checkPaymentRateLimit(): boolean {
  const now = Date.now();
  while (checkPaymentTimestamps.length > 0 && now - checkPaymentTimestamps[0] > CHECK_PAYMENT_WINDOW_MS) {
    checkPaymentTimestamps.shift();
  }
  if (checkPaymentTimestamps.length > 100) checkPaymentTimestamps.length = 100;
  if (checkPaymentTimestamps.length >= CHECK_PAYMENT_MAX) return false;
  checkPaymentTimestamps.push(now);
  return true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerCryptoTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_pay_crypto",
    "Create a cryptocurrency payment invoice to top up your Dominus Node wallet. Supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, and BNB. Returns a payment address and amount. Privacy coins (XMR, ZEC) provide anonymous billing — no identity linked to payment.",
    {
      amount_usd: z.number().min(5).max(1000).describe("Amount in USD to add to wallet (min $5, max $1000)"),
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

  // check_payment tool disabled: no GET /api/wallet/crypto/status/:invoiceId endpoint exists yet.
  // TODO: Implement backend endpoint, then re-enable this tool.
  // See: https://github.com/DomiNode/DomiNode/issues/TBD
  //
  // server.tool(
  //   "dominusnode_check_payment",
  //   "Check the status of a cryptocurrency payment invoice...",
  //   { invoice_id: z.string().regex(UUID_RE).describe("Invoice ID (UUID) from dominusnode_pay_crypto") },
  //   async (args) => { ... }
  // );
}
