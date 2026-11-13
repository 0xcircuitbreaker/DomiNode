import { describe, it, expect, vi } from "vitest";
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: vi.fn() }) }));
import { enrolTx, clawbackCreditTx, DEFAULT_GENESIS_SETTINGS } from "./genesis-repo.js";

const SETTINGS = { enabled: true, max_owners: 200, bonus_bps: 500, boost_days: 90, credit_musd: "5000000", credit_threshold_bytes: "5000000000", min_distinct_payers: 3, updated_by: null, updated_at: null };

function client(o: { settings?: Partial<typeof SETTINGS>; members?: number; candidates?: string[]; linked?: string[] } = {}) {
  const calls: Array<{ sql: string; p: unknown[] }> = [];
  const query = vi.fn(async (sql: string, p: unknown[] = []) => {
    calls.push({ sql, p });
    if (sql.includes("FROM genesis_settings")) return { rows: [{ ...SETTINGS, ...o.settings }] };
    if (sql.includes("COUNT(*)::text AS n, MAX(seq)")) return { rows: [{ n: String(o.members ?? 0), max_seq: o.members ? String(o.members) : null }] };
    if (sql.includes("SELECT rc.node_owner_user_id AS owner")) return { rows: (o.candidates ?? ["x"]).map((owner) => ({ owner })) };
    if (sql.startsWith("SELECT 1 WHERE")) return { rows: (o.linked ?? []).includes(p[0] as string) ? [{ "?column?": 1 }] : [] };
    if (sql.includes("INSERT INTO genesis_members")) return { rows: [{ owner_user_id: p[0] }] };
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
    const sel = calls.find((x) => x.sql.includes("SELECT rc.node_owner_user_id AS owner"))!;
    expect(sel.p).toEqual([500, 3, "1000000", []]);
    // Linked owners are excluded in the candidate SQL itself (no starvation).
    expect(sel.sql).toContain("FROM genesis_members g WHERE g.owner_user_id <> rc.node_owner_user_id");
    // Payer diversity: >= N unlinked, matured, paying principals that each spent >= $1.
    expect(sel.sql).toContain("HAVING COUNT(*) >= $2::int");
    expect(sel.sql).toContain("HAVING SUM(q.gross_musd) >= $3::bigint");
    expect(sel.sql).toContain("q.matured");
    expect(sel.sql).toContain("q.starter_musd = 0");
    expect(sel.sql).toContain("payment_provider <> 'node_credits'");
    expect(sel.sql).toContain("team_members a JOIN team_members b");
    expect(sel.sql).toContain("back.requester_user_id = q.node_owner_user_id");
    expect(sel.sql).toContain("lower(ow.owner_wallet) = lower(ru.wallet_address)");
    expect(sel.sql).toContain("n.operator_run");
    expect(sel.sql).toContain("NOT u.is_admin");
    expect(sel.sql).toContain("rc.node_musd > 0");
    expect(sel.sql).toContain("requester_user_id IS DISTINCT FROM rc.node_owner_user_id");
    const ins = calls.find((x) => x.sql.includes("INSERT INTO genesis_members"))!;
    expect(ins.p).toEqual(["x", 151, 90]);
  });

  it("passes the admin-tuned payer threshold", async () => {
    const { c, calls } = client({ settings: { min_distinct_payers: 7 } });
    await enrolTx(c);
    expect(calls.find((x) => x.sql.includes("SELECT rc.node_owner_user_id AS owner"))!.p[1]).toBe(7);
  });

  it("gives one slot per beneficial owner: linked candidates are skipped, seq stays dense", async () => {
    const { c, calls } = client({ members: 198, candidates: ["a", "b", "c", "d"], linked: ["b"] });
    expect(await enrolTx(c)).toBe(2);
    const ins = calls.filter((x) => x.sql.includes("INSERT INTO genesis_members")).map((x) => x.p.slice(0, 2));
    expect(ins).toEqual([["a", 199], ["c", 200]]);
  });

  it("is seeded disabled", () => {
    expect(DEFAULT_GENESIS_SETTINGS.enabled).toBe(false);
    expect(DEFAULT_GENESIS_SETTINGS.creditThresholdNodeMusd).toBe(2n * DEFAULT_GENESIS_SETTINGS.creditMusd);
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
