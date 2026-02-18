import * as fs from "node:fs";
import * as path from "node:path";
import dotenv from "dotenv";

dotenv.config();

import { getPool, closePool } from "./db.js";

async function migrate(): Promise<void> {
  const schemaPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(schemaPath, "utf-8");

  console.log("[migrate] applying schema...");
  const pool = getPool();
  // R23 H-1: Wrap migration in transaction for atomicity — partial schema = broken DB
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    console.log("[migrate] schema applied successfully");

    // Log current schema version
    try {
      const result = await client.query(
        "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 1"
      );
      if (result.rows[0]) {
        console.log(`[migrate] schema version: ${result.rows[0].version} (applied: ${result.rows[0].applied_at})`);
      }
    } catch {
      // schema_migrations table may not exist in very old databases
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await closePool();
}

migrate().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
