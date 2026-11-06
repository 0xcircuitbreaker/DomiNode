// Regenerate: npx esbuild sdks/go/testdata/gen-messages.ts --bundle --platform=node | node > sdks/go/testdata/messages.json
import { buildAttestationMessage, buildPayoutWalletMessage, buildWithdrawMessage } from "../../node/src/messages.ts";
const out: any = {
  attestation: [
    { in: { wallet: "0xAbCdEf0123456789abcdef0123456789ABCDEF01", nonce: "a".repeat(64), attestationVersion: 3, attestationText: "I agree.\nLine two — ünïcode.", nodePubkey: "0f".repeat(32) } },
    { in: { wallet: "0x1111111111111111111111111111111111111111", nonce: "0123456789abcdef".repeat(4), attestationVersion: 1, attestationText: "x", nodePubkey: null } },
  ],
  payoutWallet: [
    { in: { userId: "123e4567-e89b-42d3-a456-426614174000", wallet: "0xAbCdEf0123456789abcdef0123456789ABCDEF01", address: "0x2222222222222222222222222222222222222AbC", chain: "base", nonce: "b".repeat(64) } },
  ],
  withdraw: [
    { in: { userId: "123e4567-e89b-42d3-a456-426614174000", wallet: "0xAbCdEf0123456789abcdef0123456789ABCDEF01", amountMusd: "2500000", idempotencyKey: "dn-key_12345678", nonce: "c".repeat(64) } },
  ],
};
for (const x of out.attestation) x.out = buildAttestationMessage(x.in);
for (const x of out.payoutWallet) x.out = buildPayoutWalletMessage(x.in);
for (const x of out.withdraw) x.out = buildWithdrawMessage(x.in);
console.log(JSON.stringify(out, null, 2));
