import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

const SUPPORTED_CRYPTO = ["BTC", "ETH", "LTC", "XMR", "ZEC", "USDC", "SOL", "USDT", "DAI", "BNB", "LINK"] as const;

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

// Rate limit check_payment to prevent polling abuse
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
    "Create a cryptocurrency payment invoice to top up your Dominus Node wallet. Supports BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, and LINK. Returns a payment address and amount. Privacy coins (XMR, ZEC) provide anonymous billing — no identity linked to payment.",
    {
      amount_usd: z.number().min(5).max(1000).describe("Amount in USD to add to wallet (min $5, max $1000)"),
      currency: z.enum(SUPPORTED_CRYPTO).describe("Cryptocurrency to pay with (BTC, ETH, LTC, XMR, ZEC, USDC, SOL, USDT, DAI, BNB, LINK)"),
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
          { amountUsd: args.amount_usd, currency: args.currency.toLowerCase() },
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
          content: [{ type: "text", text: `Payment error: ${(err instanceof Error ? err.message : String(err)).replace(/dn_(?:live|test)_[A-Za-z0-9_-]+/g, "[REDACTED]")}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_check_payment",
    "Check the status of a cryptocurrency payment invoice. Returns current payment status (pending, confirming, confirmed, finished, failed, expired).",
    {
      invoice_id: z.string().regex(UUID_RE).describe("Invoice ID (UUID) from dominusnode_pay_crypto"),
    },
    async (args) => {
      try {
        if (!checkPaymentRateLimit()) {
          return {
            isError: true,
            content: [{ type: "text", text: "Rate limit exceeded: maximum 30 payment status checks per 5 minutes. Please wait before checking again." }],
          };
        }
        const data = await httpClient.get<{
          invoiceId: string;
          status: string;
          amountCents: number;
          provider: string;
          createdAt: string;
        }>(`/api/wallet/crypto/status/${encodeURIComponent(args.invoice_id)}`);

        const text = [
          `Payment Status`,
          ``,
          `Invoice ID: ${data.invoiceId}`,
          `Status: ${data.status}`,
          `Amount: $${(data.amountCents / 100).toFixed(2)}`,
          `Provider: ${data.provider}`,
          `Created: ${data.createdAt}`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Payment check error: ${(err instanceof Error ? err.message : String(err)).replace(/dn_(?:live|test)_[A-Za-z0-9_-]+/g, "[REDACTED]")}` }],
        };
      }
    },
  );
}
