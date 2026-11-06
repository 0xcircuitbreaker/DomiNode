import { STORAGE_KEYS } from "../shared/constants.js";
import { normalizeSettings, validateApiKey, type Settings } from "../shared/settings.js";
import { newRun, type RunState } from "../shared/spend.js";

/** Run state is per browser session: chrome.storage.session when available. */
function runArea(): chrome.storage.StorageArea {
  return chrome.storage.session ?? chrome.storage.local;
}

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return normalizeSettings(r[STORAGE_KEYS.SETTINGS]);
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: s });
}

/** The API key lives only in chrome.storage.local (never storage.sync). */
export async function loadApiKey(): Promise<string | null> {
  const r = await chrome.storage.local.get(STORAGE_KEYS.SECRET);
  const v = (r[STORAGE_KEYS.SECRET] as { apiKey?: unknown } | undefined)?.apiKey;
  try {
    return validateApiKey(v);
  } catch {
    return null;
  }
}

export async function saveApiKey(key: string | null): Promise<void> {
  if (key === null) await chrome.storage.local.remove(STORAGE_KEYS.SECRET);
  else await chrome.storage.local.set({ [STORAGE_KEYS.SECRET]: { apiKey: validateApiKey(key) } });
}

export async function loadRun(): Promise<RunState> {
  const r = await runArea().get(STORAGE_KEYS.RUN);
  const v = r[STORAGE_KEYS.RUN] as RunState | undefined;
  return v && typeof v.startedAt === "number" ? { ...newRun(), ...v } : newRun();
}

export async function saveRun(run: RunState): Promise<void> {
  await runArea().set({ [STORAGE_KEYS.RUN]: run });
}
