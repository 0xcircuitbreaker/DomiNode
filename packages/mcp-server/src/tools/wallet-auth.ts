import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

export function registerWalletAuthTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_wallet_challenge",
    "Request a signature challenge for wallet-based authentication. Send your Ethereum address to get a message to sign with your wallet. Works with MetaMask, Coinbase Agentic Wallets, ethers.Wallet, viem, etc.",
    {
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your Ethereum wallet address (0x...)"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{ message: string; nonce: string }>(
          "/api/auth/wallet/challenge",
          { address: args.address },
          false,
        );

        const text = [
          `Wallet Challenge Issued`,
          ``,
          `Sign this message with your wallet:`,
          `---`,
          data.message,
          `---`,
          ``,
          `Nonce: ${data.nonce}`,
          ``,
          `After signing, use dominusnode_register_wallet with:`,
          `  - address: ${args.address}`,
          `  - signature: <your signature>`,
          ``,
          `Challenge expires in 5 minutes.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Challenge error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_register_wallet",
    "Submit a signed challenge to authenticate with your wallet. Creates a new account if this wallet hasn't been seen before, or logs in to the existing account. No email or password needed.",
    {
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your Ethereum wallet address (0x...)"),
      signature: z.string().min(130).max(200).describe("The EIP-191 signature of the challenge message"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{
          token: string;
          refreshToken: string;
          user: { id: string; email: string; wallet_address: string; isNewUser: boolean };
        }>(
          "/api/auth/wallet/verify",
          { address: args.address, signature: args.signature },
          false,
        );

        const action = data.user.isNewUser ? "Account created" : "Logged in";
        const text = [
          `Wallet Authentication Successful!`,
          ``,
          `${action}:`,
          `  User ID: ${data.user.id}`,
          `  Wallet: ${data.user.wallet_address}`,
          ``,
          `You are now authenticated. Next steps:`,
          `1. Use dominusnode_create_key to create an API key for proxy access`,
          `2. Use dominusnode_fetch to make requests through the proxy`,
          `3. Free tier: 10 connections, 1GB bandwidth — no payment needed`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Verification error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_wallet_setup",
    "One-shot wallet setup: request challenge, verify signature, and create an API key in one call. The agent must sign the challenge message between the challenge and verify steps. Returns proxy configuration ready to use.",
    {
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your Ethereum wallet address (0x...)"),
      signature: z.string().min(130).max(200).describe("The EIP-191 signature of the challenge message (get challenge first via dominusnode_wallet_challenge)"),
      key_label: z.string().min(1).max(100).default("ai-agent-wallet").describe("Label for the API key"),
    },
    async (args) => {
      try {
        // Step 1: Verify wallet signature (creates or logs into account)
        const verifyData = await httpClient.post<{
          token: string;
          refreshToken: string;
          user: { id: string; email: string; wallet_address: string; isNewUser: boolean };
        }>(
          "/api/auth/wallet/verify",
          { address: args.address, signature: args.signature },
          false,
        );

        // Step 2: Create API key (using newly acquired auth)
        const keyData = await httpClient.post<{ id: string; key: string; label: string }>(
          "/api/keys",
          { label: args.key_label },
        );

        const action = verifyData.user.isNewUser ? "created" : "logged into";
        const text = [
          `Dominus Node Wallet Setup Complete!`,
          ``,
          `Account ${action}:`,
          `  User ID: ${verifyData.user.id}`,
          `  Wallet: ${verifyData.user.wallet_address}`,
          ``,
          `API Key (save now — shown only once):`,
          `  Key: ${keyData.key}`,
          `  Label: ${keyData.label}`,
          ``,
          `Proxy Usage:`,
          `  curl -x http://USER:${keyData.key}@proxy.dominusnode.com:8080 https://httpbin.org/ip`,
          ``,
          `Free tier: 10 connections, 1GB bandwidth.`,
          `Use dominusnode_fetch to make proxy requests immediately.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Wallet setup error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );
}
