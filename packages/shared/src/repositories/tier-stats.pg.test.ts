import { describe, it, expect, afterAll } from "vitest";
import { PG_TEST_URL, mkUser, mkNode, mkCharge, mkTeam } from "./pg-fixtures.test.helpers.js";
import { query, closePool } from "../db.js";
import { getOwnerTierStats } from "./tier-repo.js";

// Opt-in: runs only against a scratch database (see pg-fixtures.test.helpers.ts).
describe.skipIf(!PG_TEST_URL)("getOwnerTierStats against PostgreSQL", () => {
  afterAll(async () => { await closePool(); });
  let ipSeq = 1 + Math.floor(Math.random() * 200);
  const ip = () => `10.${Math.floor(ipSeq / 250) % 250}.${ipSeq % 250}.${(ipSeq++ % 200) + 1}`;

  it("counts an IP as active only with 3 distinct earning, unlinked payers", async () => {
    const owner = await mkUser();
    const node = await mkNode(owner, ip());
    const [a, b, c] = [await mkUser(), await mkUser(), await mkUser()];
    await mkCharge({ requester: a, node, owner });
    await mkCharge({ requester: b, node, owner });
    // Zeroed at settle (self-dealing): earns nothing, so it must not count.
    await mkCharge({ requester: c, node, owner, nodeMusd: 0, zeroReason: "self_dealing" });
    expect((await getOwnerTierStats(owner, 0)).activeIps).toBe(0);
    await mkCharge({ requester: c, node, owner });
    expect((await getOwnerTierStats(owner, 0)).activeIps).toBe(1);
  });

  it("ignores payers that share a team with the owner", async () => {
    const owner = await mkUser();
    const node = await mkNode(owner, ip());
    const [a, b, c] = [await mkUser(), await mkUser(), await mkUser()];
    await mkTeam(owner, [c]);
    for (const r of [a, b, c]) await mkCharge({ requester: r, node, owner });
    expect((await getOwnerTierStats(owner, 0)).activeIps).toBe(0);
  });

  it("caps residential snapshots by the node's current masked class (4 masked IPs = 1 active IP)", async () => {
    const owner = await mkUser();
    const payers = [await mkUser(), await mkUser(), await mkUser()];
    const nodes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const n = await mkNode(owner, ip());
      nodes.push(n);
      for (const r of payers) await mkCharge({ requester: r, node: n, owner, weightBps: 10000 });
    }
    expect((await getOwnerTierStats(owner, 0)).activeIps).toBe(4);
    await query(`UPDATE nodes SET ip_class = 'masked' WHERE id = ANY($1::uuid[])`, [nodes]);
    expect((await getOwnerTierStats(owner, 0)).activeIps).toBe(1); // 4 x 0.25
    await query(`UPDATE nodes SET ip_class = 'residential' WHERE id = $1`, [nodes[0]]);
    expect((await getOwnerTierStats(owner, 0)).activeIps).toBe(1); // 1.0 + 3 x 0.25 = 1.75
  });

  it("counts a tenure day only at >= 1,000,000 matured bytes from others", async () => {
    const owner = await mkUser();
    const node = await mkNode(owner, ip());
    const r = await mkUser();
    await mkCharge({ requester: r, node, owner, bytes: 999_999, daysAgo: 3 });
    await mkCharge({ requester: r, node, owner, bytes: 500_000, daysAgo: 2 });
    await mkCharge({ requester: await mkUser(), node, owner, bytes: 500_000, daysAgo: 2 });
    await mkCharge({ requester: r, node, owner, bytes: 5_000_000, daysAgo: 1, matured: false });
    await mkCharge({ requester: owner, node, owner, bytes: 5_000_000, daysAgo: 4 });
    expect((await getOwnerTierStats(owner, 0)).tenureDays).toBe(1);
  });
});
