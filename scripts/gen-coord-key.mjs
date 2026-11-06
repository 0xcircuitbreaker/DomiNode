#!/usr/bin/env node
// Generate the DominusNode coordinator CHALLENGE signing key (ed25519, PKCS8 PEM).
// Cross-platform (macOS, Linux, Windows): needs only Node.js, no openssl.
// The private key is written with mode 0600 and never printed. Only the raw
// 32-byte public key is printed, as 64 hex chars (for DN_COORD_PUBKEYS).
//
// Usage: node scripts/gen-coord-key.mjs <output.pem>
//    or: npm run gen:coord-key -- <output.pem>
// See docs/agent-network/DEPLOYMENT.md for embedding and rotation.
import { generateKeyPairSync } from "node:crypto";
import { openSync, writeSync, closeSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: node scripts/gen-coord-key.mjs <output.pem>");
  process.exit(2);
}
const path = resolve(out);
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const spki = publicKey.export({ type: "spki", format: "der" });
const pubHex = Buffer.from(spki.subarray(spki.length - 32)).toString("hex");
if (!/^[0-9a-f]{64}$/.test(pubHex)) {
  console.error("gen-coord-key: failed to derive public key");
  process.exit(1);
}

let fd;
try {
  fd = openSync(path, "wx", 0o600); // refuse to overwrite an existing key
} catch (err) {
  if (err && err.code === "EEXIST") {
    console.error(`gen-coord-key: ${path} already exists; refusing to overwrite`);
    process.exit(1);
  }
  throw err;
}
try {
  writeSync(fd, pem);
} finally {
  closeSync(fd);
}
try {
  chmodSync(path, 0o600);
} catch {
  // Windows: POSIX modes are not enforced; protect the file with NTFS ACLs.
}

console.error(`private key written to ${path} (keep it secret; back it up offline)`);
console.log(pubHex);
