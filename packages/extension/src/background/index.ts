import { loadState, updateState } from "../shared/state.js";
import { generateSessionId } from "../shared/proxy-config.js";
import type { ExtensionMessage, ExtensionState, MessageResponse } from "../shared/types.js";
import { ALARM_NAMES, TOKEN_REFRESH_MINUTES, BALANCE_POLL_MINUTES, DEFAULT_API_BASE } from "../shared/constants.js";
import { setApiBase } from "../shared/api-client.js";
import { login, loginWithKey, logout, verifyMfaCode } from "./auth-manager.js";
import { enableProxy, disableProxy, reconfigureProxy } from "./proxy-controller.js";
import { refreshTokenIfNeeded } from "./token-refresher.js";
import { pollBalance } from "./balance-poller.js";
import { updateBadge } from "./badge-manager.js";

// Initialize API base URL to production default (overrides DEV_API_BASE localhost fallback)
setApiBase(DEFAULT_API_BASE);

// ─── Input validation helpers ────────────────────────────────────
const COUNTRY_RE = /^[A-Z]{2}$/;
const STATE_RE = /^[a-z]{2,30}$/;
const CITY_RE = /^[a-z]{2,50}$/;
const VALID_PROTOCOLS = new Set(["http", "socks5"]);

function validatePayload<T>(payload: unknown, check: (v: unknown) => v is T, errorMsg: string): T {
  if (!check(payload)) throw new Error(errorMsg);
  return payload;
}

function isLoginPayload(v: unknown): v is { email: string; password: string } {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as Record<string, unknown>).email === "string" &&
    typeof (v as Record<string, unknown>).password === "string" &&
    (v as Record<string, unknown>).email !== "" &&
    (v as Record<string, unknown>).password !== ""
  );
}

function isKeyPayload(v: unknown): v is { apiKey: string } {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as Record<string, unknown>).apiKey === "string" &&
    ((v as Record<string, unknown>).apiKey as string).startsWith("dn_live_")
  );
}

function isMfaPayload(v: unknown): v is { code: string; isBackupCode?: boolean } {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as Record<string, unknown>).code === "string" &&
    (v as Record<string, unknown>).code !== ""
  );
}

// ─── Sender validation ──────────────────────────────────────────
function isOwnExtension(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id) return false;
  const url = sender.url ?? "";
  if (url) {
    const ownOrigin = chrome.runtime.getURL("");
    if (!url.startsWith(ownOrigin)) {
      return false;
    }
  }
  return true;
}

// ─── State sanitization ─────────────────────────────────────────
function sanitizeStateForUI(state: ExtensionState): Omit<ExtensionState, "accessToken" | "refreshToken" | "apiKey" | "proxyToken" | "mfaChallengeToken"> & { isAuthenticated: boolean; hasProxyToken: boolean } {
  const { accessToken: _a, refreshToken: _r, apiKey: _k, proxyToken: _pt, mfaChallengeToken: _m, ...rest } = state;
  return { ...rest, isAuthenticated: !!(state.accessToken || state.apiKey), hasProxyToken: !!state.proxyToken };
}

// ─── Message handler ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse: (response: MessageResponse) => void) => {
    if (!isOwnExtension(sender)) {
      sendResponse({ success: false, error: "Unauthorized sender" });
      return false;
    }
    handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((err) =>
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
      );
    return true; // Keep message channel open for async response
  },
);

async function handleMessage(message: ExtensionMessage): Promise<MessageResponse> {
  try {
    switch (message.type) {
      case "GET_STATE": {
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "LOGIN": {
        const { email, password } = validatePayload(
          message.payload, isLoginPayload, "Invalid login payload: email and password required",
        );
        const result = await login(email, password);
        const state = await loadState();
        return { success: true, data: { ...sanitizeStateForUI(state), mfaRequired: result.mfaRequired } };
      }

      case "VERIFY_MFA": {
        const { code, isBackupCode } = validatePayload(
          message.payload, isMfaPayload, "Invalid MFA payload: code required",
        );
        await verifyMfaCode(code, isBackupCode ?? false);
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "LOGIN_WITH_KEY": {
        const { apiKey } = validatePayload(
          message.payload, isKeyPayload, "Invalid API key: must start with dn_live_",
        );
        await loginWithKey(apiKey);
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "LOGOUT": {
        await logout();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "TOGGLE_PROXY": {
        const state = await loadState();
        if (state.proxyEnabled) {
          await disableProxy();
        } else {
          await enableProxy();
        }
        const updated = await loadState();
        return { success: true, data: sanitizeStateForUI(updated) };
      }

      case "SET_COUNTRY": {
        const country = message.payload;
        if (typeof country !== "string" || !COUNTRY_RE.test(country)) {
          return { success: false, error: "Invalid country code: must be 2-letter ISO code" };
        }
        // Reset state/city when country changes (they're country-specific)
        await updateState({ country, state: "", city: "" });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "SET_STATE": {
        const stateVal = message.payload;
        if (typeof stateVal !== "string") {
          return { success: false, error: "Invalid state value" };
        }
        if (stateVal !== "" && !STATE_RE.test(stateVal)) {
          return { success: false, error: "Invalid state: must be 2-30 lowercase letters" };
        }
        // Reset city when state changes
        await updateState({ state: stateVal, city: "" });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "SET_CITY": {
        const cityVal = message.payload;
        if (typeof cityVal !== "string") {
          return { success: false, error: "Invalid city value" };
        }
        if (cityVal !== "" && !CITY_RE.test(cityVal)) {
          return { success: false, error: "Invalid city: must be 2-50 lowercase letters" };
        }
        await updateState({ city: cityVal });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "SET_ASN": {
        const asnVal = message.payload;
        if (asnVal !== null && (typeof asnVal !== "number" || !Number.isInteger(asnVal) || asnVal < 1 || asnVal > 4_294_967_295)) {
          return { success: false, error: "Invalid ASN: must be an integer 1-4294967295 or null" };
        }
        await updateState({ asn: asnVal as number | null });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "SET_PROTOCOL": {
        const protocol = message.payload;
        if (typeof protocol !== "string" || !VALID_PROTOCOLS.has(protocol)) {
          return { success: false, error: "Invalid protocol: must be 'http' or 'socks5'" };
        }
        await updateState({ proxyProtocol: protocol as "http" | "socks5" });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "SET_STICKY": {
        const enabled = message.payload;
        if (typeof enabled !== "boolean") {
          return { success: false, error: "Invalid sticky value: must be boolean" };
        }
        const sessionId = enabled ? generateSessionId() : null;
        await updateState({ stickySession: enabled, sessionId });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "SET_ROTATION": {
        const minutes = message.payload;
        if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
          return { success: false, error: "Invalid rotation interval: 0-1440 minutes" };
        }
        await updateState({ rotationIntervalMinutes: minutes });
        if (minutes > 0) {
          chrome.alarms.create(ALARM_NAMES.SESSION_ROTATE, { periodInMinutes: minutes });
        } else {
          chrome.alarms.clear(ALARM_NAMES.SESSION_ROTATE);
        }
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "ROTATE_SESSION": {
        const sessionId = generateSessionId();
        await updateState({ sessionId });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "REFRESH_BALANCE": {
        await pollBalance();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "SET_PROXY_TOKEN": {
        const token = message.payload as string;
        if (typeof token !== "string" || !token.startsWith("dn_proxy_")) {
          return { success: false, error: "Invalid proxy token: must start with dn_proxy_" };
        }
        if (token.length > 2000) {
          return { success: false, error: "Proxy token too long" };
        }
        // Parse expiry from the token payload (base64url between dn_proxy_ and last .)
        let expiry: number | null = null;
        try {
          const withoutPrefix = token.slice(9); // Remove "dn_proxy_"
          const dotIdx = withoutPrefix.lastIndexOf(".");
          if (dotIdx > 0) {
            const payloadB64 = withoutPrefix.slice(0, dotIdx);
            const payloadJson = atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/"));
            const payload = JSON.parse(payloadJson);
            if (typeof payload === "object" && payload !== null && typeof payload.expiresAt === "number") {
              expiry = payload.expiresAt;
            }
          }
        } catch {
          // Token expiry parsing is best-effort
        }
        await updateState({ proxyToken: token, proxyTokenExpiry: expiry });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      case "CLEAR_PROXY_TOKEN": {
        await updateState({ proxyToken: null, proxyTokenExpiry: null });
        await reconfigureProxy();
        const state = await loadState();
        return { success: true, data: sanitizeStateForUI(state) };
      }

      default:
        return { success: false, error: `Unknown message type: ${message.type}` };
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await updateState({ lastError: error });
    throw err;
  }
}

// ─── Alarms ───────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    switch (alarm.name) {
      case ALARM_NAMES.TOKEN_REFRESH:
        await refreshTokenIfNeeded();
        break;
      case ALARM_NAMES.BALANCE_POLL:
        await pollBalance();
        break;
      case ALARM_NAMES.SESSION_ROTATE: {
        const state = await loadState();
        if (state.proxyEnabled && state.stickySession) {
          const sessionId = generateSessionId();
          await updateState({ sessionId });
          await reconfigureProxy();
        }
        break;
      }
    }
  } catch {
    // Alarm handler errors are non-fatal
  }
});

// ─── Ensure alarms exist ─────────────────────────────────────────
async function ensureAlarms(): Promise<void> {
  const existing = await chrome.alarms.getAll();
  const names = new Set(existing.map((a) => a.name));

  if (!names.has(ALARM_NAMES.TOKEN_REFRESH)) {
    chrome.alarms.create(ALARM_NAMES.TOKEN_REFRESH, { periodInMinutes: TOKEN_REFRESH_MINUTES });
  }
  if (!names.has(ALARM_NAMES.BALANCE_POLL)) {
    chrome.alarms.create(ALARM_NAMES.BALANCE_POLL, { periodInMinutes: BALANCE_POLL_MINUTES });
  }
}

// ─── Startup ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarms();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();

  const state = await loadState();

  // Auto-reconnect if proxy was enabled before browser restart
  if (state.proxyEnabled && (state.apiKey || state.proxyToken) && state.balanceCents > 0) {
    try {
      await enableProxy();
    } catch {
      await updateState({
        proxyEnabled: false,
        isConnected: false,
        lastError: "Auto-reconnect failed",
      });
    }
  }

  updateBadge(await loadState());
});
