import pg from "pg";

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connStr = process.env["DATABASE_URL"];
    if (!connStr) {
      throw new Error("DATABASE_URL environment variable is required");
    }
    pool = new pg.Pool({
      connectionString: connStr,
      max: 20,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
      statement_timeout: 10000,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: true } : false,
    });
    pool.on("error", (err) => {
      console.error("[db] unexpected pool error", err);
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
