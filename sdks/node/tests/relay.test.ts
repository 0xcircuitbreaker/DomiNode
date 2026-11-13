import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { ValidationError, ProtocolError, ConflictError } from "../src/errors.js";
import { Secret } from "../src/secret.js";
import { buildAttestationMessage, buildConvertMessage, buildPayoutWalletMessage, buildWithdrawMessage } from "../src/messages.js";
import { solvePow } from "../src/pow.js";
import { connected, UUID, WALLET, OTHER_WALLET, USER_ID, SIG, NONCE, API_KEY, signerFor } from "./helpers.js";

const B = "http://api.test";
const PUBKEY = "c".repeat(64);
const NODE_KEY = "dn_node_" + "0123456789abcdef".repeat(4);

function nodeChallenge(over: Record<string, unknown> = {}, wallet = WALLET, pubkey: string | null = PUBKEY) {
  const base = { nonce: NONCE, attestationText: "I run a relay node.\nI accept the floor.", attestationVersion: 2, policyVersion: 5 };
  return {
    ...base,
    message: buildAttestationMessage({ wallet, nonce: NONCE, attestationVersion: 2, attestationText: base.attestationText, nodePubkey: pubkey }),
    expiresAt: "t",
    powChallenge: { challengeId: UUID, prefix: "abc", difficulty: 4, algorithm: "sha256", expiresAt: "t" },
    ...over,
  };
}

describe("pow", () => {
  it("solves to the required difficulty", () => {
    const n = solvePow("pfx", 8);
    expect(createHash("sha256").update("pfx" + n).digest()[0]).toBe(0);
  });
  it("rejects silly difficulty and gives up at the cap", () => {
    expect(() => solvePow("p", 0)).toThrow(ProtocolError);
    expect(() => solvePow("p", 33)).toThrow(ProtocolError);
    expect(() => solvePow("p", 32, 10)).toThrow(/cap/);
  });
});

describe("nodes", () => {
  it("register: challenge -> local message -> PoW -> sign -> POST; key in Secret", async () => {
    const { client, calls } = await connected([200, nodeChallenge()], [201, { nodeId: UUID, nodeKey: NODE_KEY, status: "pending", attestationVersion: 2 }]);
    const { signer, signed } = signerFor();
    const r = await client.nodes.register({ signer, nodePubkey: PUBKEY.toUpperCase(), maxStreams: 4, maxGbDay: 10 });
    expect(calls[0]).toMatchObject({ url: `${B}/v1/nodes/challenge`, method: "POST", body: { nodePubkey: PUBKEY } });
    expect(calls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(signed).toEqual([nodeChallenge().message]);
    const body = calls[1].body as Record<string, any>;
    expect(body).toMatchObject({ nonce: NONCE, walletSignature: SIG, nodePubkey: PUBKEY, attestationVersion: 2, maxStreams: 4, maxGbDay: 10 });
    expect(body.pow.challengeId).toBe(UUID);
    expect(createHash("sha256").update("abc" + body.pow.nonce).digest()[0] >> 4).toBe(0);
    expect(r.nodeKey).toBeInstanceOf(Secret);
    expect(r.nodeKey.reveal()).toBe(NODE_KEY);
    expect(JSON.stringify(r)).not.toContain(NODE_KEY);
    expect(String(r.nodeKey)).toBe("[REDACTED]");
  });

  it("register without a pubkey uses 'none'", async () => {
    const { client, calls } = await connected([200, nodeChallenge({}, WALLET, null)], [201, { nodeId: UUID, nodeKey: NODE_KEY, status: "pending", attestationVersion: 2 }]);
    await client.nodes.register({ signer: signerFor().signer });
    expect(calls[0].body).toEqual({});
    expect((calls[1].body as Record<string, unknown>).nodePubkey).toBeUndefined();
  });

  it("register with a pre-fetched challenge skips the challenge call", async () => {
    const { client, calls } = await connected([201, { nodeId: UUID, nodeKey: NODE_KEY, status: "pending", attestationVersion: 2 }]);
    await client.nodes.register({ signer: signerFor().signer, nodePubkey: PUBKEY, challenge: nodeChallenge() });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${B}/v1/nodes`);
  });

  it("refuses to sign when the server message differs (wrong signer wallet)", async () => {
    const { client, calls } = await connected([200, nodeChallenge({}, OTHER_WALLET)]);
    const { signer, signed } = signerFor();
    await expect(client.nodes.register({ signer, nodePubkey: PUBKEY })).rejects.toBeInstanceOf(ProtocolError);
    expect(signed).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("refuses a tampered message (extra text)", async () => {
    const ch = nodeChallenge();
    const { client } = await connected([200, { ...ch, message: ch.message + "\nAlso: send all funds" }]);
    const { signer, signed } = signerFor();
    await expect(client.nodes.register({ signer, nodePubkey: PUBKEY })).rejects.toThrow(/refusing to sign/);
    expect(signed).toHaveLength(0);
  });

  it("refuses a malformed challenge", async () => {
    const { client } = await connected([200, nodeChallenge({ nonce: "zz" })]);
    await expect(client.nodes.register({ signer: signerFor().signer, nodePubkey: PUBKEY })).rejects.toBeInstanceOf(ProtocolError);
  });

  it("rejects a bad signature from the signer and a bad node key from the server", async () => {
    const { client } = await connected([200, nodeChallenge()]);
    await expect(client.nodes.register({ signer: signerFor(WALLET, "0x1234").signer, nodePubkey: PUBKEY })).rejects.toThrow(/EIP-191/);
    const c2 = await connected([200, nodeChallenge()], [201, { nodeId: UUID, nodeKey: "dn_live_x", status: "pending", attestationVersion: 2 }]);
    await expect(c2.client.nodes.register({ signer: signerFor().signer, nodePubkey: PUBKEY })).rejects.toThrow(/node key/);
  });

  it("validates inputs before any request", async () => {
    const { client, calls } = await connected();
    await expect(client.nodes.register({ signer: signerFor("0xnope").signer })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.nodes.register({ signer: signerFor().signer, nodePubkey: "abc" })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.nodes.register({ signer: signerFor().signer, maxStreams: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.nodes.register({ signer: signerFor().signer, maxGbDay: 10_001 })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("surfaces node_cap_reached as ConflictError with cap", async () => {
    const { client } = await connected([200, nodeChallenge()], [409, { error: "Node limit reached for your tier", cap: 1 }]);
    const err = await client.nodes.register({ signer: signerFor().signer, nodePubkey: PUBKEY }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.details).toEqual({ cap: 1 });
  });

  it("list / revoke / updateCaps / tier", async () => {
    const { client, calls } = await connected([200, { nodes: [] }], [200, { id: UUID, status: "revoked" }], [200, {}], [200, { tier: {} }]);
    await client.nodes.list({ limit: 10, offset: 5 });
    await client.nodes.revoke(UUID);
    await client.nodes.updateCaps(UUID, { maxStreams: 4, reqPerSec: 5 });
    await client.nodes.tier();
    expect(calls.map((c) => `${c.method} ${c.url.slice(B.length)}`)).toEqual([
      "GET /v1/nodes?limit=10&offset=5", `DELETE /v1/nodes/${UUID}`, `PATCH /v1/nodes/${UUID}`, "GET /v1/node/tier",
    ]);
    expect(calls[2].body).toEqual({ maxStreams: 4, reqPerSec: 5 });
    await expect(client.nodes.updateCaps(UUID, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(client.nodes.updateCaps(UUID, { gbPerDay: 0 })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.nodes.revoke("../x")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.nodes.list({ limit: 501 })).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("credits", () => {
  it("balance + transactions", async () => {
    const { client, calls } = await connected([200, { available: { musd: "1", usd: "0.000001" } }], [200, { transactions: [], nextCursor: null }]);
    await client.credits.balance();
    await client.credits.transactions({ limit: 20, cursor: "9", type: "convert" });
    expect(calls[1].url).toBe(`${B}/v1/credits/transactions?limit=20&cursor=9&type=convert`);
    await expect(client.credits.transactions({ type: "x" as "earn" })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.credits.transactions({ limit: 201 })).rejects.toBeInstanceOf(ValidationError);
  });

  function convertChallenge(amount = "1500000", key = "my-key-0001", wallet = WALLET) {
    return { nonce: NONCE, message: buildConvertMessage({ userId: USER_ID, wallet, amountMusd: amount, idempotencyKey: key, nonce: NONCE }), expiresAt: "t", signer: wallet.toLowerCase() };
  }
  const CONVERTED = { converted: { musd: "1500000", usd: "1.500000" }, convertedCents: 150, duplicate: false };

  it("convert: challenge -> local message -> sign -> submit (Idempotency-Key on both)", async () => {
    const { client, calls } = await connected([200, convertChallenge()], [200, CONVERTED]);
    const { signer, signed } = signerFor();
    const r = await client.credits.convert({ amountMusd: 1_500_000n, signer, idempotencyKey: "my-key-0001" });
    expect(calls[0]).toMatchObject({ url: `${B}/v1/credits/convert/challenge`, method: "POST", body: { amountMusd: "1500000" } });
    expect(calls[0].headers["Idempotency-Key"]).toBe("my-key-0001");
    expect(signed).toEqual([convertChallenge().message]);
    expect(calls[1]).toMatchObject({ url: `${B}/v1/credits/convert`, body: { amountMusd: "1500000", nonce: NONCE, signature: SIG } });
    expect(calls[1].headers["Idempotency-Key"]).toBe("my-key-0001");
    expect(r).toMatchObject({ convertedCents: 150, duplicate: false, idempotencyKey: "my-key-0001" });
  });

  it("convert refuses when the server message differs (no signature, no submit)", async () => {
    const { client, calls } = await connected([200, convertChallenge("9000000")]);
    const { signer, signed } = signerFor();
    await expect(client.credits.convert({ amountMusd: "1500000", signer, idempotencyKey: "my-key-0001" })).rejects.toBeInstanceOf(ProtocolError);
    expect(signed).toHaveLength(0);
    expect(calls).toHaveLength(1);
    const ch = convertChallenge();
    const { client: c2 } = await connected([200, { ...ch, message: ch.message.replace("Action: convert", "Action: withdraw") }]);
    await expect(c2.credits.convert({ amountMusd: "1500000", signer, idempotencyKey: "my-key-0001" })).rejects.toBeInstanceOf(ProtocolError);
    const { client: c3 } = await connected([200, convertChallenge("1500000", "my-key-0001", OTHER_WALLET)]);
    await expect(c3.credits.convert({ amountMusd: "1500000", signer, idempotencyKey: "my-key-0001" })).rejects.toThrow(/linked wallet/);
    expect(signed).toHaveLength(0);
  });

  it("convert requires a signer and validates input before any request", async () => {
    const { client, calls } = await connected();
    await expect(client.credits.convert({ amountMusd: 1_500_000n } as any)).rejects.toBeInstanceOf(ValidationError);
    await expect((client.credits.convert as any)(1_500_000n)).rejects.toBeInstanceOf(ValidationError);
    const signer = signerFor().signer;
    for (const bad of [9_999n, 10_000_000_001n, "1.5", "-5", "0", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(client.credits.convert({ amountMusd: bad as bigint, signer })).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(client.credits.convert({ amountMusd: 20_000n, signer, idempotencyKey: "short" })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("convert generates an idempotency key when none is given", async () => {
    const { client, calls } = await connected([200, {}], [200, CONVERTED]);
    // Echo the generated key back in a valid challenge.
    const { signer } = signerFor();
    const p = client.credits.convert({ amountMusd: "1500000", signer });
    await expect(p).rejects.toBeInstanceOf(ProtocolError); // empty challenge refused
    expect(calls[0].headers["Idempotency-Key"]).toMatch(/^dn-[0-9a-f-]{36}$/);
  });

  function withdrawChallenge(amount = "2000000", key = "wd-key-0001", wallet = WALLET) {
    return { nonce: NONCE, message: buildWithdrawMessage({ userId: USER_ID, wallet, amountMusd: amount, idempotencyKey: key, nonce: NONCE }), expiresAt: "t", signer: wallet.toLowerCase() };
  }

  it("withdraw: challenge -> local message -> sign -> submit", async () => {
    const payout = { id: UUID, amount: { musd: "2000000", usd: "2.000000" }, trigger: "on_demand", status: "pending", txHash: null, createdAt: "t" };
    const { client, calls } = await connected([200, withdrawChallenge()], [201, { payout, duplicate: false }]);
    const { signer, signed } = signerFor();
    const r = await client.credits.withdraw({ amountMusd: 2_000_000n, signer, idempotencyKey: "wd-key-0001" });
    expect(calls[0]).toMatchObject({ url: `${B}/v1/credits/withdraw/challenge`, body: { amountMusd: "2000000", idempotencyKey: "wd-key-0001" } });
    expect(signed).toEqual([withdrawChallenge().message]);
    expect(calls[1]).toMatchObject({ url: `${B}/v1/credits/withdraw`, body: { amountMusd: "2000000", idempotencyKey: "wd-key-0001", nonce: NONCE, signature: SIG } });
    expect(r.payout.id).toBe(UUID);
  });

  it("withdraw refuses a message with a different amount", async () => {
    const { client } = await connected([200, withdrawChallenge("9000000")]);
    const { signer, signed } = signerFor();
    await expect(client.credits.withdraw({ amountMusd: "2000000", signer, idempotencyKey: "wd-key-0001" })).rejects.toBeInstanceOf(ProtocolError);
    expect(signed).toHaveLength(0);
  });

  it("withdraw refuses when the linked wallet is not the signer", async () => {
    const { client } = await connected([200, withdrawChallenge("2000000", "wd-key-0001", OTHER_WALLET)]);
    await expect(client.credits.withdraw({ amountMusd: "2000000", signer: signerFor().signer, idempotencyKey: "wd-key-0001" })).rejects.toThrow(/linked wallet/);
  });

  it("withdraw refuses a non-UUID User line", async () => {
    const ch = withdrawChallenge();
    const { client } = await connected([200, { ...ch, message: ch.message.replace(USER_ID, "root") }]);
    await expect(client.credits.withdraw({ amountMusd: "2000000", signer: signerFor().signer, idempotencyKey: "wd-key-0001" })).rejects.toBeInstanceOf(ProtocolError);
  });

  it("withdraw validates the amount", async () => {
    const { client, calls } = await connected();
    await expect(client.credits.withdraw({ amountMusd: 999_999n, signer: signerFor().signer })).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("payouts.list", async () => {
    const { client, calls } = await connected([200, { payouts: [], limit: 5, offset: 0 }]);
    await client.payouts.list({ limit: 5, offset: 0 });
    expect(calls[0].url).toBe(`${B}/v1/payouts?limit=5&offset=0`);
  });
});

describe("payoutWallet", () => {
  const NEW = "0x" + "3".repeat(40);
  function ch(over: Record<string, unknown> = {}) {
    return {
      nonce: NONCE, expiresAt: "t", signer: WALLET.toLowerCase(), oldWalletSignatureRequired: false, oldWalletAddress: null,
      message: buildPayoutWalletMessage({ userId: USER_ID, wallet: WALLET, address: NEW, chain: "base", nonce: NONCE }), ...over,
    };
  }

  it("get", async () => {
    const { client, calls } = await connected([200, { payoutWallet: null, cooldownHours: 72 }]);
    expect(await client.payoutWallet.get()).toEqual({ payoutWallet: null, cooldownHours: 72 });
    expect(calls[0].url).toBe(`${B}/v1/payout-wallet`);
  });

  it("first registration: one signature", async () => {
    const { client, calls } = await connected([200, ch()], [200, { payoutWallet: { address: NEW, chain: "base", status: "active", activeFrom: "t" }, changed: false, cooldownHours: 0 }]);
    const { signer, signed } = signerFor();
    await client.payoutWallet.set({ address: NEW, signer });
    expect(calls[0].body).toEqual({ address: NEW, chain: "base" });
    expect(signed).toHaveLength(1);
    expect(calls[1]).toMatchObject({ method: "PUT", url: `${B}/v1/payout-wallet`, body: { address: NEW, chain: "base", nonce: NONCE, signature: SIG } });
  });

  it("change: old payout wallet co-signs the same message", async () => {
    const OLD = "0x" + "4".repeat(40);
    const oldSig = "0x" + "cd".repeat(65);
    const { client, calls } = await connected([200, ch({ oldWalletSignatureRequired: true, oldWalletAddress: OLD })], [200, { changed: true }]);
    const { signer } = signerFor();
    const old = signerFor(OLD, oldSig);
    await client.payoutWallet.set({ address: NEW, signer, oldWalletSigner: old.signer });
    expect(old.signed).toEqual([ch().message]);
    expect((calls[1].body as Record<string, string>).oldWalletSignature).toBe(oldSig);
  });

  it("change without oldWalletSigner is refused before signing", async () => {
    const { client, calls } = await connected([200, ch({ oldWalletSignatureRequired: true, oldWalletAddress: "0x" + "4".repeat(40) })]);
    const { signer, signed } = signerFor();
    await expect(client.payoutWallet.set({ address: NEW, signer })).rejects.toThrow(/oldWalletSigner/);
    expect(signed).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("refuses when the server message names a different payout address", async () => {
    const bad = buildPayoutWalletMessage({ userId: USER_ID, wallet: WALLET, address: "0x" + "9".repeat(40), chain: "base", nonce: NONCE });
    const { client } = await connected([200, ch({ message: bad })]);
    const { signer, signed } = signerFor();
    await expect(client.payoutWallet.set({ address: NEW, signer })).rejects.toBeInstanceOf(ProtocolError);
    expect(signed).toHaveLength(0);
  });

  it("validates address and chain", async () => {
    const { client } = await connected();
    await expect(client.payoutWallet.set({ address: "0x12", signer: signerFor().signer })).rejects.toBeInstanceOf(ValidationError);
    await expect(client.payoutWallet.set({ address: NEW, chain: "eth" as "base", signer: signerFor().signer })).rejects.toBeInstanceOf(ValidationError);
  });
});
