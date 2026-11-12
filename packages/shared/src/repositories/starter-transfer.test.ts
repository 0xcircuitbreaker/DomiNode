import { describe, it, expect, vi, beforeEach } from "vitest";
import { routedClient, type Route } from "./relay-net-test-helpers.js";

const mockConnect = vi.fn();
vi.mock("../db.js", () => ({ query: vi.fn(), getPool: () => ({ connect: () => mockConnect() }) }));
import { fundTeamWallet } from "./team-repo.js";
import { fundWallet } from "./agentic-wallet-repo.js";

const TEAM = "11111111-1111-1111-1111-111111111111";
const AW = "22222222-2222-2222-2222-222222222222";

function setup(balance: number, starterRemainingMusd: string | null) {
  const routes: Route[] = [
    [/FROM starter_credit_grants/, () => ({ rows: starterRemainingMusd ? [{ remaining_musd: starterRemainingMusd }] : [] })],
    [/FROM team_members/, () => ({ rows: [{ role: "owner" }] })],
    [/FROM wallets WHERE user_id/, () => ({ rows: [{ id: "w1", balance_cents: balance }] })],
    [/FROM team_wallets/, () => ({ rows: [{ id: "tw1", balance_cents: 0 }] })],
    [/FROM agentic_wallets/, () => ({ rows: [{ id: AW, user_id: "u1", balance_cents: 0, status: "active" }] })],
    [/INSERT INTO team_wallet_transactions|INSERT INTO agentic_wallet_transactions/, () => ({ rows: [{ id: "t1" }] })],
  ];
  const r = routedClient(routes);
  mockConnect.mockResolvedValue(r.client);
  return r;
}
const debited = (r: ReturnType<typeof setup>) =>
  r.sqls().some((s) => /UPDATE wallets SET balance_cents = balance_cents -/.test(s));

describe("starter credit is non-transferable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fundTeamWallet refuses moving unspent starter credit to a team", async () => {
    const r = setup(50, "500000"); // 50 cents, all starter
    await expect(fundTeamWallet("u1", TEAM, 50)).rejects.toThrow(/starter credit/);
    expect(debited(r)).toBe(false);
  });

  it("fundWallet refuses moving unspent starter credit to an agentic wallet", async () => {
    const r = setup(50, "500000");
    await expect(fundWallet("u1", AW, 50)).rejects.toThrow(/starter credit/);
    expect(debited(r)).toBe(false);
  });

  it("a sub-cent starter remainder still holds back a whole cent", async () => {
    setup(100, "1");
    await expect(fundTeamWallet("u1", TEAM, 100)).rejects.toThrow(/starter credit/);
  });

  it("paid balance above the starter remainder can still be moved", async () => {
    const r = setup(150, "500000");
    await fundTeamWallet("u1", TEAM, 100);
    expect(debited(r)).toBe(true);
    const r2 = setup(150, "500000");
    await fundWallet("u1", AW, 100);
    expect(debited(r2)).toBe(true);
  });

  it("no active grant: full balance is transferable", async () => {
    const r = setup(50, null);
    await fundTeamWallet("u1", TEAM, 50);
    expect(debited(r)).toBe(true);
  });
});
