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

/** Read the SDN list. Throws SdnUnavailableError if unset, missing, unreadable or oversized: callers must then pay nothing. */
export async function loadSdnFile(path: string | undefined): Promise<Set<string>> {
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
  return parseSdnAddresses(text);
}
