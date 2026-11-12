#!/usr/bin/env node
// Set the one account allowed to hold the root_admin role.
// Usage: npm run admin:set-root -- <email>
// Needs DATABASE_URL with direct DB access. The address is stored only in the
// database (root_admin_identity), never in source or env, and the account is
// promoted if it already exists.
import pg from "pg";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error("usage: npm run admin:set-root -- <email>");
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("UPDATE users SET admin_role = 'admin' WHERE admin_role = 'root_admin' AND LOWER(email) <> $1", [email]);
  await client.query(
    `INSERT INTO root_admin_identity (singleton, email) VALUES (true, $1)
     ON CONFLICT (singleton) DO UPDATE SET email = EXCLUDED.email, set_at = now()`,
    [email],
  );
  const r = await client.query(
    "UPDATE users SET admin_role = 'root_admin' WHERE LOWER(email) = $1 AND status = 'active' RETURNING id",
    [email],
  );
  await client.query("COMMIT");
  console.log(r.rowCount ? "root admin set and account promoted" : "root admin set; the account will be promoted when it exists (rerun after it signs up)");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await client.end();
}
