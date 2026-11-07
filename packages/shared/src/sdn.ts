import { promises as fs } from "node:fs";

/** Local OFAC SDN digital-currency address list (PAYOUT_SDN_FILE). */

export const MAX_SDN_FILE_BYTES = 64 * 1024 * 1024;
const EVM_ADDR_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

export class SdnUnavailableError extends Error {
  constructor(reason: string) {
    super(`SDN list unavailable: ${reason}`);
    this.name = "SdnUnavailableError";
  }
}

/** Extract every EVM address in the file (any format: CSV, XML, one per line), lowercased. */
export function parseSdnAddresses(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(EVM_ADDR_RE)) out.add(m[0].toLowerCase());
  return out;
}

const SOL_TAGGED_RE = /\bSOL\b[^\n]{0,40}?(?<![1-9A-HJ-NP-Za-km-z])([1-9A-HJ-NP-Za-km-z]{32,44})(?![1-9A-HJ-NP-Za-km-z])/g;
const SOL_LINE_RE = /^\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/gm;

/**
 * Payer screening set: every EVM address (lowercased) plus Solana addresses
 * (case-sensitive base58), either tagged "SOL" (OFAC "Digital Currency Address -
 * SOL") or listed one per line.
 */
export function parseSdnPayerAddresses(text: string): Set<string> {
  const out = parseSdnAddresses(text);
  for (const m of text.matchAll(SOL_TAGGED_RE)) out.add(m[1]);
  for (const m of text.matchAll(SOL_LINE_RE)) out.add(m[1]);
  return out;
}

/** Read the SDN list. Throws SdnUnavailableError if unset, missing, unreadable or oversized: callers must then pay nothing. */
export async function loadSdnFile(path: string | undefined): Promise<Set<string>> {
  return parseSdnAddresses(await loadSdnText(path));
}

/** Read the raw SDN file text with the same checks (unset/missing/oversized throw). */
export async function loadSdnText(path: string | undefined): Promise<string> {
  if (!path) throw new SdnUnavailableError("PAYOUT_SDN_FILE not set");
  let st;
  try {
    st = await fs.stat(path);
  } catch {
    throw new SdnUnavailableError("file missing");
  }
  if (!st.isFile()) throw new SdnUnavailableError("not a file");
  if (st.size > MAX_SDN_FILE_BYTES) throw new SdnUnavailableError("file too large");
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch {
    throw new SdnUnavailableError("file unreadable");
  }
  return text;
}
