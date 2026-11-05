import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { verifyEd25519 } from "@dominusnode/shared";
import { loadCoordSigner } from "./coord-key.js";

describe("loadCoordSigner", () => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }).toString();

  it("refuses to start in production without a key", () => {
    expect(() => loadCoordSigner({ NODE_ENV: "production" })).toThrow(/required in production/);
  });

  it("returns null outside production without a key", () => {
    expect(loadCoordSigner({ NODE_ENV: "development" })).toBeNull();
  });

  it("rejects unreadable or non-ed25519 files", () => {
    expect(() => loadCoordSigner({ COORD_SIGNING_KEY_FILE: "/x" }, () => { throw new Error("ENOENT"); })).toThrow(/could not be read/);
    expect(() => loadCoordSigner({ COORD_SIGNING_KEY_FILE: "/x" }, () => "garbage")).toThrow(/ed25519/);
  });

  it("signs verifiably", () => {
    const s = loadCoordSigner({ NODE_ENV: "production", COORD_SIGNING_KEY_FILE: "/k" }, () => pem)!;
    const msg = Buffer.from("hello");
    expect(verifyEd25519(s.publicKeyHex, msg, s.sign(msg))).toBe(true);
  });
});
