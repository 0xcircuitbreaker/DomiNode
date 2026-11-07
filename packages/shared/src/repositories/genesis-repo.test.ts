import { describe, it, expect, vi } from "vitest";
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: vi.fn() }) }));
import { enrolTx, clawbackCreditTx } from "./genesis-repo.js";

const SETTINGS = { enabled: true, max_owners: 200, bonus_bps: 500, boost_days: 90, credit_musd: "5000000", credit_threshold_bytes: "5000000000", updated_by: null, updated_at: null };

function client(o: { settings?: Partial<typeof SETTINGS>; members?: number } = {}) {
  const calls: Array<{ sql: string; p: unknown[] }> = [];
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    calls.push({ sql, p });
    if (sql.includes("FROM genesis_settings")) return { rows: [{ ...SETTINGS, ...o.settings }] };
    if (sql.includes("COUNT(*)::text AS n, MAX(seq)")) return { rows: [{ n: String(o.members ?? 0), max_seq: o.members ? String(o.members) : null }] };
    if (sql.includes("INSERT INTO genesis_members")) return { rows: [{ owner_user_id: "x" }] };
    if (sql.includes("FROM genesis_members WHERE owner_user_id")) return { rows: [{ credit_musd: "5000000" }] };
    if (sql.includes("FROM node_credit_accounts")) return { rows: [{ user_id: "o", pending_musd: "3000000", available_musd: "0", auto_convert_pct: 0, frozen: false, tax_form_status: "not_required", tax_form_type: null, tax_form_received_at: null, tax_year: null, ytd_paid_musd: "0", updated_at: new Date() }] };
    return { rows: [] };
  });
  return { c: { query } as never, calls };
}

describe("genesis enrolment", () => {
  it("fills only the remaining slots, excludes seed/admin/self-dealing owners, under a lock", async () => {
    const { c, calls } = client({ members: 150 });
    expect(await enrolTx(c)).toBe(1);
    expect(calls[0].sql).toContain("pg_advisory_xact_lock");
    const ins = calls.find((x) => x.sql.includes("INSERT INTO genesis_members"))!;
    expect(ins.p).toEqual([50, 90, 150]);
    expect(ins.sql).toContain("n.operator_run");
    expect(ins.sql).toContain("NOT u.is_admin");
    expect(ins.sql).toContain("rc.node_musd > 0");
    expect(ins.sql).toContain("requester_user_id IS DISTINCT FROM rc.node_owner_user_id");
  });

  it("does nothing when full or disabled", async () => {
    expect(await enrolTx(client({ members: 200 }).c)).toBe(0);
    expect(await enrolTx(client({ settings: { enabled: false } }).c)).toBe(0);
  });

  it("clawback takes at most what is still pending", async () => {
    const { c, calls } = client();
    expect(await clawbackCreditTx(c, "o", "admin")).toBe(3_000_000n);
    expect(calls.some((x) => x.sql.includes("'clawback'"))).toBe(true);
    expect(calls.some((x) => x.sql.includes("credit_status = 'clawed_back'"))).toBe(true);
  });
});
