import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");

const NEW_TABLES = [
  "nodes",
  "node_challenges",
  "node_daily_stats",
  "node_reputation",
  "network_policy",
  "network_pricing",
  "revenue_split_config",
  "node_tiers",
  "relay_charges",
  "node_credit_accounts",
  "node_credit_transactions",
  "relay_abuse_log",
  "mpp_transactions",
  "payout_wallets",
  "node_payouts",
] as const;

/** Extract the body of `CREATE TABLE IF NOT EXISTS <name> ( ... );` */
function tableBody(name: string): string {
  const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\(`, "g");
  const m = re.exec(sql);
  if (!m) throw new Error(`table ${name} not found`);
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < sql.length && depth > 0; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") depth--;
  }
  return sql.slice(start, i - 1);
}

/** Top-level column definitions (split on commas at depth 0), comments stripped. */
function columnDefs(name: string): string[] {
  const body = tableBody(name).replace(/--[^\n]*/g, "");
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter((p) => !/^(CHECK|PRIMARY KEY|UNIQUE|CONSTRAINT)\b/i.test(p));
}

describe("schema.sql agent relay network", () => {
  it("defines every new table exactly once, idempotently", () => {
    for (const t of NEW_TABLES) {
      const n = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`, "g"));
      expect(n?.length, t).toBe(1);
    }
    expect(sql).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/);
  });

  it("caps node_share_bps at 5000 everywhere", () => {
    const checks = [...sql.matchAll(/node_share_bps BETWEEN (\d+) AND (\d+)/g)];
    expect(checks.length).toBeGreaterThanOrEqual(3);
    for (const c of checks) {
      expect(c[1]).toBe("0");
      expect(Number(c[2])).toBeLessThanOrEqual(5000);
    }
    expect(sql).not.toMatch(/node_share_bps BETWEEN 0 AND 10000/);
  });

  it("has no unbounded numeric columns in new tables", () => {
    for (const t of NEW_TABLES) {
      for (const col of columnDefs(t)) {
        const [colName, type] = col.split(/\s+/);
        if (!/^(INTEGER|BIGINT|SMALLINT|NUMERIC)$/i.test(type ?? "")) continue;
        // FK references are bounded by the referenced key
        if (/REFERENCES/i.test(col)) continue;
        expect(col, `${t}.${colName}`).toMatch(
          new RegExp(`CHECK \\(.*${colName}\\s+BETWEEN -?\\d+ AND \\d+`),
        );
      }
      // no single-sided numeric checks like `x >= 0` without ceiling
      expect(tableBody(t), t).not.toMatch(/CHECK \(\w+ (>=|>|<=|<) -?\d+\)/);
    }
  });

  it("hash columns enforce SHA-256 hex length", () => {
    for (const col of ["node_key_hash", "nonce_hash", "body_sha256", "payment_hash"]) {
      expect(sql).toMatch(new RegExp(`length\\(${col}\\) = 64`));
    }
  });

  it("relay_abuse_log carries metadata only (no url/path/query/payload columns)", () => {
    const names = columnDefs("relay_abuse_log").map((c) => c.split(/\s+/)[0]!.toLowerCase());
    for (const n of names) {
      expect(n).not.toMatch(/url|path|query|payload|body|header/);
    }
    expect(names).toEqual(
      expect.arrayContaining(["session_id", "node_id", "dest_host", "dest_port", "bytes"]),
    );
  });

  it("relay_charges is idempotent per session and snapshots tier + share", () => {
    const body = tableBody("relay_charges");
    expect(body).toMatch(/session_id\s+UUID UNIQUE REFERENCES sessions\(id\) ON DELETE SET NULL/);
    expect(body).toMatch(/tier_id\s+SMALLINT NOT NULL REFERENCES node_tiers\(id\)/);
    expect(body).toMatch(/node_share_bps\s+INTEGER NOT NULL/);
    expect(body).toMatch(/node_musd \+ platform_musd = gross_musd/);
  });

  it("seeds pricing for any, residential and dc", () => {
    expect(sql).toMatch(/\('any',\s*200000\)/);
    expect(sql).toMatch(/\('residential',\s*500000\)/);
    expect(sql).toMatch(/\('dc',\s*200000\)/);
  });

  it("seeds the 6 tiers with 25..50% shares", () => {
    const seed = sql.slice(sql.indexOf("INSERT INTO node_tiers"));
    const rows = [...seed.matchAll(/\(\d+, '(\w+)',\s*\d+,\s*(\d+),/g)].map((m) => [m[1], Number(m[2])]);
    expect(rows).toEqual([
      ["probation", 2500],
      ["bronze", 3000],
      ["silver", 3500],
      ["gold", 4000],
      ["platinum", 4500],
      ["partner", 5000],
    ]);
  });

  it("adds sessions.node_id, owner tier columns and 'relay' proxy_type", () => {
    expect(sql).toMatch(/ALTER TABLE sessions ADD COLUMN IF NOT EXISTS node_id UUID REFERENCES nodes\(id\) ON DELETE SET NULL/);
    expect(sql).toMatch(/ALTER TABLE users ADD COLUMN IF NOT EXISTS node_tier_id/);
    expect(sql).toMatch(/proxy_type IN \('dc', 'residential', 'relay'\)/);
  });

  it("wraps ADD CONSTRAINT in DO $$ guards", () => {
    const tail = sql.slice(sql.indexOf("Agent Relay Network"));
    const adds = tail.match(/ADD CONSTRAINT/g) ?? [];
    const guarded = tail.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    const guardedAdds = guarded.join("\n").match(/ADD CONSTRAINT/g) ?? [];
    expect(guardedAdds.length).toBe(adds.length);
  });

  it("new FKs to users/nodes/sessions/payout_wallets do not block GDPR deletion", () => {
    for (const table of ["relay_charges", "node_payouts"]) {
      for (const col of columnDefs(table)) {
        if (/REFERENCES (users|nodes|sessions|payout_wallets)\(id\)/.test(col) && !/^(created_by|updated_by)\b/.test(col)) {
          expect(col, `${table}: ${col}`).toMatch(/ON DELETE (SET NULL|CASCADE)/);
          if (/SET NULL/.test(col)) expect(col).not.toMatch(/NOT NULL/);
        }
      }
    }
  });

  it("node_credit_accounts tracks tax form status and yearly total", () => {
    const body = tableBody("node_credit_accounts");
    expect(body).toMatch(/tax_form_status\s+TEXT NOT NULL[\s\S]*CHECK \(tax_form_status IN/);
    expect(body).toMatch(/tax_form_received_at\s+TIMESTAMPTZ/);
    expect(body).toMatch(/ytd_paid_musd\s+BIGINT NOT NULL DEFAULT 0 CHECK/);
  });

  it("provider_check migrations never narrow on rerun", () => {
    const blocks = sql.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g) ?? [];
    const prov = blocks.filter((b) => b.includes("DROP CONSTRAINT IF EXISTS payment_invoices_provider_check"));
    expect(prov.length).toBe(2);
    for (const b of prov) expect(b).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM pg_constraint/);
    expect(prov.join()).not.toMatch(/EXCEPTION WHEN OTHERS/);
  });
});
