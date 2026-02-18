import pg from "pg";

const { Pool } = pg;

export async function cleanupTestData(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Delete in order respecting foreign keys
      const testEmailPattern = "stress-test-%@test.dominusnode.local";

      // Get test user IDs
      const userResult = await client.query("SELECT id FROM users WHERE email LIKE $1", [
        testEmailPattern,
      ]);
      const userIds = userResult.rows.map((r: { id: string }) => r.id);

      if (userIds.length === 0) {
        console.log("No test users found to clean up.");
        await client.query("COMMIT");
        return;
      }

      console.log(`Cleaning up ${userIds.length} test users...`);

      // Delete dependent records
      await client.query("DELETE FROM usage_records WHERE user_id = ANY($1::uuid[])", [userIds]);
      await client.query("DELETE FROM sessions WHERE user_id = ANY($1::uuid[])", [userIds]);
      await client.query("DELETE FROM wallet_transactions WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id = ANY($1::uuid[]))", [userIds]);
      await client.query("DELETE FROM wallets WHERE user_id = ANY($1::uuid[])", [userIds]);
      await client.query("DELETE FROM api_keys WHERE user_id = ANY($1::uuid[])", [userIds]);
      await client.query("DELETE FROM refresh_tokens WHERE user_id = ANY($1::uuid[])", [userIds]);
      await client.query("DELETE FROM mfa_configs WHERE user_id = ANY($1::uuid[])", [userIds]);
      await client.query("DELETE FROM mfa_backup_codes WHERE user_id = ANY($1::uuid[])", [userIds]);
      await client.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);

      await client.query("COMMIT");
      console.log(`Cleaned up ${userIds.length} test users and all related data.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgresql://dominusnode:dominusnode_dev@localhost:5432/dominusnode";

  cleanupTestData(databaseUrl)
    .then(() => {
      console.log("Cleanup complete.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Cleanup failed:", err);
      process.exit(1);
    });
}
