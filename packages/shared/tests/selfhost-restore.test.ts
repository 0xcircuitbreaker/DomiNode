import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import pg from "pg";

/**
 * scripts/selfhost/restore.sh must load a split-coordinator dump (which holds
 * GRANTs to the dominusnode_gateway cluster role) into a cluster where that
 * role does not exist. Live check, e.g. local Postgres 16:
 *   DN_SCHEMA_TEST_PG_URL=postgresql://user:pw@127.0.0.1:5432/postgres
 */
const ROOT = path.resolve(__dirname, "../../..");
const restoreSh = fs.readFileSync(path.join(ROOT, "scripts/selfhost/restore.sh"), "utf8");
const url = process.env.DN_SCHEMA_TEST_PG_URL;

/** The pg_restore flags restore.sh uses (everything but -U/-d and the redirect). */
function restoreFlags(): string[] {
  const line = restoreSh.split("\n").find((l) => /\bpg_restore -/.test(l) && !l.trim().startsWith("#"));
  if (!line) throw new Error("no pg_restore call in restore.sh");
  const args = line.slice(line.indexOf("pg_restore") + "pg_restore".length).split("<")[0].trim().split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-U" || args[i] === "-d") { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

describe("restore.sh pg_restore", () => {
  it("skips ACLs (install.sh re-applies the gateway role)", () => {
    expect(restoreFlags()).toContain("--no-acl");
  });

  it.skipIf(!url || spawnSync("pg_dump", ["--version"]).status !== 0)(
    "restores a dump with grants to a role the target cluster lacks",
    async () => {
      const role = `dn_restore_gw_${process.pid}`;
      const src = `dn_restore_src_${process.pid}`;
      const dst = `dn_restore_dst_${process.pid}`;
      const at = (db: string) => { const u = new URL(url!); u.pathname = `/${db}`; return u.toString(); };
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dn-restore-"));
      try {
        await admin.query(`CREATE ROLE ${role}`);
        await admin.query(`CREATE DATABASE ${src}`);
        await admin.query(`CREATE DATABASE ${dst}`);
        const s = new pg.Client({ connectionString: at(src) });
        await s.connect();
        await s.query(`CREATE TABLE t (a int); INSERT INTO t VALUES (7); GRANT SELECT ON t TO ${role}`);
        await s.end();
        const dump = path.join(tmp, "db.dump");
        const d = spawnSync("pg_dump", ["-Fc", "-f", dump, at(src)], { encoding: "utf8" });
        expect(d.status, d.stderr).toBe(0);
        // The fresh cluster has no gateway role.
        await admin.query(`DROP DATABASE ${src}`);
        await admin.query(`DROP ROLE ${role}`);
        const r = spawnSync("pg_restore", ["-d", at(dst), ...restoreFlags(), dump], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        const c = new pg.Client({ connectionString: at(dst) });
        await c.connect();
        expect((await c.query("SELECT a FROM t")).rows).toEqual([{ a: 7 }]);
        await c.end();
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
        await admin.query(`DROP DATABASE IF EXISTS ${src}`);
        await admin.query(`DROP DATABASE IF EXISTS ${dst}`);
        await admin.query(`DROP ROLE IF EXISTS ${role}`);
        await admin.end();
      }
    },
  );
});
