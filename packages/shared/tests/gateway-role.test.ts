import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

/**
 * scripts/selfhost/gateway-role.sql: the split-install gateway's Postgres role
 * must not be a superuser and must not reach server programs/files or DDL.
 * Live check against a scratch database, e.g. local Postgres 16:
 *   DN_SCHEMA_TEST_PG_URL=postgresql://user:pw@127.0.0.1:5432/postgres
 */
const ROOT = path.resolve(__dirname, "../../..");
const roleSql = fs.readFileSync(path.join(ROOT, "scripts/selfhost/gateway-role.sql"), "utf8");
const schemaSql = fs.readFileSync(path.join(ROOT, "packages/shared/src/schema.sql"), "utf8");
const url = process.env.DN_SCHEMA_TEST_PG_URL;

describe("gateway-role.sql", () => {
  it("never grants superuser powers or DDL", () => {
    expect(roleSql).toMatch(/NOSUPERUSER/);
    expect(roleSql).not.toMatch(/GRANT\s+ALL/i);
    expect(roleSql).not.toMatch(/GRANT\s+(CREATE|TRUNCATE|TRIGGER)/i);
    expect(roleSql).toContain(":'pw'");
  });

  it.skipIf(!url)("gives row access only, idempotently, on a migrated database", async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const db = `dn_gw_role_${process.pid}`;
    await admin.query(`CREATE DATABASE ${db}`);
    const pw = "abcdefabcdefabcdefabcdef12";
    const at = (user?: string) => {
      const u = new URL(url!);
      u.pathname = `/${db}`;
      if (user) { u.username = user; u.password = pw; }
      return u.toString();
    };
    try {
      const owner = new pg.Client({ connectionString: at() });
      await owner.connect();
      await owner.query(schemaSql);
      // psql substitutes :'pw'; here the literal is inlined the same way.
      const sql = roleSql.replace(":'pw'", `'${pw}'`);
      await owner.query(sql);
      await owner.query(sql);
      await owner.end();

      const gw = new pg.Client({ connectionString: at("dominusnode_gateway") });
      await gw.connect();
      try {
        await gw.query("SELECT count(*) FROM users");
        await gw.query("SELECT count(*) FROM nodes");
        await expect(gw.query("SELECT 1 FROM mfa_configs LIMIT 1")).rejects.toThrow(/permission denied/);
        await expect(gw.query("CREATE TABLE gw_probe (a int)")).rejects.toThrow(/permission denied/);
        await expect(gw.query("TRUNCATE users")).rejects.toThrow(/permission denied/);
        await expect(gw.query("COPY (SELECT 1) TO PROGRAM 'true'")).rejects.toThrow(/permission denied|must be superuser|privileges/);
        const r = await gw.query<{ rolsuper: boolean }>("SELECT rolsuper FROM pg_roles WHERE rolname = current_user");
        expect(r.rows[0].rolsuper).toBe(false);
      } finally {
        await gw.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db}`);
      await admin.query("DROP ROLE IF EXISTS dominusnode_gateway").catch(() => undefined);
      await admin.end();
    }
  }, 60_000);
});
