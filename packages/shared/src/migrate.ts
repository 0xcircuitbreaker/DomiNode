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
  await pool.query(sql);
  console.log("[migrate] schema applied successfully");

  await closePool();
}

migrate().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
