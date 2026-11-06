import { isPlainObject, stripDangerousKeys } from "./json.js";
import { validateSettingsPatch, ValidationError, type Settings } from "./settings.js";

/**
 * Agent control channel protocol (shared by chrome.runtime.onMessageExternal and the
 * opt-in page bridge). Every message is validated strictly; unknown keys are rejected.
 *
 *   { "v": 1, "type": "getStatus" }
 *   { "v": 1, "type": "setSettings", "settings": { "country": "DE", "ipClass": "residential", ... } }
 *   { "v": 1, "type": "rotateSession" }
 *   { "v": 1, "type": "enable" } | { "v": 1, "type": "disable" }
 *
 * Settings changeable here are routing-only (see CONTROL_KEYS). The API key, gateway,
 * API base, spend cap and allowlists can only be changed by the operator.
 */
export type ControlCommand =
  | { type: "getStatus" }
  | { type: "setSettings"; settings: Partial<Settings> }
  | { type: "rotateSession" }
  | { type: "enable" }
  | { type: "disable" };

export const MAX_CONTROL_MESSAGE_BYTES = 4096;

export function validateControlMessage(raw: unknown): ControlCommand {
  let size: number;
  try {
    size = JSON.stringify(raw)?.length ?? 0;
  } catch {
    throw new ValidationError("message is not serializable");
  }
  if (size > MAX_CONTROL_MESSAGE_BYTES) throw new ValidationError("message too large");
  if (!isPlainObject(raw)) throw new ValidationError("message must be an object");
  const msg = stripDangerousKeys(structuredClone(raw)) as Record<string, unknown>;
  if (msg.v !== 1) throw new ValidationError("unsupported protocol version (expected v: 1)");
  const allowed = (keys: string[]) => {
    for (const k of Object.keys(msg)) {
      if (!keys.includes(k)) throw new ValidationError(`unexpected field: ${k.slice(0, 40)}`);
    }
  };
  switch (msg.type) {
    case "getStatus":
    case "rotateSession":
    case "enable":
    case "disable":
      allowed(["v", "type"]);
      return { type: msg.type };
    case "setSettings":
      allowed(["v", "type", "settings"]);
      return { type: "setSettings", settings: validateSettingsPatch(msg.settings, "control") };
    default:
      throw new ValidationError("unknown command type");
  }
}

/** Is an external extension sender on the operator allowlist? */
export function isAllowedExtensionSender(
  sender: { id?: string; origin?: string; url?: string },
  allowIds: readonly string[],
): boolean {
  if (!sender.id || !allowIds.includes(sender.id)) return false;
  // Messages from web pages via externally_connectable carry a page URL; only accept
  // extension-origin senders here (web origins use the opt-in page bridge instead).
  const origin = sender.origin ?? (sender.url ? safeOrigin(sender.url) : undefined);
  return origin === undefined || origin === `chrome-extension://${sender.id}`;
}

/** Is a page-bridge message from a tab whose top-level origin is on the allowlist? */
export function isAllowedPageSender(
  sender: { id?: string; url?: string; origin?: string; tab?: unknown; frameId?: number },
  ownId: string,
  allowOrigins: readonly string[],
): boolean {
  if (sender.id !== ownId || !sender.tab) return false;
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  const origin = sender.origin ?? (sender.url ? safeOrigin(sender.url) : undefined);
  return !!origin && allowOrigins.includes(origin);
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
