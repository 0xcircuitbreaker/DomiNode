import { verifyMessage } from "ethers";

/**
 * Recover the signer address from an EIP-191 personal_sign signature.
 * Returns the checksummed address (lowercase) or null if recovery fails.
 */
export function recoverSignerAddress(
  message: string,
  signature: string,
): string | null {
  try {
    const recovered = verifyMessage(message, signature);
    return recovered.toLowerCase();
  } catch {
    return null;
  }
}
