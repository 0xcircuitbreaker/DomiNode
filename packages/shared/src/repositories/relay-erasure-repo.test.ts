import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RELAY_ERASURE_STATEMENTS, eraseRelayPersonalDataTx, PAYOUT_ERASURE_REVERSAL_SQL, X402_ERASURE_SQL, PAYOUT_IN_FLIGHT_SQL, PayoutInFlightError,
} from "./relay-erasure-repo.js";

const schema = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");

// Relay-network tables that keep user-linked rows on purpose, with the reason.
const KEPT: Record<string, string> = {
  relay_charges: "financial ledger (ON DELETE SET NULL; users row is anonymized, not deleted)",
  node_credit_accounts: "earnings ledger balance",
  node_credit_transactions: "earnings ledger",
  requester_spend_daily: "spend totals only, no identifiers",
  collusion_flags: "abuse control",
  starter_credit_ledger: "financial ledger",
  contribution_allowlist: "admin policy row",
  genesis_members: "earnings program record",
  mpp_transactions: "payment idempotency ledger",
  wallet_overflow_credits: "financial ledger (money owed to the user)",
};

function relayTablesWithUserLinks(): string[] {
  const start = schema.indexOf("CREATE TABLE IF NOT EXISTS nodes (");
  expect(start).toBeGreaterThan(0);
  const out: string[] = [];
  const re = /CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g;
  re.lastIndex = start;
  let m: RegExpExecArray | null;
  while ((m = re.exec(schema))) {
    const body = m[2];
    if (/^\s*(user_id|owner_user_id|requester_user_id|reporter_user_id)\s/m.test(body)) out.push(m[1]);
  }
  return out;
}

describe("relay erasure", () => {
  it("covers every user-linked relay-network table in schema.sql (or documents why it is kept)", () => {
    const covered = new Set(RELAY_ERASURE_STATEMENTS.map((s) => s.label));
    const tables = relayTablesWithUserLinks();
    expect(tables).toContain("relay_abuse_log");
    expect(tables).toContain("payout_wallets");
    const missing = tables.filter((t) => !covered.has(t) && !KEPT[t]);
    expect(missing).toEqual([]);
  });

  it("hashes a legacy plaintext starter-grant funding source on erasure", () => {
    const sql = RELAY_ERASURE_STATEMENTS.find((s) => s.label === "starter_credit_grants")?.sql ?? "";
    expect(sql).toMatch(/ip_prefix = NULL/);
    expect(sql).toMatch(/funding_source = CASE/);
    expect(sql).toMatch(/sha256\(convert_to\('starter-funding:'/);
  });

  it("anonymizes admin audit rows about the erased user (and their nodes)", () => {
    const sql = RELAY_ERASURE_STATEMENTS.find((s) => s.label === "audit_events_about_user")?.sql ?? "";
    expect(sql).toMatch(/UPDATE audit_events SET resource_id = 'REDACTED', details = NULL/);
    expect(sql).toMatch(/details->>'requesterId' = \$1::text/);
    expect(sql).toMatch(/resource_id = \$1::text/);
    expect(sql).toMatch(/FROM nodes WHERE owner_user_id::text = \$1::text/);
  });

  it("scrubs destination and wallet from pending settle retries", () => {
    const sql = RELAY_ERASURE_STATEMENTS.find((s) => s.label === "relay_settle_retries_pending")?.sql ?? "";
    expect(sql).toMatch(/UPDATE relay_settle_retries/);
    expect(sql).toMatch(/status = 'pending'/);
    expect(sql).toMatch(/"destHost":"redacted"/);
    expect(sql).toMatch(/- 'usageTargetHost'/);
  });

  it("deletes the requester's abuse-log rows and strips node IPs, slots and payout wallets", () => {
    const sql = (l: string) => RELAY_ERASURE_STATEMENTS.find((s) => s.label === l)?.sql ?? "";
    expect(sql("relay_abuse_log")).toMatch(/DELETE FROM relay_abuse_log WHERE requester_user_id = \$1/);
    expect(sql("nodes")).toMatch(/observed_ip = NULL/);
    expect(sql("nodes")).toMatch(/ip_prefix24 = NULL/);
    expect(sql("nodes")).toMatch(/asn = NULL/);
    expect(sql("nodes")).toMatch(/status = 'revoked'/);
    expect(sql("node_ip_slots")).toMatch(/DELETE FROM node_ip_slots/);
    expect(sql("payout_wallets")).toMatch(/DELETE FROM payout_wallets WHERE user_id = \$1/);
    for (const s of RELAY_ERASURE_STATEMENTS) {
      expect(s.sql).not.toMatch(/\*/);
      expect(s.sql).toContain("$1");
    }
  });

  it("runs every statement on the caller's client with the user id", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    await eraseRelayPersonalDataTx(client as never, "u1");
    expect(client.query).toHaveBeenCalledTimes(RELAY_ERASURE_STATEMENTS.length + 4);
    for (const c of client.query.mock.calls) {
      if (c[0] === X402_ERASURE_SQL) expect(c[1]).toEqual(["u1", null]);
      else expect(c[1]).toEqual(["u1"]);
    }
  });

  it("redacts x402 payers case-insensitively and via payer_identities, before that link is deleted", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const checksummed = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    await eraseRelayPersonalDataTx(client as never, "u1", checksummed);
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    const x = sqls.indexOf(X402_ERASURE_SQL);
    const pi = sqls.findIndex((s) => s.startsWith("DELETE FROM payer_identities"));
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(pi);
    expect(client.query.mock.calls[x][1]).toEqual(["u1", checksummed]);
    expect(X402_ERASURE_SQL).toMatch(/[^(]payer_address = lower\(\$2::text\)/);
    // Plain column on the left so idx_x402_transactions_payer is usable.
    expect(X402_ERASURE_SQL).not.toMatch(/lower\(payer_address\)/);
    expect(X402_ERASURE_SQL).toMatch(/payer_identities WHERE user_id = \$1/);
  });

  it("reverses unsent payouts (with re-credit) before deleting the payout wallet", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    await eraseRelayPersonalDataTx(client as never, "u1");
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    const rev = sqls.indexOf(PAYOUT_ERASURE_REVERSAL_SQL);
    const pw = sqls.findIndex((s) => s.startsWith("DELETE FROM payout_wallets"));
    expect(rev).toBeGreaterThanOrEqual(0);
    expect(rev).toBeLessThan(pw);
    expect(PAYOUT_ERASURE_REVERSAL_SQL).toMatch(/status = 'reversed'/);
    expect(PAYOUT_ERASURE_REVERSAL_SQL).toMatch(/status IN \('pending','held_tax','held_frozen'\)/);
    expect(PAYOUT_ERASURE_REVERSAL_SQL).toMatch(/withdraw_reversal/);
    expect(PAYOUT_ERASURE_REVERSAL_SQL).toMatch(/available_musd = available_musd \+/);
  });

  it("refuses erasure while a payout is submitted/on-chain", async () => {
    const client = {
      query: vi.fn(async (sql: string) =>
        sql === PAYOUT_IN_FLIGHT_SQL ? { rows: [{ id: "p1" }], rowCount: 1 } : { rows: [], rowCount: 0 }),
    };
    await expect(eraseRelayPersonalDataTx(client as never, "u1")).rejects.toBeInstanceOf(PayoutInFlightError);
    const sqls = client.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.startsWith("DELETE FROM payout_wallets"))).toBe(false);
    expect(PAYOUT_IN_FLIGHT_SQL).toMatch(/status = 'submitted'/);
  });
});
