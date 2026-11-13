import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/**
 * schema.sql runs in full (one transaction) on every migrate. A block that
 * drops a CHECK constraint and re-adds it with an older, narrower value list
 * fails with check_violation once rows using a newer value exist, which leaves
 * an upgraded coordinator unable to migrate.
 */
const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");

interface CheckDef {
  name: string;
  line: number;
  text: string;
  unconditionalDrop: boolean;
}

function checkDefs(): CheckDef[] {
  const out: CheckDef[] = [];
  const re = /ADD CONSTRAINT (\w+)\s+CHECK\s*\(([\s\S]*?)\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const name = m[1];
    const before = sql.slice(Math.max(0, m.index - 400), m.index);
    const blockStart = before.lastIndexOf("DO $$");
    const block = blockStart >= 0 ? before.slice(blockStart) : before;
    out.push({
      name,
      line: sql.slice(0, m.index).split("\n").length,
      text: m[2].replace(/\s+/g, " ").trim(),
      unconditionalDrop:
        block.includes(`DROP CONSTRAINT IF EXISTS ${name}`) && !/\bIF NOT EXISTS\s*\(/.test(block),
    });
  }
  return out;
}

describe("schema.sql re-run safety", () => {
  it("never re-adds a CHECK constraint narrower than its final definition after an unconditional drop", () => {
    const byName = new Map<string, CheckDef[]>();
    for (const d of checkDefs()) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
    const stale: string[] = [];
    for (const [name, defs] of byName) {
      const last = defs[defs.length - 1];
      for (const d of defs.slice(0, -1)) {
        if (d.unconditionalDrop && d.text !== last.text) stale.push(`${name} @ line ${d.line}`);
      }
    }
    expect(stale).toEqual([]);
  });

  const url = process.env.DN_SCHEMA_TEST_PG_URL;
  // Live check against a scratch database (e.g. local Postgres 16):
  //   DN_SCHEMA_TEST_PG_URL=postgresql://postgres@/postgres?host=/var/run/postgresql
  it.skipIf(!url)("applies on a database that already holds egress_mismatch flags and masked x402 rows", async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const db = `dn_schema_rerun_${process.pid}`;
    await admin.query(`CREATE DATABASE ${db}`);
    try {
      const u = new URL(url!);
      u.pathname = `/${db}`;
      const c = new pg.Client({ connectionString: u.toString() });
      await c.connect();
      try {
        const apply = async () => {
          await c.query("BEGIN");
          await c.query(sql);
          await c.query("COMMIT");
        };
        await apply();
        await c.query("SET session_replication_role = replica");
        await c.query(
          `INSERT INTO collusion_flags (kind, owner_user_id, share_bps, volume_musd, total_musd, window_days)
           VALUES ('egress_mismatch', gen_random_uuid(), 0, 0, 0, 1)`,
        );
        await c.query(
          `INSERT INTO x402_transactions (facilitator, payer_address, amount_usd, pool_type, payment_hash)
           VALUES ('coinbase', '0xabc', '0.01', 'masked', repeat('a', 64))`,
        );
        await c.query("SET session_replication_role = origin");
        await apply();
        await apply();
      } finally {
        await c.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db}`);
      await admin.end();
    }
  }, 60_000);
});
