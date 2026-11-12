import { describe, it, expect } from "vitest";
import { buildProxyUsername } from "../src/proxy-fetch.js";
import { ValidationError } from "../src/errors.js";
import { connected } from "./helpers.js";

describe("2.1 additions", () => {
  it("class-masked username flag", () => {
    expect(buildProxyUsername({ ipClass: "masked" })).toBe("class-masked");
    expect(buildProxyUsername({ country: "us", ipClass: "masked", sessionId: "s1" })).toBe("country-US-class-masked-session-s1");
  });

  it("nodes.iterate follows nextCursor and exposes class fields", async () => {
    const n1 = { id: "a", verifiedClass: "masked", declaredClass: "residential", classVerifiedAt: "t", tierWeight: 0.25 };
    const { client, calls } = await connected(
      [200, { nodes: [n1], limit: 1, offset: 0, nextCursor: "abc=" }],
      [200, { nodes: [{ id: "b" }], limit: 1, offset: 0, nextCursor: null }],
    );
    const out = [];
    for await (const n of client.nodes.iterate({ limit: 1 })) out.push(n);
    expect(out.map((n) => n.id)).toEqual(["a", "b"]);
    expect(out[0].tierWeight).toBe(0.25);
    expect(calls[1].url).toContain("cursor=abc%3D");
    await expect(client.nodes.list({ cursor: "bad cursor" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("payouts.iterate follows nextCursor", async () => {
    const { client, calls } = await connected(
      [200, { payouts: [{ id: "1" }], limit: 50, offset: 0, nextCursor: "MjAy" }],
      [200, { payouts: [], limit: 50, offset: 0, nextCursor: null }],
    );
    const out = [];
    for await (const p of client.payouts.iterate()) out.push(p);
    expect(out).toHaveLength(1);
    expect(calls[1].url).toContain("cursor=MjAy");
  });

  it("tier exposes tierWeights", async () => {
    const { client } = await connected([200, { tier: {}, nextTier: null, progress: null, tierWeights: { masked: 0.25 } }]);
    expect((await client.nodes.tier()).tierWeights?.masked).toBe(0.25);
  });

  it("register rejects an unknown declaredClass before any request", async () => {
    const { client, calls } = await connected();
    const signer = { address: "0x" + "1".repeat(40), signMessage: async () => "0x" };
    await expect(client.nodes.register({ signer, declaredClass: "isp" as "dc" })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });
});
