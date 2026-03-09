import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as crypto from "node:crypto";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { AccountInfo } from "../types.js";

// ─── Proof-of-Work solver ──────────────────────────────────────────
// Solves SHA-256 hash puzzles for CAPTCHA-free registration.
// Difficulty 20 = ~1M hashes = ~2-5 seconds on modern CPU.
interface PowChallenge {
  challengeId: string;
  prefix: string;
  difficulty: number;
  algorithm: string;
  expiresAt: string;
}

function countLeadingZeroBits(buf: Buffer): number {
  let bits = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      bits += 8;
    } else {
      let byte = buf[i];
      for (let b = 7; b >= 0; b--) {
        if ((byte & (1 << b)) === 0) bits++;
        else return bits;
      }
      return bits;
    }
  }
  return bits;
}

function solvePoW(prefix: string, difficulty: number): string | null {
  // Cap difficulty to prevent wasting CPU on impossible challenges
  const cappedDifficulty = Math.min(difficulty, 32);
  let nonce = 0;
  while (nonce < 100_000_000) { // Hard cap to prevent infinite loop
    const hash = crypto.createHash("sha256")
      .update(prefix + nonce.toString())
      .digest();
    if (countLeadingZeroBits(hash) >= cappedDifficulty) {
      return nonce.toString();
    }
    nonce++;
  }
  return null; // Exhausted — caller falls back to other auth methods
}

/**
 * Get a PoW challenge from the server and solve it.
 * Returns the pow object to include in the registration request body.
 */
async function solveRegistrationPoW(httpClient: HttpClient): Promise<{ challengeId: string; nonce: string } | undefined> {
  const challenge = await httpClient.post<PowChallenge>(
    "/api/auth/pow/challenge",
    {},
    false, // bootstrap mode, no auth required
  );
  const nonce = solvePoW(challenge.prefix, challenge.difficulty);
  if (!nonce) return undefined;
  return { challengeId: challenge.challengeId, nonce };
}

// Stricter rate limit for account creation in bootstrap mode.
// The backend has per-IP limits (3 accounts/hour) but the MCP server should
// also limit to prevent a compromised MCP client from spamming registration.
const BOOTSTRAP_SIGNUP_MAX = 5;
const BOOTSTRAP_SIGNUP_WINDOW_MS = 3600_000; // 1 hour
const signupTimestamps: number[] = [];

/** @internal Exported for testing only — clears rate limit state */
export function _resetBootstrapSignupLimits(): void {
  signupTimestamps.length = 0;
  loginTimestamps.length = 0;
}

// Rate limit login attempts to prevent brute-force via MCP client
const LOGIN_MAX = 10;
const LOGIN_WINDOW_MS = 900_000; // 15 minutes
const loginTimestamps: number[] = [];

function checkLoginLimit(): boolean {
  const now = Date.now();
  while (loginTimestamps.length > 0 && now - loginTimestamps[0] > LOGIN_WINDOW_MS) {
    loginTimestamps.shift();
  }
  if (loginTimestamps.length > 100) loginTimestamps.length = 100;
  if (loginTimestamps.length >= LOGIN_MAX) return false;
  loginTimestamps.push(now);
  return true;
}

function checkBootstrapSignupLimit(): boolean {
  const now = Date.now();
  // Remove expired entries
  while (signupTimestamps.length > 0 && now - signupTimestamps[0] > BOOTSTRAP_SIGNUP_WINDOW_MS) {
    signupTimestamps.shift();
  }
  // Hard cap prevents unbounded growth under pathological clock skew
  if (signupTimestamps.length > 100) signupTimestamps.length = 100;
  if (signupTimestamps.length >= BOOTSTRAP_SIGNUP_MAX) return false;
  signupTimestamps.push(now);
  return true;
}

export function registerAccountTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_account_info",
    "Get account details including email, admin status, and email verification.",
    {},
    async () => {
      try {
        const info = await httpClient.get<AccountInfo>("/api/auth/me");
        const user = info.user;
        const text = [
          `User ID: ${user.id}`,
          `Email: ${user.email}`,
          `Email Verified: ${user.email_verified ? "yes" : "no"}`,
          `Admin: ${user.is_admin ? "yes" : "no"}`,
          user.wallet_address ? `Wallet: ${user.wallet_address}` : null,
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

  server.tool(
    "dominusnode_register",
    "Register a new Dominus Node account. Returns access token for immediate use. Use this when the AI agent needs to create its own proxy account. The free tier includes 10 connections and 1GB bandwidth — no payment required.",
    {
      email: z.string().email().describe("Email address for the new account"),
      password: z.string().min(8).max(128).describe("Password (min 8 characters)"),
    },
    async (args) => {
      try {
        if (!checkBootstrapSignupLimit()) {
          return { isError: true, content: [{ type: "text", text: "Account creation rate limit exceeded (max 5 per hour). Please try again later." }] };
        }
        // Solve PoW for CAPTCHA-free registration (works with or without MCP_AGENT_SECRET)
        let pow: { challengeId: string; nonce: string } | undefined;
        try {
          pow = await solveRegistrationPoW(httpClient);
        } catch {
          // PoW challenge fetch failed — proceed without it (will use MCP_AGENT_SECRET if available)
        }

        const data = await httpClient.post<{ token: string; refreshToken: string; user: { id: string; email: string } }>(
          "/api/auth/register",
          { email: args.email, password: args.password, ...(pow ? { pow } : {}) },
          false,
        );
        // Store tokens so subsequent authenticated calls work (bootstrap mode)
        if (data.token && data.refreshToken) {
          httpClient.storeTokens(data.token, data.refreshToken);
        }

        // Email is auto-verified server-side for MCP/PoW-verified agents.
        // Payments (crypto) are immediately available. Stripe requires browser checkout.
        const text = [
          `Account created successfully!`,
          `Email: ${data.user.email}`,
          `User ID: ${data.user.id}`,
          `Email: auto-verified (AI agent)`,
          ``,
          `You are now authenticated. Crypto payments enabled (11 currencies).`,
          `Next steps:`,
          `1. Use dominusnode_setup to create an account + API key in one step (recommended)`,
          `   Or set DOMINUSNODE_API_KEY and restart to unlock dominusnode_create_key`,
          `2. Free tier: 10 connections, 1GB bandwidth — no payment needed`,
          `3. Use dominusnode_pay_crypto to add funds for premium bandwidth`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Handle 403 "slots full" — suggest waitlist
        if (msg.includes("403") || msg.toLowerCase().includes("slot") || msg.toLowerCase().includes("capacity")) {
          return {
            isError: true,
            content: [{ type: "text", text: `All alpha registration slots are full.\n\nUse dominusnode_check_slots to see availability, or dominusnode_join_waitlist to get notified when a slot opens.` }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: `Registration error: ${msg}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_login",
    "Login to an existing Dominus Node account with email and password.",
    {
      email: z.string().email().describe("Account email"),
      password: z.string().min(1).max(128).describe("Account password"),
    },
    async (args) => {
      // Rate limit login attempts to prevent brute-force via MCP client
      if (!checkLoginLimit()) {
        return {
          isError: true,
          content: [{ type: "text", text: "Login rate limit exceeded. Try again in 15 minutes." }],
        };
      }
      try {
        const data = await httpClient.post<{ token: string; refreshToken: string; user: { id: string; email: string } }>(
          "/api/auth/login",
          { email: args.email, password: args.password },
          false,
        );
        // Store tokens so subsequent authenticated calls work (bootstrap mode)
        if (data.token && data.refreshToken) {
          httpClient.storeTokens(data.token, data.refreshToken);
        }
        const text = [
          `Logged in successfully!`,
          `Email: ${data.user.email}`,
          `User ID: ${data.user.id}`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Login error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_setup",
    "One-shot setup: register a new account, create an API key, and return proxy config. Perfect for AI agents that need to bootstrap proxy access from scratch.",
    {
      email: z.string().email().describe("Email address for the new account"),
      password: z.string().min(8).max(128).describe("Password (min 8 characters)"),
      key_label: z.string().min(1).max(100).default("ai-agent").describe("Label for the API key"),
    },
    async (args) => {
      try {
        if (!checkBootstrapSignupLimit()) {
          return { isError: true, content: [{ type: "text", text: "Account creation rate limit exceeded (max 5 per hour). Please try again later." }] };
        }
        // Step 1: Solve PoW for CAPTCHA-free registration
        let pow: { challengeId: string; nonce: string } | undefined;
        try {
          pow = await solveRegistrationPoW(httpClient);
        } catch {
          // PoW challenge failed — proceed without it (will use MCP_AGENT_SECRET if available)
        }

        // Step 2: Register
        // Email is auto-verified server-side for MCP/PoW-verified agents
        const reg = await httpClient.post<{ token: string; refreshToken: string; user: { id: string; email: string } }>(
          "/api/auth/register",
          { email: args.email, password: args.password, ...(pow ? { pow } : {}) },
          false,
        );

        // Store tokens from registration so subsequent authenticated calls work (bootstrap mode)
        if (reg.token && reg.refreshToken) {
          httpClient.storeTokens(reg.token, reg.refreshToken);
        }

        // Step 2: Create API key (using the newly acquired auth)
        let keyData: { id: string; key: string; label: string };
        try {
          keyData = await httpClient.post<{ id: string; key: string; label: string }>(
            "/api/keys",
            { label: args.key_label },
          );
        } catch (keyErr) {
          // Account was created but key creation failed — tell the agent clearly
          const text = [
            `Account created but API key creation failed.`,
            ``,
            `Account:`,
            `  Email: ${reg.user.email}`,
            `  User ID: ${reg.user.id}`,
            ``,
            `You are authenticated. To create an API key:`,
            `  1. Set DOMINUSNODE_API_KEY env var and restart to unlock dominusnode_create_key`,
            `  2. Or use dominusnode_login to re-authenticate and retry`,
            ``,
            `Error: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`,
          ].join("\n");
          return { isError: true, content: [{ type: "text", text }] };
        }

        const text = [
          `Dominus Node account setup complete!`,
          ``,
          `Account:`,
          `  Email: ${reg.user.email}`,
          `  User ID: ${reg.user.id}`,
          `  Email: auto-verified (MCP agent)`,
          ``,
          `API Key (save now — shown only once):`,
          `  Key: ${keyData.key}`,
          `  Label: ${keyData.label}`,
          ``,
          `Proxy Usage:`,
          `  curl -x http://auto:<YOUR_API_KEY>@proxy.dominusnode.com:8080 https://httpbin.org/ip`,
          ``,
          `Free tier: 10 connections, 1GB bandwidth.`,
          `Payments: use dominusnode_pay_crypto to add funds (10 crypto currencies).`,
          `Set DOMINUSNODE_API_KEY=<your key above> and restart to unlock all 56 tools.`,
        ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Handle 403 "slots full" — suggest waitlist
        if (msg.includes("403") || msg.toLowerCase().includes("slot") || msg.toLowerCase().includes("capacity")) {
          return {
            isError: true,
            content: [{ type: "text", text: `All alpha registration slots are full.\n\nUse dominusnode_check_slots to see availability, or dominusnode_join_waitlist to get notified when a slot opens.` }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: `Setup error: ${msg}` }],
        };
      }
    },
  );

  // ─── Password change ──────────────────────────────────────────────
  const PASSWORD_CHANGE_MAX = 5;
  const PASSWORD_CHANGE_WINDOW_MS = 3600_000; // 1 hour
  const passwordChangeTimestamps: number[] = [];
  function checkPasswordChangeLimit(): boolean {
    const now = Date.now();
    while (passwordChangeTimestamps.length > 0 && now - passwordChangeTimestamps[0] > PASSWORD_CHANGE_WINDOW_MS) {
      passwordChangeTimestamps.shift();
    }
    if (passwordChangeTimestamps.length > 100) passwordChangeTimestamps.length = 100;
    if (passwordChangeTimestamps.length >= PASSWORD_CHANGE_MAX) return false;
    passwordChangeTimestamps.push(now);
    return true;
  }

  server.tool(
    "dominusnode_update_password",
    "Change the account password. Requires the current password for verification. Wallet-only accounts cannot use this. All existing API keys and refresh tokens are revoked on success.",
    {
      current_password: z.string().min(1).max(128).describe("Current account password"),
      new_password: z.string().min(8).max(128).describe("New password (min 8 characters)"),
    },
    async (args) => {
      if (!checkPasswordChangeLimit()) {
        return {
          isError: true,
          content: [{ type: "text", text: "Password change rate limit exceeded (max 5 per hour). Please try again later." }],
        };
      }
      try {
        await httpClient.post("/api/auth/change-password", {
          currentPassword: args.current_password,
          newPassword: args.new_password,
        });

        const text = [
          `Password changed successfully.`,
          ``,
          `All existing API keys and refresh tokens have been revoked for security.`,
          `You will need to create new API keys and re-authenticate.`,
        ].join("\n");

        return { content: [{ type: "text", text }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error changing password: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  // Rate limit verify_email to prevent brute-force enumeration
  const VERIFY_EMAIL_MAX = 10;
  const VERIFY_EMAIL_WINDOW_MS = 900_000; // 15 minutes
  const verifyEmailTimestamps: number[] = [];
  function checkVerifyEmailLimit(): boolean {
    const now = Date.now();
    while (verifyEmailTimestamps.length > 0 && now - verifyEmailTimestamps[0] > VERIFY_EMAIL_WINDOW_MS) {
      verifyEmailTimestamps.shift();
    }
    if (verifyEmailTimestamps.length > 100) verifyEmailTimestamps.length = 100;
    if (verifyEmailTimestamps.length >= VERIFY_EMAIL_MAX) return false;
    verifyEmailTimestamps.push(now);
    return true;
  }

  // Rate limit resend_verification
  const RESEND_MAX = 3;
  const RESEND_WINDOW_MS = 900_000; // 15 minutes
  const resendTimestamps: number[] = [];
  function checkResendLimit(): boolean {
    const now = Date.now();
    while (resendTimestamps.length > 0 && now - resendTimestamps[0] > RESEND_WINDOW_MS) {
      resendTimestamps.shift();
    }
    if (resendTimestamps.length > 100) resendTimestamps.length = 100;
    if (resendTimestamps.length >= RESEND_MAX) return false;
    resendTimestamps.push(now);
    return true;
  }

  server.tool(
    "dominusnode_verify_email",
    "Verify your email address using a verification token. The token is returned when registering via API/MCP. Email verification is required before you can make payments (Stripe or crypto). Wallet-authenticated accounts are auto-verified and do not need this.",
    {
      token: z.string().min(32).max(128).describe("Email verification token from registration response"),
    },
    async (args) => {
      if (!checkVerifyEmailLimit()) {
        return { isError: true, content: [{ type: "text", text: "Email verification rate limit exceeded. Try again in 15 minutes." }] };
      }
      try {
        await httpClient.post("/api/auth/verify-email", { token: args.token }, false);
        return {
          content: [{ type: "text", text: "Email verified successfully! You can now use dominusnode_pay_crypto to add funds to your wallet." }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Verification failed: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_resend_verification",
    "Resend the email verification link. Use this if you registered with email/password but the verification email didn't arrive. Requires authentication (login first).",
    {},
    async () => {
      if (!checkResendLimit()) {
        return { isError: true, content: [{ type: "text", text: "Resend verification rate limit exceeded. Try again in 15 minutes." }] };
      }
      try {
        const data = await httpClient.post<{ message: string }>("/api/auth/resend-verification", {});
        return {
          content: [{ type: "text", text: data.message }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    },
  );

  server.tool(
    "dominusnode_create_agent_secret",
    "Generate a per-agent secret (das_xxx) for autonomous operation. The secret replaces MCP_AGENT_SECRET for this agent's subsequent requests — enables CAPTCHA bypass, email auto-verify, and elevated rate limits. Requires authentication. Save the returned secret — it is shown only once.",
    {
      label: z.string().max(100).default("mcp-agent").describe("Human-readable label for the agent secret"),
    },
    async (args) => {
      try {
        const data = await httpClient.post<{
          id: string;
          agentSecret: string;
          label: string;
          createdAt: string;
        }>("/api/agent/secret", { label: args.label });

        const text = [
          `Agent secret created!`,
          ``,
          `Secret (save now — shown only once):`,
          `  ${data.agentSecret}`,
          ``,
          `ID: ${data.id}`,
          `Label: ${data.label}`,
          ``,
          `Usage:`,
          `  Set DOMINUSNODE_AGENT_SECRET=${data.agentSecret} in your environment`,
          `  Or pass as X-DominusNode-Agent-Secret header with X-DominusNode-Agent: mcp`,
          ``,
          `This secret is unique to your agent. It enables:`,
          `  - CAPTCHA bypass on all endpoints`,
          `  - Email auto-verification on registration`,
          `  - Elevated rate limits`,
          `  - Max 5 active secrets per account (oldest auto-revoked)`,
        ].join("\n");
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
