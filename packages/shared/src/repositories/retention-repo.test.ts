import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockQuery = vi.fn();
vi.mock("../db.js", () => ({ query: (...args: unknown[]) => mockQuery(...args) }));

import { enforceRetentionPolicies, RETENTION_EXEMPT_TABLES, RETENTION_PURGEABLE_TABLES, scrubAbuseLogAccessAuditBatch } from "./retention-repo.js";

const here = __dirname;
const schema = readFileSync(join(here, "..", "schema.sql"), "utf8");

/** Every table named in an INSERT INTO data_retention_policies block. */
function policyTables(): string[] {
  const out = new Set<string>();
  const re = /INSERT INTO data_retention_policies[^;]*;/g;
  for (const block of schema.match(re) ?? []) {
    for (const m of block.matchAll(/\(\s*'([a-z_0-9]+)'\s*,\s*\d+/g)) out.add(m[1]);
  }
  return [...out];
}

describe("retention-repo", () => {
  beforeEach(() => mockQuery.mockReset());

  it("every declared retention policy is either enforced or explicitly exempt", () => {
    const tables = policyTables();
    expect(tables).toContain("pow_challenges");
    const unhandled = tables.filter((t) => !RETENTION_PURGEABLE_TABLES.has(t) && !RETENTION_EXEMPT_TABLES.has(t));
    expect(unhandled).toEqual([]);
  });

  it("purges pow_challenges (which hold caller IPs) by age", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ table_name: "pow_challenges", retention_days: 1 }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 3 });
    const n = await enforceRetentionPolicies();
    expect(n).toBe(3);
    expect(String(mockQuery.mock.calls[1][0])).toMatch(/DELETE FROM pow_challenges/);
    expect(mockQuery.mock.calls[1][1]).toEqual([1, 10_000]);
  });

  it("scrubs requester/host from abuse-log access audit rows past retention", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });
    expect(await scrubAbuseLogAccessAuditBatch(90)).toBe(2);
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/action = 'relay_abuse_log_access'/);
    expect(sql).toMatch(/- 'requesterId' - 'host'/);
    expect(sql).toMatch(/resource_id = 'REDACTED'/);
    // NULL details (erased rows) must still get the marker, or they are rewritten forever.
    expect(sql).toMatch(/details = \(COALESCE\(details, '\{\}'::jsonb\)/);
    expect(mockQuery.mock.calls[0][1]).toEqual([90, 1000]);
    await expect(scrubAbuseLogAccessAuditBatch(0)).rejects.toThrow();
  });
});
