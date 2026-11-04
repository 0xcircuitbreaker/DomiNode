import { vi } from "vitest";

export type Route = [RegExp, (params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>];

/** Client mock that answers by SQL pattern; records every call. */
export function routedClient(routes: Route[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const [re, fn] of routes) if (re.test(sql)) return fn(params);
    return { rows: [] };
  });
  return { client: { query, release: vi.fn() } as unknown as import("pg").PoolClient, calls, sqls: () => calls.map((c) => c.sql) };
}
