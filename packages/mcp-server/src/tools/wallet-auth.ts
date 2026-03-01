import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";

// Bootstrap rate limiting for wallet auth (prevents mass wallet account creation)
const BOOTSTRAP_WALLET_MAX = 5;
const BOOTSTRAP_WALLET_WINDOW_MS = 3600_000; // 1 hour
const walletAuthTimestamps: number[] = [];

/** @internal Exported for testing only — clears rate limit state */
export function _resetWalletAuthLimits(): void {
  walletAuthTimestamps.length = 0;
}

function checkWalletAuthLimit(): boolean {
  const now = Date.now();
  while (walletAuthTimestamps.length > 0 && now - walletAuthTimestamps[0] > BOOTSTRAP_WALLET_WINDOW_MS) {
    walletAuthTimestamps.shift();
  }
  // Hard cap prevents unbounded growth under pathological clock skew
  if (walletAuthTimestamps.length > 100) walletAuthTimestamps.length = 100;
  if (walletAuthTimestamps.length >= BOOTSTRAP_WALLET_MAX) return false;
  walletAuthTimestamps.push(now);
  return true;
}

export function registerWalletAuthTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_wallet_challenge",
    "Request a signature challenge for wallet-based authentication. Send your Ethereum address to get a message to sign with your wallet. Works with MetaMask, Coinbase Agentic Wallets, ethers.Wallet, viem, etc.",
    {
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your Ethereum wallet address (0x...)"),
    },
    async (args) => {
      try {
        if (!checkWalletAuthLimit()) {
          return { isError: true, content: [{ type: "text", text: "Wallet authentication rate limit exceeded (max 5 per hour). Please try again later." }] };
        }
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
        // Rate limit register_wallet (parity with challenge and setup)
        if (!checkWalletAuthLimit()) {
          return { isError: true, content: [{ type: "text" as const, text: "Wallet authentication rate limit exceeded. Try again later." }] };
        }

        const data = await httpClient.post<{
          token: string;
          refreshToken: string;
          user: { id: string; email: string; wallet_address: string; isNewUser: boolean };
        }>(
          "/api/auth/wallet/verify",
          { address: args.address, signature: args.signature },
          false,
        );

        // Store tokens so subsequent authenticated calls work (bootstrap mode)
        if (data.token && data.refreshToken) {
          httpClient.storeTokens(data.token, data.refreshToken);
        }

        const action = data.user.isNewUser ? "Account created" : "Logged in";
        const text = [
          `Wallet Authentication Successful!`,
          ``,
          `${action}:`,
          `  User ID: ${data.user.id}`,
          `  Wallet: ${data.user.wallet_address}`,
          ``,
          `You are now authenticated. Next steps:`,
          `1. Use dominusnode_wallet_setup to create an account + API key in one step`,
          `   Or set DOMINUSNODE_API_KEY and restart to unlock dominusnode_create_key`,
          `2. Free tier: 10 connections, 1GB bandwidth — no payment needed`,
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
    "Submit a pre-signed wallet challenge and create an API key in one call. First call dominusnode_wallet_challenge to get the message to sign, then call this tool with the signature. Returns proxy configuration ready to use.",
    {
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your Ethereum wallet address (0x...)"),
      signature: z.string().min(130).max(200).describe("The EIP-191 signature of the challenge message (get challenge first via dominusnode_wallet_challenge)"),
      key_label: z.string().min(1).max(100).default("ai-agent-wallet").describe("Label for the API key"),
    },
    async (args) => {
      try {
        if (!checkWalletAuthLimit()) {
          return { isError: true, content: [{ type: "text", text: "Wallet setup rate limit exceeded (max 5 per hour). Please try again later." }] };
        }
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

        // Store tokens so the subsequent API key creation call works
        if (verifyData.token && verifyData.refreshToken) {
          httpClient.storeTokens(verifyData.token, verifyData.refreshToken);
        }

        // Step 2: Create API key (using newly acquired auth)
        const action = verifyData.user.isNewUser ? "created" : "logged into";
        let keyData: { id: string; key: string; label: string };
        try {
          keyData = await httpClient.post<{ id: string; key: string; label: string }>(
            "/api/keys",
            { label: args.key_label },
          );
        } catch (keyErr) {
          // Account was authenticated but key creation failed — tell the agent clearly
          const text = [
            `Wallet authenticated but API key creation failed.`,
            ``,
            `Account ${action}:`,
            `  User ID: ${verifyData.user.id}`,
            `  Wallet: ${verifyData.user.wallet_address}`,
            ``,
            `You are authenticated. To create an API key:`,
            `  1. Set DOMINUSNODE_API_KEY env var and restart to unlock dominusnode_create_key`,
            `  2. Or use dominusnode_wallet_challenge + dominusnode_register_wallet to re-authenticate`,
            ``,
            `Error: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`,
          ].join("\n");
          return { isError: true, content: [{ type: "text", text }] };
        }

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
          `  curl -x http://auto:<YOUR_API_KEY>@proxy.dominusnode.com:8080 https://httpbin.org/ip`,
          ``,
          `Free tier: 10 connections, 1GB bandwidth.`,
          `Set DOMINUSNODE_API_KEY=<your key above> and restart to unlock all 56 tools.`,
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
