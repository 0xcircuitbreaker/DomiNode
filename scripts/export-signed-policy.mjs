#!/usr/bin/env node
// F6: export the network policy as a versioned, signed file (docs/agent-network/FEDERATION.md).
// Signs with the coordinator key (COORD_SIGNING_KEY_FILE, ed25519 PKCS8 PEM).
// The private key is never printed.
//
// Usage (after npm run build):
//   COORD_SIGNING_KEY_FILE=coord.pem node scripts/export-signed-policy.mjs [--policy body.json --version N] [--out policy.json]
// Without --policy the active policy is read from the database (DATABASE_URL).
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import * as shared from "../packages/shared/dist/src/index.js";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const keyPath = process.env.COORD_SIGNING_KEY_FILE;
if (!keyPath) {
  console.error("COORD_SIGNING_KEY_FILE is required");
  process.exit(2);
}
const key = shared.loadEd25519PrivateKey(readFileSync(keyPath, "utf8"));
const signer = shared.signerFromPrivateKey(key, shared.ed25519PublicKeyHex(createPublicKey(key)));

let version;
let body;
if (opt("policy")) {
  version = Number.parseInt(opt("version") ?? "", 10);
  if (!Number.isSafeInteger(version) || version < 1) {
    console.error("--version N (positive integer) is required with --policy");
    process.exit(2);
  }
  body = shared.validatePolicy(JSON.parse(readFileSync(opt("policy"), "utf8")));
} else {
  const active = await shared.policyRepo.getActivePolicy();
  version = active.version;
  body = active.body;
}

const doc = shared.signDocument(shared.POLICY_DOC_DOMAIN, shared.buildPolicyDocument(version, body), [signer]);
const out = JSON.stringify(doc, null, 2) + "\n";
if (opt("out")) writeFileSync(opt("out"), out);
else process.stdout.write(out);
console.error(`policy v${version} sha256 ${doc.payload.sha256} signed by ${shared.coordKeyFingerprint(signer.publicKeyHex)}`);
process.exit(0);
