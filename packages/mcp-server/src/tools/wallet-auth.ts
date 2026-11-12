import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Wallet } from "ethers";
import type { HttpClient } from "../http-client.js";
import { scrubCredentials } from "../http-client.js";
import type { McpConfig } from "../config.js";
import { readWalletKey } from "./nodes.js";

// Bootstrap rate limiting. Challenges are cheap and capped at 20/hour; only FAILED
// signature verifications count toward the verify cap, so a successful sign-in
// never locks the agent out.
const CHALLENGE_MAX = 20;
const VERIFY_FAILURE_MAX = 5;
const WINDOW_MS = 3600_000; // 1 hour
const challengeTimestamps: number[] = [];
const verifyFailureTimestamps: number[] = [];

/** @internal Exported for testing only — clears rate limit state */
export function _resetWalletAuthLimits(): void {
  challengeTimestamps.length = 0;
  verifyFailureTimestamps.length = 0;
}

function prune(ts: number[]): void {
  const now = Date.now();
  while (ts.length > 0 && now - ts[0] > WINDOW_MS) ts.shift();
  // Hard cap prevents unbounded growth under pathological clock skew
  if (ts.length > 100) ts.length = 100;
}

function takeChallengeSlot(): boolean {
  prune(challengeTimestamps);
  if (challengeTimestamps.length >= CHALLENGE_MAX) return false;
  challengeTimestamps.push(Date.now());
  return true;
}

function verifyAllowed(): boolean {
  prune(verifyFailureTimestamps);
  return verifyFailureTimestamps.length < VERIFY_FAILURE_MAX;
}

function recordVerifyFailure(): void {
  verifyFailureTimestamps.push(Date.now());
}

const VERIFY_LIMIT_TEXT =
  `Too many failed wallet signature verifications (max ${VERIFY_FAILURE_MAX} per hour). Try again later.`;

export interface WalletAuthOptions {
  /** Used for DOMINUSNODE_WALLET_KEY_FILE signing in wallet_setup. */
  config?: McpConfig;
  /**
   * Called after wallet_setup has a session token and an API key. In bootstrap mode this
   * registers the authenticated tools in-process and sends notifications/tools/list_changed.
   * Returns true when the tools were unlocked.
   */
  onAuthenticated?: (apiKey: string) => boolean | Promise<boolean>;
}

type VerifyResponse = {
  token: string;
  refreshToken: string;
  user: { id: string; email: string; wallet_address: string; isNewUser: boolean };
};

/**
 * The sign-in message the dashboard builds (shared buildSignMessage). The key-file signer
 * only signs text of exactly this shape, so a server can never get the owner key to sign a
 * withdrawal or payout-wallet message through this path.
 */
export function isSignInMessage(message: string, address: string, nonce: string): boolean {
  const lines = message.split("\n");
  if (lines.length !== 8) return false;
  const m = /^([a-z0-9.-]+(?::\d+)?) wants you to sign in with your Ethereum account:$/i.exec(lines[0]);
  if (!m) return false;
  const domain = m[1];
  return (
    lines[1].toLowerCase() === address.toLowerCase() &&
    lines[2] === "" &&
    lines[3] === "Sign in to Dominus Node proxy service" &&
    lines[4] === "" &&
    lines[5] === `URI: https://${domain}` &&
    lines[6] === `Nonce: ${nonce}` &&
    /^Issued At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(lines[7])
  );
}

function errText(err: unknown): string {
  return scrubCredentials(err instanceof Error ? err.message : String(err));
}

export function registerWalletAuthTools(server: McpServer, httpClient: HttpClient, options: WalletAuthOptions = {}): void {
  const config = options.config;

  server.tool(
    "dominusnode_wallet_challenge",
    "Request a signature challenge for wallet-based authentication. Send your Ethereum address to get a message to sign with your wallet " +
      "(EIP-191 personal_sign: MetaMask, Coinbase Agentic Wallets, ethers.Wallet, viem, ...). Then call dominusnode_wallet_setup with the signature.",
    {
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your Ethereum wallet address (0x...)"),
    },
    async (args) => {
      try {
        if (!takeChallengeSlot()) {
          return { isError: true, content: [{ type: "text", text: `Wallet challenge rate limit exceeded (max ${CHALLENGE_MAX} per hour). Try again later.` }] };
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
          `After signing, call dominusnode_wallet_setup with:`,
          `  - address: ${args.address}`,
          `  - signature: <your signature>`,
          `It signs you in, creates an API key and unlocks the full tool set in this session.`,
          `(dominusnode_register_wallet only signs in, without creating a key.)`,
          ``,
          `Challenge expires in 5 minutes.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Challenge error: ${errText(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_register_wallet",
    "Submit a signed challenge to authenticate with your wallet. Creates a new account if this wallet hasn't been seen before, or logs in to the existing account. " +
      "Prefer dominusnode_wallet_setup, which also creates an API key and unlocks the full tool set.",
    {
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Your Ethereum wallet address (0x...)"),
      signature: z.string().min(130).max(200).describe("The EIP-191 signature of the challenge message"),
    },
    async (args) => {
      try {
        if (!verifyAllowed()) {
          return { isError: true, content: [{ type: "text" as const, text: VERIFY_LIMIT_TEXT }] };
        }

        let data: VerifyResponse;
        try {
          data = await httpClient.post<VerifyResponse>(
            "/api/auth/wallet/verify",
            { address: args.address, signature: args.signature },
            false,
          );
        } catch (err) {
          recordVerifyFailure();
          throw err;
        }

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
          `You are now signed in. Next steps:`,
          `1. Get an API key: request a new challenge and call dominusnode_wallet_setup`,
          `   (creates a key with this sign-in and unlocks the full tool set in this session)`,
          `2. Top up with dominusnode_pay_crypto, or earn credit by contributing a node (dominusnode_node_setup_guide)`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Verification error: ${errText(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_wallet_setup",
    "Sign in with a wallet and create an API key in one call; the full tool set is then unlocked in this session " +
      "(no restart needed). Either pass address + signature of a challenge from dominusnode_wallet_challenge, or omit the " +
      "signature when DOMINUSNODE_WALLET_KEY_FILE is configured: the server then requests the challenge and signs it with that " +
      "key (it only signs the standard sign-in message).",
    {
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe("Your Ethereum wallet address (0x...). Optional with DOMINUSNODE_WALLET_KEY_FILE."),
      signature: z.string().min(130).max(200).optional().describe("The EIP-191 signature of the challenge message. Omit to sign with DOMINUSNODE_WALLET_KEY_FILE."),
      key_label: z.string().min(1).max(100).default("ai-agent-wallet").describe("Label for the API key"),
    },
    async (args) => {
      try {
        if (!verifyAllowed()) {
          return { isError: true, content: [{ type: "text", text: VERIFY_LIMIT_TEXT }] };
        }

        let address = args.address;
        let signature = args.signature;
        if (!signature) {
          if (!config?.walletKeyFile) {
            return {
              isError: true,
              content: [{ type: "text", text: "signature is required: call dominusnode_wallet_challenge and sign the message, or configure DOMINUSNODE_WALLET_KEY_FILE so this server can sign it." }],
            };
          }
          const wallet = new Wallet(readWalletKey(config.walletKeyFile));
          if (address && address.toLowerCase() !== wallet.address.toLowerCase()) {
            return { isError: true, content: [{ type: "text", text: `address ${address} does not match the DOMINUSNODE_WALLET_KEY_FILE wallet ${wallet.address}` }] };
          }
          address = wallet.address;
          if (!takeChallengeSlot()) {
            return { isError: true, content: [{ type: "text", text: `Wallet challenge rate limit exceeded (max ${CHALLENGE_MAX} per hour). Try again later.` }] };
          }
          const ch = await httpClient.post<{ message: string; nonce: string }>("/api/auth/wallet/challenge", { address }, false);
          if (typeof ch.message !== "string" || typeof ch.nonce !== "string" || !isSignInMessage(ch.message, address, ch.nonce)) {
            return { isError: true, content: [{ type: "text", text: "Refusing to sign: the server's challenge is not the standard Dominus Node sign-in message." }] };
          }
          signature = await wallet.signMessage(ch.message);
        } else if (!address) {
          return { isError: true, content: [{ type: "text", text: "address is required with signature" }] };
        }

        // Step 1: Verify wallet signature (creates or logs into account)
        let verifyData: VerifyResponse;
        try {
          verifyData = await httpClient.post<VerifyResponse>(
            "/api/auth/wallet/verify",
            { address, signature },
            false,
          );
        } catch (err) {
          recordVerifyFailure();
          throw err;
        }

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
            `You are signed in for this session. Retry dominusnode_wallet_setup (new challenge) to create a key.`,
            ``,
            `Error: ${errText(keyErr)}`,
          ].join("\n");
          return { isError: true, content: [{ type: "text", text }] };
        }

        let unlocked = false;
        if (options.onAuthenticated) {
          try {
            unlocked = await options.onAuthenticated(keyData.key);
          } catch {
            unlocked = false;
          }
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
          `  curl -x https://country-US:<YOUR_API_KEY>@proxy.dominusnode.com:8443 https://httpbin.org/ip`,
          `  (plaintext http://...:8080 sends the key in clear; use only if TLS is unavailable)`,
          ``,
          `Traffic is relayed through agent-contributed nodes; see dominusnode_network_pricing.`,
          unlocked
            ? `All authenticated tools (fetch, keys, usage, wallet, nodes, earnings) are now available in this session.`
            : `Set DOMINUSNODE_API_KEY=<your key above> for future sessions.`,
          unlocked ? `For future sessions, set DOMINUSNODE_API_KEY=<your key above>.` : ``,
        ].join("\n").trimEnd();

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Wallet setup error: ${errText(err)}` }],
        };
      }
    },
  );
}
