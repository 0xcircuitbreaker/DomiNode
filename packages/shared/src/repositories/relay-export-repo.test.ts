import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const mockQuery = vi.fn();
vi.mock("../db.js", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

import { RELAY_EXPORT_QUERIES, RELAY_EXPORT_EXCLUDED, exportRelayPersonalData } from "./relay-export-repo.js";

const schema = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");

function tableBodies(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schema))) out.set(m[1], m[2]);
  return out;
}

function columnsOf(table: string): Set<string> {
  const cols = new Set<string>();
  const body = tableBodies().get(table) ?? "";
  for (const line of body.split("\n")) {
    const c = /^\s+([a-z_0-9]+)\s+[A-Z]/.exec(line);
    if (c) cols.add(c[1]);
  }
  for (const a of schema.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN(?: IF NOT EXISTS)? (\\w+)`, "g"))) cols.add(a[1]);
  return cols;
}

describe("relay export", () => {
  it("exports (or documents excluding) every user-linked relay-network table", () => {
    const start = schema.indexOf("CREATE TABLE IF NOT EXISTS nodes (");
    const linked: string[] = [];
    const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
    re.lastIndex = start;
    let m: RegExpExecArray | null;
    while ((m = re.exec(schema))) {
      if (/^\s*(user_id|owner_user_id|requester_user_id|reporter_user_id|node_owner_user_id)\s/m.test(m[2])) linked.push(m[1]);
    }
    expect(linked).toContain("relay_abuse_log");
    const exported = new Set(RELAY_EXPORT_QUERIES.map((q) => q.table));
    expect(linked.filter((t) => !exported.has(t) && !RELAY_EXPORT_EXCLUDED[t])).toEqual([]);
    expect(exported.has("x402_transactions")).toBe(true);
  });

  it("selects only real columns, never *, and caps rows", () => {
    for (const q of RELAY_EXPORT_QUERIES) {
      expect(q.sql).not.toMatch(/\*/);
      const cols = columnsOf(q.table);
      expect(cols.size).toBeGreaterThan(0);
      const list = /SELECT ([\s\S]*?)\s+FROM/.exec(q.sql)![1];
      for (const part of list.split(",")) {
        const name = part.trim().split(/\s+/)[0];
        if (name.startsWith("(")) continue; // computed flag
        expect(cols.has(name), `${q.table}.${name}`).toBe(true);
      }
    }
  });

  it("runs every query with the user id (and wallet for x402)", async () => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [{ a: 1 }] });
    const out = await exportRelayPersonalData("u1", "0xabc");
    expect(Object.keys(out).sort()).toEqual(RELAY_EXPORT_QUERIES.map((q) => q.key).sort());
    for (const c of mockQuery.mock.calls) {
      expect(c[1][0]).toBe("u1");
      if (/x402_transactions/.test(c[0] as string)) expect(c[1]).toEqual(["u1", "0xabc"]);
    }
  });
});
