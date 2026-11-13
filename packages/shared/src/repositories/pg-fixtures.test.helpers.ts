/**
 * Fixtures for the opt-in PostgreSQL tests (*.pg.test.ts). They run only when
 * PG_TEST_URL points at a scratch database that has schema.sql applied, e.g.
 *   PG_TEST_URL=postgres://user:pw@localhost/scratch npx vitest run money-integrity
 * Never point PG_TEST_URL at a real database: the tests insert and delete rows.
 */
import crypto from "node:crypto";
import { query } from "../db.js";

export const PG_TEST_URL = process.env["PG_TEST_URL"] ?? "";
if (PG_TEST_URL) {
  process.env["DATABASE_URL"] = PG_TEST_URL;
  process.env["DB_SSL"] = "false";
}

const hex = (n: number): string => crypto.randomBytes(n).toString("hex");

export async function mkUser(opts: { wallet?: string | null; balanceCents?: number } = {}): Promise<string> {
  const wallet = opts.wallet === undefined ? `0x${hex(20)}` : opts.wallet;
  const r = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, wallet_address, email_verified) VALUES ($1, 'x', $2, true) RETURNING id`,
    [`t-${hex(6)}@test.invalid`, wallet],
  );
  const id = r.rows[0]!.id;
  await query(`INSERT INTO wallets (user_id, balance_cents) VALUES ($1, $2)`, [id, opts.balanceCents ?? 0]);
  return id;
}

export async function mkNode(ownerUserId: string, ip: string, ipClass: string | null = "residential"): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO nodes (owner_user_id, owner_wallet, node_key_hash, status, attestation_version, attestation_sig, observed_ip, ip_class)
     VALUES ($1, $2, $3, 'active', 1, $4, $5::inet, $6) RETURNING id`,
    [ownerUserId, `0x${hex(20)}`, hex(32), `0x${hex(65)}`, ip, ipClass],
  );
  return r.rows[0]!.id;
}

export interface ChargeOpts {
  requester: string; node: string; owner: string; bytes?: number; nodeMusd?: number; grossMusd?: number;
  zeroReason?: string | null; matured?: boolean; disputed?: boolean; daysAgo?: number; weightBps?: number | null; starterMusd?: number;
}

export async function mkCharge(o: ChargeOpts): Promise<string> {
  const gross = o.grossMusd ?? 5000;
  const nodeMusd = o.nodeMusd ?? Math.floor(gross / 4);
  const r = await query<{ id: string }>(
    `INSERT INTO relay_charges (requester_user_id, node_id, node_owner_user_id, payment_rail, bytes_gateway, price_per_gb_musd,
       gross_musd, node_musd, platform_musd, split_config_id, tier_id, node_share_bps, zero_reason, disputed, matures_at, matured,
       created_at, tier_weight_bps, starter_musd)
     VALUES ($1, $2, $3, 'wallet', $4, 500000, $5::bigint, $6::bigint, $5::bigint - $6::bigint, (SELECT MIN(id) FROM revenue_split_config), (SELECT MIN(id) FROM node_tiers), 2500,
       $7, $8, now(), $9, now() - make_interval(days => $10::int), $11, $12) RETURNING id`,
    [o.requester, o.node, o.owner, o.bytes ?? 10_000_000, gross, nodeMusd, o.zeroReason ?? null, o.disputed ?? false,
     o.matured ?? true, o.daysAgo ?? 0, o.weightBps === undefined ? 10000 : o.weightBps, o.starterMusd ?? 0],
  );
  return r.rows[0]!.id;
}

export async function mkTeam(ownerId: string, members: string[]): Promise<string> {
  const t = await query<{ id: string }>(`INSERT INTO teams (name, owner_id) VALUES ('t', $1) RETURNING id`, [ownerId]);
  const id = t.rows[0]!.id;
  for (const m of [ownerId, ...members]) await query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`, [id, m]);
  return id;
}
