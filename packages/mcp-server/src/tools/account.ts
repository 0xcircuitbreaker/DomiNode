import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { HttpClient } from "../http-client.js";
import type { AccountInfo } from "../types.js";

// R18-H7: Stricter rate limit for account creation in bootstrap mode.
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

// R24 H-2: Rate limit login attempts to prevent brute-force via MCP client
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
  // R23 H-2: Hard cap prevents unbounded growth under pathological clock skew
  if (signupTimestamps.length > 100) signupTimestamps.length = 100;
  if (signupTimestamps.length >= BOOTSTRAP_SIGNUP_MAX) return false;
  signupTimestamps.push(now);
  return true;
}

export function registerAccountTools(server: McpServer, httpClient: HttpClient): void {
  server.tool(
    "dominusnode_get_account_info",
    "Get account details including email, status, and MFA configuration.",
    {},
    async () => {
      try {
        const info = await httpClient.get<AccountInfo>("/api/auth/me");
        const text = [
          `Email: ${info.email}`,
          `Status: ${info.status}`,
          `MFA Enabled: ${info.mfa_enabled ? "yes" : "no"}`,
          `Account Created: ${info.created_at}`,
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
        const data = await httpClient.post<{ token: string; refreshToken: string; user: { id: string; email: string } }>(
          "/api/auth/register",
          { email: args.email, password: args.password },
          false,
        );
        // R19 H-4: Store tokens so subsequent authenticated calls work (bootstrap mode)
        if (data.token && data.refreshToken) {
          httpClient.storeTokens(data.token, data.refreshToken);
        }

        // Email is auto-verified server-side for MCP agents (X-DominusNode-Agent header).
        // Payments (Stripe + crypto) are immediately available.
        const text = [
          `Account created successfully!`,
          `Email: ${data.user.email}`,
          `User ID: ${data.user.id}`,
          `Email: auto-verified (MCP agent)`,
          ``,
          `You are now authenticated. Payments (Stripe + crypto) are enabled.`,
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
      // R24 H-2: Rate limit login attempts to prevent brute-force via MCP client
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
        // R19 H-4: Store tokens so subsequent authenticated calls work (bootstrap mode)
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
        // Step 1: Register
        // Email is auto-verified server-side for MCP agents (X-DominusNode-Agent header)
        const reg = await httpClient.post<{ token: string; refreshToken: string; user: { id: string; email: string } }>(
          "/api/auth/register",
          { email: args.email, password: args.password },
          false,
        );

        // R19 H-4: Store tokens from registration so subsequent authenticated calls work (bootstrap mode)
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
          `  curl -x http://USER:${keyData.key}@proxy.dominusnode.com:8080 https://httpbin.org/ip`,
          ``,
          `Free tier: 10 connections, 1GB bandwidth.`,
          `Payments enabled: use dominusnode_pay_crypto to add funds (Stripe + crypto supported).`,
          `Set DOMINUSNODE_API_KEY=${keyData.key} and restart to unlock all 41 tools.`,
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

  server.tool(
    "dominusnode_verify_email",
    "Verify your email address using a verification token. The token is returned when registering via API/MCP. Email verification is required before you can make payments (Stripe or crypto). Wallet-authenticated accounts are auto-verified and do not need this.",
    {
      token: z.string().min(32).max(128).describe("Email verification token from registration response"),
    },
    async (args) => {
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
}
