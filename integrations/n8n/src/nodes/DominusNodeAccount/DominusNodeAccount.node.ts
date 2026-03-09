/**
 * Dominus Node Account n8n community node.
 *
 * Operations (6 tools):
 * - Register: Create a new account
 * - Login: Log in with email and password
 * - Get Account Info: Get current account details
 * - Verify Email: Verify email with a token
 * - Resend Verification: Resend the email verification link
 * - Update Password: Change account password
 *
 * Security:
 * - Credential sanitization in error messages
 * - Email and password validation
 * - Control character rejection
 *
 * @module
 */

import * as crypto from "node:crypto";

import {
  IDataObject,
  IExecuteFunctions,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from "n8n-workflow";

import { DominusNodeAuth, sanitizeError } from "../../shared/auth";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

// ---------------------------------------------------------------------------
// SHA-256 Proof-of-Work solver
// ---------------------------------------------------------------------------

function countLeadingZeroBits(buf: Buffer): number {
  let count = 0;
  for (const byte of buf) {
    if (byte === 0) { count += 8; continue; }
    let mask = 0x80;
    while (mask && !(byte & mask)) { count++; mask >>= 1; }
    break;
  }
  return count;
}

async function solvePoW(baseUrl: string): Promise<{ challengeId: string; nonce: string } | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/auth/pow/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "error",
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (text.length > 10_485_760) return null;
    const challenge = JSON.parse(text);
    const prefix: string = challenge.prefix ?? "";
    const difficulty: number = challenge.difficulty ?? 20;
    const challengeId: string = challenge.challengeId ?? "";
    if (!prefix || !challengeId) return null;
    for (let nonce = 0; nonce < 100_000_000; nonce++) {
      const hash = crypto.createHash("sha256").update(prefix + nonce.toString()).digest();
      if (countLeadingZeroBits(hash) >= difficulty) {
        return { challengeId, nonce: nonce.toString() };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export class DominusNodeAccount implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Dominus Node Account",
    name: "dominusNodeAccount",
    icon: "file:dominusnode.svg",
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: "Manage Dominus Node account registration, login, and settings",
    defaults: { name: "Dominus Node Account" },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [{ name: "dominusNodeApi", required: true }],
    properties: [
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        options: [
          { name: "Register", value: "register", description: "Create a new account", action: "Register" },
          { name: "Login", value: "login", description: "Log in with email and password", action: "Login" },
          { name: "Get Account Info", value: "getAccountInfo", description: "Get current account details", action: "Get account info" },
          { name: "Verify Email", value: "verifyEmail", description: "Verify email with a token", action: "Verify email" },
          { name: "Resend Verification", value: "resendVerification", description: "Resend email verification link", action: "Resend verification" },
          { name: "Update Password", value: "updatePassword", description: "Change account password", action: "Update password" },
        ],
        default: "getAccountInfo",
      },

      // --- Register / Login ---
      {
        displayName: "Email",
        name: "email",
        type: "string",
        default: "",
        required: true,
        description: "Account email address",
        displayOptions: { show: { operation: ["register", "login"] } },
      },
      {
        displayName: "Password",
        name: "password",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        description: "Account password (8-128 characters)",
        displayOptions: { show: { operation: ["register", "login"] } },
      },

      // --- Verify Email ---
      {
        displayName: "Verification Token",
        name: "verificationToken",
        type: "string",
        default: "",
        required: true,
        description: "Email verification token received via email",
        displayOptions: { show: { operation: ["verifyEmail"] } },
      },

      // --- Update Password ---
      {
        displayName: "Current Password",
        name: "currentPassword",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        description: "Current account password",
        displayOptions: { show: { operation: ["updatePassword"] } },
      },
      {
        displayName: "New Password",
        name: "newPassword",
        type: "string",
        typeOptions: { password: true },
        default: "",
        required: true,
        description: "New password (8-128 characters)",
        displayOptions: { show: { operation: ["updatePassword"] } },
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];
    const credentials = await this.getCredentials("dominusNodeApi");

    const apiKey = credentials.apiKey as string;
    const baseUrl = (credentials.baseUrl as string) || "https://api.dominusnode.com";

    if (!apiKey) {
      throw new NodeOperationError(this.getNode(), "API Key is required");
    }

    const agentSecret = (credentials.agentSecret as string) || undefined;
    const auth = new DominusNodeAuth(apiKey, baseUrl, 30000, agentSecret);
    const operation = this.getNodeParameter("operation", 0) as string;

    for (let i = 0; i < items.length; i++) {
      try {
        let result: unknown;

        switch (operation) {
          case "register": {
            const email = this.getNodeParameter("email", i) as string;
            const password = this.getNodeParameter("password", i) as string;
            const safeEmail = validateEmail(this, email, i);
            const safePassword = validatePassword(this, password, i);
            // Solve PoW for CAPTCHA-free registration
            const pow = await solvePoW(baseUrl);
            const regBody: Record<string, unknown> = {
              email: safeEmail,
              password: safePassword,
            };
            if (pow) regBody.pow = pow;
            result = await auth.apiRequest("POST", "/api/auth/register", regBody);
            break;
          }

          case "login": {
            const email = this.getNodeParameter("email", i) as string;
            const password = this.getNodeParameter("password", i) as string;
            const safeEmail = validateEmail(this, email, i);
            const safePassword = validatePassword(this, password, i);
            result = await auth.apiRequest("POST", "/api/auth/login", {
              email: safeEmail,
              password: safePassword,
            });
            break;
          }

          case "getAccountInfo": {
            result = await auth.apiRequest("GET", "/api/auth/me");
            break;
          }

          case "verifyEmail": {
            const token = this.getNodeParameter("verificationToken", i) as string;
            if (!token || typeof token !== "string" || token.trim().length === 0) {
              throw new NodeOperationError(
                this.getNode(),
                "Verification token is required",
                { itemIndex: i },
              );
            }
            if (CONTROL_CHAR_RE.test(token)) {
              throw new NodeOperationError(
                this.getNode(),
                "Token contains invalid control characters",
                { itemIndex: i },
              );
            }
            result = await auth.apiRequest("POST", "/api/auth/verify-email", {
              token: token.trim(),
            });
            break;
          }

          case "resendVerification": {
            result = await auth.apiRequest("POST", "/api/auth/resend-verification");
            break;
          }

          case "updatePassword": {
            const currentPassword = this.getNodeParameter("currentPassword", i) as string;
            const newPassword = this.getNodeParameter("newPassword", i) as string;
            validatePassword(this, currentPassword, i);
            validatePassword(this, newPassword, i);
            result = await auth.apiRequest("POST", "/api/auth/change-password", {
              currentPassword,
              newPassword,
            });
            break;
          }

          default:
            throw new NodeOperationError(
              this.getNode(),
              `Unknown operation: ${operation}`,
              { itemIndex: i },
            );
        }

        returnData.push({ json: (result ?? {}) as IDataObject });
      } catch (err) {
        if (this.continueOnFail()) {
          returnData.push({
            json: {
              error: sanitizeError(err instanceof Error ? err.message : String(err)),
            },
          });
          continue;
        }
        if (err instanceof NodeOperationError) throw err;
        throw new NodeOperationError(
          this.getNode(),
          sanitizeError(err instanceof Error ? err.message : String(err)),
          { itemIndex: i },
        );
      }
    }

    return [returnData];
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateEmail(
  ctx: IExecuteFunctions,
  email: string,
  itemIndex: number,
): string {
  const trimmed = (email ?? "").trim();
  if (!trimmed || !EMAIL_RE.test(trimmed)) {
    throw new NodeOperationError(ctx.getNode(), "A valid email address is required", { itemIndex });
  }
  if (trimmed.length > 254) {
    throw new NodeOperationError(
      ctx.getNode(),
      "Email address too long (max 254 characters)",
      { itemIndex },
    );
  }
  return trimmed;
}

function validatePassword(
  ctx: IExecuteFunctions,
  password: string,
  itemIndex: number,
): string {
  if (!password || password.length < 8) {
    throw new NodeOperationError(
      ctx.getNode(),
      "Password must be at least 8 characters",
      { itemIndex },
    );
  }
  if (password.length > 128) {
    throw new NodeOperationError(
      ctx.getNode(),
      "Password must be at most 128 characters",
      { itemIndex },
    );
  }
  return password;
}
