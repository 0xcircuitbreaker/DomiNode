/**
 * Coordinator CHALLENGE signing key (DESIGN.md §2.4, commit 20).
 * COORD_SIGNING_KEY_FILE points at a PEM (pkcs8) ed25519 private key file.
 * In production a missing/unreadable/non-ed25519 key refuses startup; outside
 * production the gateway runs unsigned (nodes with pins will refuse it).
 */
import { readFileSync, statSync } from "node:fs";
import { loadEd25519PrivateKey, signEd25519, ed25519PublicKeyHex } from "@dominusnode/shared";
import { createPublicKey } from "node:crypto";

const MAX_KEY_FILE_BYTES = 16 * 1024;

export interface CoordSigner {
  sign: (msg: Buffer) => string;
  publicKeyHex: string;
}

export function loadCoordSigner(env: NodeJS.ProcessEnv, read: (p: string) => string = (p) => {
  const st = statSync(p);
  if (!st.isFile() || st.size > MAX_KEY_FILE_BYTES) throw new Error("not a regular key file");
  return readFileSync(p, "utf8");
}): CoordSigner | null {
  const production = env["NODE_ENV"] === "production";
  const path = (env["COORD_SIGNING_KEY_FILE"] ?? "").trim();
  if (!path) {
    if (production) throw new Error("COORD_SIGNING_KEY_FILE is required in production");
    return null;
  }
  let pem: string;
  try {
    pem = read(path);
  } catch {
    throw new Error("COORD_SIGNING_KEY_FILE could not be read");
  }
  let key;
  try {
    key = loadEd25519PrivateKey(pem);
  } catch {
    throw new Error("COORD_SIGNING_KEY_FILE is not a valid ed25519 PEM key");
  } finally {
    pem = "";
  }
  return { sign: (msg) => signEd25519(key, msg), publicKeyHex: ed25519PublicKeyHex(createPublicKey(key)) };
}
