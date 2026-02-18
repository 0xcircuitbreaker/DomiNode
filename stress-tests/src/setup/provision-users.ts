import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Pool } = pg;

interface TestUser {
  id: string;
  email: string;
  apiKey: string; // raw key (dn_live_...)
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

const DEFAULT_USER_COUNT = 100;
const DEFAULT_BALANCE_CENTS = 10_000; // $100
const PASSWORD_HASH = "$2b$10$dummyhashforstresstesting000000000000000000000000000000"; // never used for login

function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const suffix = crypto.randomBytes(24).toString("hex");
  const raw = `dn_live_${suffix}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix };
}

function generateUUID(): string {
  return crypto.randomUUID();
}

export async function provisionUsers(
  databaseUrl: string,
  count: number = DEFAULT_USER_COUNT,
  planId: string = "payg",
  balanceCents: number = DEFAULT_BALANCE_CENTS,
  emailPrefix: string = "stress-test",
): Promise<ProvisionResult> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const users: TestUser[] = [];

    // Create users in batches of 50
    const batchSize = 50;
    for (let i = 0; i < count; i += batchSize) {
      const batchEnd = Math.min(i + batchSize, count);
      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        for (let j = i; j < batchEnd; j++) {
          const userId = generateUUID();
          const email = `${emailPrefix}-${j}@test.dominusnode.local`;
          const key = generateApiKey();

          // Insert user
          await client.query(
            `INSERT INTO users (id, email, password_hash, status, is_admin, plan_id)
             VALUES ($1, $2, $3, 'active', false, $4)
             ON CONFLICT (email) DO UPDATE SET status = 'active', plan_id = $4
             RETURNING id`,
            [userId, email, PASSWORD_HASH, planId],
          );

          // Get actual user ID (in case of conflict)
          const userResult = await client.query("SELECT id FROM users WHERE email = $1", [email]);
          const actualUserId = userResult.rows[0].id;

          // Upsert wallet
          await client.query(
            `INSERT INTO wallets (id, user_id, balance_cents, currency)
             VALUES ($1, $2, $3, 'USD')
             ON CONFLICT (user_id) DO UPDATE SET balance_cents = $3`,
            [generateUUID(), actualUserId, balanceCents],
          );

          // Revoke old API keys, insert new one
          await client.query(
            `UPDATE api_keys SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
            [actualUserId],
          );

          await client.query(
            `INSERT INTO api_keys (id, user_id, key_hash, key_prefix, label)
             VALUES ($1, $2, $3, $4, 'stress-test')`,
            [generateUUID(), actualUserId, key.hash, key.prefix],
          );

          users.push({
            id: actualUserId,
            email,
            apiKey: key.raw,
            apiKeyHash: key.hash,
            apiKeyPrefix: key.prefix,
            planId,
            balanceCents,
          });
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    const result: ProvisionResult = {
      users,
      createdAt: new Date().toISOString(),
      mode: "direct-sql",
    };

    // Save to results directory
    const resultsDir = path.resolve(import.meta.dirname, "../../results");
    fs.mkdirSync(resultsDir, { recursive: true });
    const outputPath = path.join(resultsDir, "test-users.json");
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });

    console.log(`Provisioned ${users.length} test users`);
    console.log(`Credentials saved to ${outputPath}`);

    return result;
  } finally {
    await pool.end();
  }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://dominusnode:dominusnode_dev@localhost:5432/dominusnode";
  const count = parseInt(process.env.USER_COUNT ?? String(DEFAULT_USER_COUNT), 10);
  const planId = process.env.PLAN_ID ?? "payg";
  const balanceCents = parseInt(process.env.BALANCE_CENTS ?? String(DEFAULT_BALANCE_CENTS), 10);

  provisionUsers(databaseUrl, count, planId, balanceCents)
    .then((result) => {
      console.log(`Done. ${result.users.length} users ready.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Provisioning failed:", err);
      process.exit(1);
    });
}
