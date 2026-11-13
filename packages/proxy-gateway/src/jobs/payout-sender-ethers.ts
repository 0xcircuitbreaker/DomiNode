import { readFileSync } from "node:fs";
import { Contract, JsonRpcProvider, Transaction, Wallet } from "ethers";
import { PayoutBroadcastUncertainError, PayoutNotBroadcastError, type PayoutChain, type PayoutSender, type ReceiptStatus, type SendRequest } from "./payouts.js";

/**
 * USDC-on-Base PayoutSender (ethers v6). The signer key is read from
 * PAYOUT_SIGNER_KEY_FILE; a key passed directly in env is never accepted.
 */

export const USDC_ADDRESSES: Record<PayoutChain, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
export const CHAIN_IDS: Record<PayoutChain, bigint> = { base: 8453n, "base-sepolia": 84532n };
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

/**
 * ethers v6 error codes for a broadcast the RPC node rejected before
 * accepting the transaction: nothing reached the mempool. Every other error
 * (timeouts, network/server errors) leaves the outcome unknown.
 */
const REJECTED_CODES: ReadonlySet<string> = new Set(["INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED"]);

/** Classify a broadcastTransaction error: definite rejection vs unknown outcome. */
export function classifyBroadcastError(err: unknown): "rejected" | "uncertain" {
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return typeof code === "string" && REJECTED_CODES.has(code) ? "rejected" : "uncertain";
}

export interface DroppedCheck {
  /** null: the node does not know the transaction. */
  getTransaction(hash: string): Promise<unknown | null>;
  /** The signer's confirmed ("latest") nonce. */
  confirmedNonce(): Promise<number>;
}

/**
 * A transaction is dropped when the node no longer knows it AND the signer's
 * confirmed nonce has moved past its nonce: that nonce slot was used by
 * another transaction, so this one can never be mined. Unknown nonce (e.g.
 * after a restart) is never treated as dropped.
 */
export async function isDropped(hash: string, nonce: number | undefined, c: DroppedCheck): Promise<boolean> {
  if (nonce === undefined) return false;
  if ((await c.getTransaction(hash)) !== null) return false;
  return (await c.confirmedNonce()) > nonce;
}
const MAX_SENT_CACHE = 10_000;

export function readSignerKeyFile(path: string | undefined): string {
  if (!path) throw new Error("PAYOUT_SIGNER_KEY_FILE is required");
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    throw new Error("PAYOUT_SIGNER_KEY_FILE unreadable");
  }
  const k = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error("PAYOUT_SIGNER_KEY_FILE does not contain a 32-byte hex key");
  return k;
}

export function createEthersPayoutSender(env: NodeJS.ProcessEnv, opts: { receiptTimeoutMs?: number } = {}): PayoutSender {
  if ("PAYOUT_SIGNER_KEY" in env) throw new Error("PAYOUT_SIGNER_KEY must not be set; use PAYOUT_SIGNER_KEY_FILE");
  const rpcUrl = env["PAYOUT_RPC_URL"];
  if (!rpcUrl || !/^https:\/\//.test(rpcUrl)) throw new Error("PAYOUT_RPC_URL must be an https:// URL");
  const provider = new JsonRpcProvider(rpcUrl);
  const wallet: Wallet = new Wallet(readSignerKeyFile(env["PAYOUT_SIGNER_KEY_FILE"]), provider);
  const sent = new Map<string, string>(); // payoutId -> txHash (in-process idempotency)
  const nonces = new Map<string, number>(); // txHash -> nonce (dropped-tx detection)
  const timeout = opts.receiptTimeoutMs ?? 120_000;

  return {
    async send(req: SendRequest): Promise<{ txHash: string }> {
      const prior = sent.get(req.payoutId);
      if (prior) return { txHash: prior };
      if (!wallet) throw new PayoutNotBroadcastError("sender closed");
      if (!/^0x[0-9a-f]{40}$/.test(req.to)) throw new PayoutNotBroadcastError("invalid destination");
      if (req.amountMusd <= 0n) throw new PayoutNotBroadcastError("invalid amount");
      let signed: string;
      try {
        const net = await provider.getNetwork();
        if (net.chainId !== CHAIN_IDS[req.chain]) throw new Error("RPC chain id does not match payout chain");
        const usdc = new Contract(USDC_ADDRESSES[req.chain], ERC20_ABI, wallet);
        // USDC has 6 decimals: 1 µUSD == 1 base unit.
        const tx = await usdc.getFunction("transfer").populateTransaction(req.to, req.amountMusd);
        const populated = await wallet.populateTransaction(tx);
        signed = await wallet.signTransaction(populated);
      } catch (err) {
        throw new PayoutNotBroadcastError(`pre-broadcast failure: ${err instanceof Error ? err.message.slice(0, 80) : "unknown"}`);
      }
      const parsed = Transaction.from(signed);
      const txHash = parsed.hash!;
      if (sent.size >= MAX_SENT_CACHE) sent.delete(sent.keys().next().value as string);
      sent.set(req.payoutId, txHash);
      if (nonces.size >= MAX_SENT_CACHE) nonces.delete(nonces.keys().next().value as string);
      nonces.set(txHash, parsed.nonce);
      try {
        await provider.broadcastTransaction(signed);
      } catch (err) {
        if (classifyBroadcastError(err) === "rejected") {
          // The node refused it outright: release so a later run re-signs.
          sent.delete(req.payoutId);
          nonces.delete(txHash);
          const code = String((err as { code?: unknown }).code);
          throw new PayoutNotBroadcastError(`broadcast rejected: ${code}`, true);
        }
        throw new PayoutBroadcastUncertainError(txHash, "broadcast outcome unknown");
      }
      return { txHash };
    },
    async waitForReceipt(txHash: string, timeoutMs?: number): Promise<ReceiptStatus> {
      const r = await provider.waitForTransaction(txHash, 1, timeoutMs ?? timeout).catch(() => null);
      if (r) return r.status === 1 ? "confirmed" : "reverted";
      const dropped = await isDropped(txHash, nonces.get(txHash), {
        getTransaction: (h) => provider.getTransaction(h),
        confirmedNonce: () => provider.getTransactionCount(wallet.address, "latest"),
      }).catch(() => false);
      return dropped ? "dropped" : "pending";
    },
    async preflight(chain: PayoutChain): Promise<{ gasOk: boolean; usdcMusd: bigint }> {
      const [eth, usdc] = await Promise.all([
        provider.getBalance(wallet.address),
        new Contract(USDC_ADDRESSES[chain], ERC20_ABI, provider).getFunction("balanceOf")(wallet.address) as Promise<bigint>,
      ]);
      return { gasOk: eth > 0n, usdcMusd: BigInt(usdc) };
    },
  };
}
