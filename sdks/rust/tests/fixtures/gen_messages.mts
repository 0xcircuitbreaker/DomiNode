// Regenerate signed_messages.json from the Node reference SDK builders:
//   cd sdks/node && npx tsx ../rust/tests/fixtures/gen_messages.mts > ../rust/tests/fixtures/signed_messages.json
import { buildAttestationMessage, buildPayoutWalletMessage, buildWithdrawMessage } from "../../../node/src/messages.ts";

const W = "0xAbCdEf0123456789aBcDeF0123456789ABCDEF01";
const out = {
  wallet: W,
  attestation_none: buildAttestationMessage({ wallet: W, nonce: "f".repeat(64), attestationVersion: 3, attestationText: "line1\nline2 µ", nodePubkey: null }),
  attestation_key: buildAttestationMessage({ wallet: W, nonce: "0123456789abcdef".repeat(4), attestationVersion: 12, attestationText: "I agree.\n\nTrailing", nodePubkey: "ab".repeat(32) }),
  payout: buildPayoutWalletMessage({ userId: "11111111-2222-4333-8444-555555555555", wallet: W, address: "0x2222222222222222222222222222222222222AAA", chain: "base", nonce: "e".repeat(64) }),
  withdraw: buildWithdrawMessage({ userId: "11111111-2222-4333-8444-555555555555", wallet: W, amountMusd: "1234567", idempotencyKey: "dn-key_ABC-123", nonce: "d".repeat(64) }),
};
console.log(JSON.stringify(out, null, 2));
