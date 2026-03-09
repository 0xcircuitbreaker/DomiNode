import type { ExtensionState } from "./types.js";
import { DEFAULT_STATE } from "./types.js";
import { STORAGE_KEYS } from "./constants.js";

type StateListener = (state: ExtensionState) => void;

const listeners: StateListener[] = [];

// Mutex to prevent concurrent read-modify-write races
let stateLock: Promise<void> = Promise.resolve();

// Auth fields stored in chrome.storage.session (ephemeral, cleared on browser close)
const AUTH_FIELDS = ["apiKey", "proxyToken", "proxyTokenExpiry", "accessToken", "refreshToken", "userId", "email", "walletAddress", "mfaChallengeToken"] as const;
type AuthField = (typeof AUTH_FIELDS)[number];

interface AuthData {
  apiKey: string | null;
  proxyToken: string | null;
  proxyTokenExpiry: number | null;
  accessToken: string | null;
  refreshToken: string | null;
  userId: string | null;
  email: string | null;
  walletAddress: string | null;
  mfaChallengeToken: string | null;
}

function extractAuth(state: ExtensionState): AuthData {
  return {
    apiKey: state.apiKey,
    proxyToken: state.proxyToken,
    proxyTokenExpiry: state.proxyTokenExpiry,
    accessToken: state.accessToken,
    refreshToken: state.refreshToken,
    userId: state.userId,
    email: state.email,
    walletAddress: state.walletAddress,
    mfaChallengeToken: state.mfaChallengeToken ?? null,
  };
}

function stripAuth(state: ExtensionState): Omit<ExtensionState, AuthField> {
  const { apiKey, accessToken, refreshToken, userId, email, mfaChallengeToken, ...rest } = state;
  return rest;
}

/**
 * Check if chrome.storage.session is available (MV3 only).
 * Falls back to chrome.storage.local if not available (e.g., older browsers, tests).
 */
function hasSessionStorage(): boolean {
  return typeof chrome !== "undefined" &&
    typeof chrome.storage !== "undefined" &&
    typeof chrome.storage.session !== "undefined";
}

export async function loadState(): Promise<ExtensionState> {
  try {
    // Load persistent config from chrome.storage.local
    const configResult = await chrome.storage.local.get(STORAGE_KEYS.STATE);
    const savedConfig = configResult[STORAGE_KEYS.STATE];

    // Load auth tokens from chrome.storage.session (ephemeral)
    let savedAuth: AuthData | null = null;
    if (hasSessionStorage()) {
      const authResult = await chrome.storage.session.get(STORAGE_KEYS.AUTH);
      savedAuth = authResult[STORAGE_KEYS.AUTH] as AuthData | undefined ?? null;
    } else {
      // Fallback: do NOT load auth credentials from storage.local — auth fields
      // must come from session storage only to prevent credential persistence
      // across browser restarts and exposure to other extensions/sync
      savedAuth = {
        apiKey: null,
        proxyToken: null,
        proxyTokenExpiry: null,
        accessToken: null,
        refreshToken: null,
        userId: null,
        email: null,
        walletAddress: null,
        mfaChallengeToken: null, // Prevent stale MFA token from persisted state
      };
    }

    const config = savedConfig && typeof savedConfig === "object"
      ? savedConfig
      : {};

    return {
      ...DEFAULT_STATE,
      // Strip auth fields from local storage config to prevent stale credential reconnection
      ...stripAuth(config as ExtensionState),
      // Auth from session storage overrides any stale auth in local
      ...(savedAuth ?? {}),
    };
  } catch {
    // Storage not available (e.g., in tests)
  }
  return { ...DEFAULT_STATE };
}

export async function saveState(state: ExtensionState): Promise<void> {
  try {
    // Save persistent config (no auth tokens) to chrome.storage.local
    const configOnly = stripAuth(state);
    await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: configOnly });

    // Save auth tokens to chrome.storage.session (ephemeral)
    if (hasSessionStorage()) {
      const auth = extractAuth(state);
      await chrome.storage.session.set({ [STORAGE_KEYS.AUTH]: auth });
    } else {
      // Fallback: save config-only to local storage (no auth data, no PII)
      // Also strip userId and email — PII should not persist in non-session storage
      const { accessToken: _a, refreshToken: _r, apiKey: _k, proxyToken: _pt, proxyTokenExpiry: _pe, mfaChallengeToken: _m, userId: _u, email: _e, walletAddress: _w, ...safeConfig } = state;
      await chrome.storage.local.set({ [STORAGE_KEYS.STATE]: safeConfig });
    }
  } catch {
    // Storage not available
  }
  for (const listener of listeners) {
    listener(state);
  }
}

export async function updateState(partial: Partial<ExtensionState>): Promise<ExtensionState> {
  // Re-throw errors instead of silently returning undefined
  let result: ExtensionState | undefined;
  let error: unknown;
  const prev = stateLock;
  stateLock = prev.then(async () => {
    const current = await loadState();
    result = { ...current, ...partial };
    await saveState(result);
  }).catch((e) => {
    error = e;
  });
  await stateLock;
  if (error || !result) {
    throw error ?? new Error("State update failed");
  }
  return result;
}

export function onStateChange(listener: StateListener): () => void {
  listeners.push(listener);
  return () => {
    const idx = listeners.indexOf(listener);
    if (idx >= 0) listeners.splice(idx, 1);
  };
}
