import crypto from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser, mkNode, mkCharge } from "./pg-fixtures.test.helpers.js";
import { query, closePool } from "../db.js";
import { takeSnapshot, listSnapshots, addUnmetDemand, NODE_ONLINE_SQL } from "./network-status-repo.js";
import { revokeApiKey } from "./user-repo.js";
import { storeToken, findTokenByHash, hashToken, newFamilyId } from "./refresh-token-repo.js";
import { recordVerifiedClass, getNodeForTunnelAuth } from "./node-repo.js";
import { heartbeatSessions } from "./session-recovery-repo.js";

const hex = (n: number) => crypto.randomBytes(n).toString("hex");

// Opt-in: runs only against a scratch database (see pg-fixtures.test.helpers.ts).
describe.skipIf(!PG_TEST_URL)("pre-launch gateway fixes (PostgreSQL)", () => {
  afterAll(async () => { await closePool(); });

  it("public stats: online = fresh slot heartbeat; one owner with three paid nodes is suppressed", async () => {
    await query(`DELETE FROM node_ip_slots`);
    await query(`UPDATE nodes SET status = 'cooldown' WHERE status = 'active'`);
    const owner = await mkUser();
    const req = await mkUser();
    const nodes: string[] = [];
    for (let i = 0; i < 3; i++) {
      const n = await mkNode(owner, `203.0.113.${10 + i}`);
      nodes.push(n);
      // last_seen_at an hour old: liveness comes from the slot heartbeat only.
      await query(`UPDATE nodes SET last_seen_at = now() - interval '1 hour' WHERE id = $1`, [n]);
      await query(`INSERT INTO node_ip_slots (node_id, instance_id, ip, prefix24) VALUES ($1, 'gw', $2::inet, 'p')`, [n, `203.0.113.${10 + i}`]);
      await mkCharge({ requester: req, node: n, owner, bytes: 2_000_000_000 });
    }
    const online = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM nodes n WHERE n.status = 'active' AND ${NODE_ONLINE_SQL}`);
    expect(online.rows[0]!.c).toBe("3");
    await takeSnapshot({ p50Ms: null, p95Ms: null });
    const row = await query<{ community_online: number; community_owners_online: number; community_paid_owners_24h: number; community_paid_nodes_24h: number }>(
      `SELECT community_online, community_owners_online, community_paid_owners_24h, community_paid_nodes_24h FROM network_stats_snapshots WHERE hour = date_trunc('hour', now())`);
    // Online figures only (other opt-in tests add paid charges to the same scratch DB).
    expect(row.rows[0]).toMatchObject({ community_online: 3, community_owners_online: 1 });
    const pub = (await listSnapshots(1)).at(-1)!;
    expect(pub.communityPaidBytes24h).toBe("0");
    expect(pub.communityOnline).toBe(0);
    await query(`DELETE FROM node_ip_slots WHERE node_id = ANY($1::uuid[])`, [nodes]);
  });

  it("revoking an API key revokes the refresh families minted from it", async () => {
    const u = await mkUser();
    const k = (await query<{ id: string }>(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES ($1, $2, 'dn_live_', 't') RETURNING id`, [u, hex(32)])).rows[0]!.id;
    const tok = hex(16);
    await storeToken(u, hashToken(tok), newFamilyId(), new Date(Date.now() + 3_600_000), null, k);
    expect(await findTokenByHash(hashToken(tok))).toMatchObject({ api_key_id: k, api_key_revoked: false, revoked: false });
    expect(await revokeApiKey(k, u)).toBe(true);
    expect(await findTokenByHash(hashToken(tok))).toMatchObject({ api_key_revoked: true, revoked: true });
  });

  it("an egress country block persists across reconnects until a matching probe clears it", async () => {
    const n = await mkNode(await mkUser(), "198.51.100.77");
    const keyHash = (await query<{ h: string }>(`SELECT node_key_hash AS h FROM nodes WHERE id = $1`, [n])).rows[0]!.h;
    await recordVerifiedClass(n, "masked", { probeClass: "masked", connectClass: "residential", egressBlocked: true, forceFlag: true });
    expect((await getNodeForTunnelAuth(keyHash))?.egress_blocked).toBe(true);
    await recordVerifiedClass(n, "masked", { probeClass: "masked" });
    expect((await getNodeForTunnelAuth(keyHash))?.egress_blocked).toBe(true);
    await recordVerifiedClass(n, "masked", { probeClass: "masked", egressBlocked: false });
    expect((await getNodeForTunnelAuth(keyHash))?.egress_blocked).toBe(false);
  });

  it("heartbeatSessions returns only the sessions still active for this instance", async () => {
    const u = await mkUser();
    const mk = async () => (await query<{ id: string }>(`INSERT INTO sessions (user_id, gateway_instance) VALUES ($1, 'gw-a') RETURNING id`, [u])).rows[0]!.id;
    const live = await mk();
    const settled = await mk();
    await query(`UPDATE sessions SET status = 'ended' WHERE id = $1`, [settled]).catch(async () => {
      await query(`UPDATE sessions SET status = 'error' WHERE id = $1`, [settled]);
    });
    const ids = await heartbeatSessions("gw-a", [{ sessionId: live, bytesIn: 1, bytesOut: 1 }, { sessionId: settled, bytesIn: 1, bytesOut: 1 }]);
    expect(ids).toEqual([live]);
  });

  it("class-masked unmet demand is written", async () => {
    const hour = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
    expect(await addUnmetDemand([{ hour, country: "NL", ipClass: "masked", requests: 2 }])).toBe(1);
    const r = await query<{ requests: number }>(`SELECT requests FROM unmet_demand_hourly WHERE hour = $1 AND country = 'NL' AND ip_class = 'masked'`, [hour]);
    expect(r.rows[0]!.requests).toBeGreaterThanOrEqual(2);
  });
});
