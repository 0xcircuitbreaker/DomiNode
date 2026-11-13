import { describe, it, expect, vi } from "vitest";

const clientQuery = vi.fn();
vi.mock("../db.js", () => ({
  query: vi.fn(),
  queryOn: vi.fn(),
  getPool: () => ({ connect: async () => ({ query: clientQuery, release: vi.fn() }) }),
}));

import { createReferralCode } from "./referral-repo.js";

describe("createReferralCode", () => {
  it("accepts creditCents 0 (the route always creates 0-credit codes)", async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("COUNT(*)")) return { rows: [{ cnt: "0" }] };
      if (sql.includes("INSERT")) return { rows: [{ id: "c1", credit_cents: 0 }] };
      return { rows: [] };
    });
    const code = await createReferralCode("u1", "a".repeat(64), "ABCD", { creditCents: 0 });
    expect(code.credit_cents).toBe(0);
    const insert = clientQuery.mock.calls.find((c) => String(c[0]).includes("INSERT"))!;
    expect((insert[1] as unknown[])[4]).toBe(0);
  });

  it("still rejects negative creditCents", async () => {
    await expect(createReferralCode("u1", "a".repeat(64), "ABCD", { creditCents: -1 })).rejects.toThrow(/between 0/);
  });
});
