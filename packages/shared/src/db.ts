import pg from "pg";
import { createLogger } from "./logger.js";

const log = createLogger("db");

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connStr = process.env["DATABASE_URL"];
    if (!connStr) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    const poolMax = parseInt(process.env["DB_POOL_MAX"] ?? "20", 10);
    const poolMin = parseInt(process.env["DB_POOL_MIN"] ?? "2", 10);
    const connTimeout = parseInt(process.env["DB_CONNECTION_TIMEOUT_MS"] ?? "5000", 10);
    pool = new pg.Pool({
      connectionString: connStr,
      max: poolMax,
      min: poolMin,
      connectionTimeoutMillis: connTimeout,
      idleTimeoutMillis: 30000,
      statement_timeout: 10000,
      ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: true }
        : false,
    });
    pool.on("connect", () => {
      log.debug("new client connected to pool");
    });
    pool.on("error", (err) => {
      // Only log message — full error object may contain DATABASE_URL credentials
      log.error("unexpected pool error", { error: err.message });
    });
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Connect to the database with retry logic (exponential backoff).
 * Use in main.ts entrypoints to ensure DB is available before starting.
 */
export async function connectWithRetry(maxAttempts: number = 5): Promise<void> {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await getPool().connect();
      client.release();
      log.info(`connected successfully (attempt ${attempt})`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`connection attempt ${attempt}/${maxAttempts} failed`, { error: msg });
      if (attempt === maxAttempts) {
        throw new Error(`Failed to connect to database after ${maxAttempts} attempts: ${msg}`);
      }
      const delay = delays[attempt - 1] ?? 16000;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
