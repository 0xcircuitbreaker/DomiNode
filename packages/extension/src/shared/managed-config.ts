import { isPlainObject, stripDangerousKeys } from "./json.js";
import { DEFAULT_SETTINGS, validateApiKey, validateSettingsPatch, ValidationError, type Settings } from "./settings.js";

/**
 * Preconfiguration for headless runs. The same flat shape is accepted from:
 *  - chrome.storage.managed (enterprise policy JSON, see managed_schema.json), and
 *  - a one-time import (options page file/paste, or the service worker's
 *    dominusnodeImportConfig() for CDP-driven setups).
 *
 * Managed policy cannot express null, so "" means "unset" for country, ipClass and
 * exitCheckUrl, and 0 means "no cap" for spendCapCents.
 */
export interface ParsedConfig {
  settings: Partial<Settings>;
  apiKey?: string;
  /** Keys that were rejected (lenient mode only). */
  errors: string[];
}

const NULLABLE_EMPTY = new Set(["country", "ipClass", "exitCheckUrl", "sessionId"]);

export function parseConfig(input: unknown, mode: "strict" | "lenient"): ParsedConfig {
  if (!isPlainObject(input)) {
    if (mode === "strict") throw new ValidationError("config must be a JSON object");
    return { settings: {}, errors: ["config is not an object"] };
  }
  const obj = stripDangerousKeys(structuredClone(input)) as Record<string, unknown>;
  const out: ParsedConfig = { settings: {}, errors: [] };
  for (const [k, raw] of Object.entries(obj)) {
    try {
      if (k === "apiKey") {
        out.apiKey = validateApiKey(raw);
        continue;
      }
      if (!(k in DEFAULT_SETTINGS)) throw new ValidationError(`unknown config key: ${k.slice(0, 40)}`);
      let v = raw;
      if (NULLABLE_EMPTY.has(k) && v === "") v = null;
      if (k === "spendCapCents" && v === 0) v = null;
      Object.assign(out.settings, validateSettingsPatch({ [k]: v }, "operator"));
    } catch (err) {
      if (mode === "strict") throw err;
      out.errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

/** Read and validate chrome.storage.managed. Missing/unsupported storage yields an empty config. */
export async function loadManagedConfig(): Promise<ParsedConfig> {
  const area = typeof chrome !== "undefined" ? chrome.storage?.managed : undefined;
  if (!area) return { settings: {}, errors: [] };
  let raw: Record<string, unknown>;
  try {
    raw = await area.get(null);
  } catch {
    return { settings: {}, errors: [] };
  }
  return parseConfig(raw ?? {}, "lenient");
}
