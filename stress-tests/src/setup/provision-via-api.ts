/**
 * API-based user provisioner for production environments (no DB access needed).
 *
 * Uses the REST API to register users and create API keys.
 *
 * LIMITATION: Per-IP registration rate limit is 3 accounts/hour.
 * For more users, use DATABASE_URL with provision-users.ts instead.
 *
 * Usage:
 *   API_BASE_URL=https://api.dominusnode.daedalusdevelopmentgroup.com USER_COUNT=3 npx tsx provision-via-api.ts
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface TestUser {
  id: string;
  email: string;
  apiKey: string;
  apiKeyHash: string;
  apiKeyPrefix: string;
  planId: string;
  balanceCents: number;
}

interface ProvisionResult {
  users: TestUser[];
  createdAt: string;
  mode: string;
}

const DEFAULT_USER_COUNT = 3;
const DELAY_BETWEEN_REGISTRATIONS_MS = 1000; // Courtesy delay; rate limit is 3/hour
const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB — prevents unbounded memory from malicious server

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadBody(res: Response): Promise<string> {
  const contentLength = res.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
    throw new Error(`Response too large: ${contentLength} bytes`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_SIZE) {
    throw new Error(`Response body exceeds ${MAX_RESPONSE_SIZE} byte limit`);
  }
  return text;
}

function sanitizeForLog(text: string, maxLen = 200): string {
  const truncated = text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
  return truncated.replace(/[\n\r\x00-\x1f]/g, " ");
}

function validateApiUrl(url: string): void {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Only HTTP(S) URLs allowed, got: ${parsed.protocol}`);
  }
}

export async function provisionViaApi(
  apiBaseUrl: string,
  count: number = DEFAULT_USER_COUNT,
): Promise<ProvisionResult> {
  const users: TestUser[] = [];

  if (count > 3) {
    console.warn(
      `WARNING: Requesting ${count} users but per-IP rate limit is 3/hour.`,
    );
    console.warn(
      "Consider using DATABASE_URL with provision-users.ts for bulk provisioning.",
    );
  }

  for (let i = 0; i < count; i++) {
    const email = `stress-test-${i}@test.dominusnode.local`;
    const password = crypto.randomBytes(16).toString("hex");

    console.log(`  [${i + 1}/${count}] Registering ${email}...`);

    // Register user
    const registerRes = await fetch(`${apiBaseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      redirect: "error",
    });

    if (!registerRes.ok) {
      const body = await safeReadBody(registerRes);
      // If user already exists, try logging in
      if (registerRes.status === 409) {
        console.log(`    User exists, logging in...`);
        const loginRes = await fetch(`${apiBaseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
          redirect: "error",
        });

        if (!loginRes.ok) {
          console.error(
            `    SKIP: Cannot login to existing user (${loginRes.status})`,
          );
          continue;
        }

        const loginBody = await safeReadBody(loginRes);
        const loginData = JSON.parse(loginBody) as { token?: string };
        if (!loginData.token) {
          console.error("    SKIP: No token in login response");
          continue;
        }

        const apiKey = await createApiKey(apiBaseUrl, loginData.token);
        if (apiKey) {
          users.push(buildTestUser(email, apiKey));
        }
      } else if (registerRes.status === 429) {
        console.error(
          `    RATE LIMITED: ${sanitizeForLog(body)}. Stopping registration.`,
        );
        break;
      } else {
        console.error(
          `    FAIL: Registration failed (${registerRes.status}): ${sanitizeForLog(body)}`,
        );
        continue;
      }
    } else {
      const regBody = await safeReadBody(registerRes);
      const registerData = JSON.parse(regBody) as {
        token?: string;
        user?: { id?: string };
      };
      const token = registerData.token;

      if (!token) {
        console.error("    FAIL: No token in registration response");
        continue;
      }

      const apiKey = await createApiKey(apiBaseUrl, token);
      if (apiKey) {
        users.push(buildTestUser(email, apiKey, registerData.user?.id));
      }
    }

    // Delay between registrations to respect rate limits
    if (i < count - 1) {
      await sleep(DELAY_BETWEEN_REGISTRATIONS_MS);
    }
  }

  if (users.length === 0) {
    throw new Error("Failed to provision any test users");
  }

  const result: ProvisionResult = {
    users,
    createdAt: new Date().toISOString(),
    mode: "rest-api",
  };

  // Save to results directory
  const resultsDir = path.resolve(import.meta.dirname, "../../results");
  fs.mkdirSync(resultsDir, { recursive: true });
  const outputPath = path.join(resultsDir, "test-users.json");
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), {
    mode: 0o600,
  });

  console.log(`Provisioned ${users.length} test users via REST API`);
  console.log(`Credentials saved to ${outputPath}`);

  return result;
}

async function createApiKey(
  apiBaseUrl: string,
  token: string,
): Promise<string | null> {
  const keyRes = await fetch(`${apiBaseUrl}/api/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ label: "stress-test" }),
    redirect: "error",
  });

  if (!keyRes.ok) {
    const errBody = await safeReadBody(keyRes);
    console.error(`    FAIL: API key creation failed (${keyRes.status}): ${sanitizeForLog(errBody)}`);
    return null;
  }

  const keyBody = await safeReadBody(keyRes);
  const keyData = JSON.parse(keyBody) as { key?: string; rawKey?: string };
  const rawKey = keyData.key ?? keyData.rawKey;

  if (!rawKey) {
    console.error("    FAIL: No raw key in API key response");
    return null;
  }

  console.log(`    API key created: ${rawKey.slice(0, 12)}...`);
  return rawKey;
}

function buildTestUser(
  email: string,
  apiKey: string,
  id?: string,
): TestUser {
  const hash = crypto.createHash("sha256").update(apiKey).digest("hex");
  return {
    id: id ?? crypto.randomUUID(),
    email,
    apiKey,
    apiKeyHash: hash,
    apiKeyPrefix: apiKey.slice(0, 12),
    planId: "payg",
    balanceCents: 0, // Unknown — depends on wallet state
  };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const apiBaseUrl = process.env.API_BASE_URL;
  if (!apiBaseUrl) {
    console.error("ERROR: API_BASE_URL environment variable is required.");
    console.error(
      "Usage: API_BASE_URL=https://api.dominusnode.daedalusdevelopmentgroup.com USER_COUNT=3 npx tsx provision-via-api.ts",
    );
    process.exit(1);
  }

  try {
    validateApiUrl(apiBaseUrl);
  } catch (err) {
    console.error(`ERROR: Invalid API_BASE_URL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const count = parseInt(
    process.env.USER_COUNT ?? String(DEFAULT_USER_COUNT),
    10,
  );

  provisionViaApi(apiBaseUrl, count)
    .then((result) => {
      console.log(`Done. ${result.users.length} users ready.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Provisioning failed:", err);
      process.exit(1);
    });
}
