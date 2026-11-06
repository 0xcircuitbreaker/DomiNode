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
const ERC20_ABI = ["function transfer(address to, uint256 amount) returns (bool)"];
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
  let wallet: Wallet | null = new Wallet(readSignerKeyFile(env["PAYOUT_SIGNER_KEY_FILE"]), provider);
  const sent = new Map<string, string>(); // payoutId -> txHash (in-process idempotency)
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
      const txHash = Transaction.from(signed).hash!;
      if (sent.size >= MAX_SENT_CACHE) sent.delete(sent.keys().next().value as string);
      sent.set(req.payoutId, txHash);
      try {
        await provider.broadcastTransaction(signed);
      } catch {
        throw new PayoutBroadcastUncertainError(txHash, "broadcast outcome unknown");
      }
      return { txHash };
    },
    async waitForReceipt(txHash: string): Promise<ReceiptStatus> {
      const r = await provider.waitForTransaction(txHash, 1, timeout).catch(() => null);
      if (!r) return "pending";
      return r.status === 1 ? "confirmed" : "reverted";
    },
  };
}
