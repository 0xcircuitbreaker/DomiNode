import { invalidArg, ProtocolError } from "./errors.js";
import { validateAddress, validateSignature } from "./validation.js";

/**
 * Caller-supplied EIP-191 signer. The SDK has no crypto dependencies, so the
 * caller wires in ethers/viem/a hardware wallet:
 *
 *   const w = new ethers.Wallet(pk);
 *   const signer = { address: w.address, signMessage: (m) => w.signMessage(m) };
 *
 * signMessage MUST perform `personal_sign` (EIP-191 "\x19Ethereum Signed Message:\n" prefix)
 * over the exact UTF-8 string given and return a 65-byte 0x-hex signature.
 */
export interface Signer {
  /** 0x-prefixed 20-byte address of the signing key. */
  readonly address: string;
  signMessage(message: string): Promise<string> | string;
}

export function assertSigner(signer: unknown, name = "signer"): Signer {
  const s = signer as Signer;
  if (!s || typeof s !== "object" || typeof s.signMessage !== "function") {
    throw invalidArg(`${name} must be an object with address and signMessage(message)`);
  }
  validateAddress(s.address, `${name}.address`);
  return s;
}

/** Ask the signer for a signature and validate its format (0x + 130 hex, <= 200 chars). */
export async function sign(signer: Signer, message: string, name = "signer"): Promise<string> {
  let sig: unknown;
  try {
    sig = await signer.signMessage(message);
  } catch (err) {
    throw new ProtocolError(`${name}.signMessage failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return validateSignature(sig, `${name} signature`);
  } catch (err) {
    throw new ProtocolError((err as Error).message);
  }
}
