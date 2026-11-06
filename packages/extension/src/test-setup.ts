import { vi } from "vitest";

// ─── Chrome Storage Mocks ────────────────────────────────────────
function createStorageMock() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (keys: string | string[] | Record<string, unknown> | null) => {
      if (keys === null || keys === undefined) return Object.fromEntries(store);
      if (typeof keys === "string") {
        return { [keys]: store.get(keys) };
      }
      if (Array.isArray(keys)) {
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          result[key] = store.get(key);
        }
        return result;
      }
      // Object with defaults
      const result: Record<string, unknown> = {};
      for (const [key, defaultVal] of Object.entries(keys)) {
        result[key] = store.has(key) ? store.get(key) : defaultVal;
      }
      return result;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const key of keyList) {
        store.delete(key);
      }
    }),
    clear: vi.fn(async () => {
      store.clear();
    }),
    _store: store,
  };
}

// ─── Chrome Proxy Settings Mock ──────────────────────────────────
const proxySettingsMock = {
  set: vi.fn(async (_details: unknown) => {}),
  clear: vi.fn(async (_details: unknown) => {}),
  get: vi.fn((_details: unknown, callback?: (config: unknown) => void) => {
    if (callback) callback({});
  }),
};

// ─── Chrome Alarms Mock ──────────────────────────────────────────
const alarmListeners: Array<(alarm: chrome.alarms.Alarm) => void> = [];

const alarmsMock = {
  create: vi.fn((_name: string, _alarmInfo: chrome.alarms.AlarmCreateInfo) => {}),
  clear: vi.fn(async (_name?: string) => true),
  clearAll: vi.fn(async () => true),
  get: vi.fn(async (_name: string) => undefined),
  getAll: vi.fn((callback?: (alarms: chrome.alarms.Alarm[]) => void) => {
    if (callback) callback([]);
  }),
  onAlarm: {
    addListener: vi.fn((listener: (alarm: chrome.alarms.Alarm) => void) => {
      alarmListeners.push(listener);
    }),
    removeListener: vi.fn((listener: (alarm: chrome.alarms.Alarm) => void) => {
      const idx = alarmListeners.indexOf(listener);
      if (idx >= 0) alarmListeners.splice(idx, 1);
    }),
    hasListener: vi.fn((listener: (alarm: chrome.alarms.Alarm) => void) => {
      return alarmListeners.includes(listener);
    }),
    hasListeners: vi.fn(() => alarmListeners.length > 0),
    _listeners: alarmListeners,
  },
};

// ─── Chrome Runtime Mock ─────────────────────────────────────────
const runtimeMessageListeners: Array<
  (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => void
> = [];

const runtimeMock = {
  sendMessage: vi.fn(async (_message: unknown) => {}),
  onMessage: {
    addListener: vi.fn(
      (
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => void,
      ) => {
        runtimeMessageListeners.push(listener);
      },
    ),
    removeListener: vi.fn(
      (
        listener: (
          message: unknown,
          sender: unknown,
          sendResponse: (response?: unknown) => void,
        ) => void,
      ) => {
        const idx = runtimeMessageListeners.indexOf(listener);
        if (idx >= 0) runtimeMessageListeners.splice(idx, 1);
      },
    ),
    hasListener: vi.fn(() => false),
    hasListeners: vi.fn(() => runtimeMessageListeners.length > 0),
    _listeners: runtimeMessageListeners,
  },
  getURL: vi.fn((path: string) => `chrome-extension://fake-id/${path}`),
  id: "abcdefghijklmnopabcdefghijklmnop",
  onMessageExternal: { addListener: vi.fn() },
  getPlatformInfo: vi.fn(async () => ({ os: "linux" })),
};

// ─── Chrome WebRequest Mock ──────────────────────────────────────
const authRequiredListeners: Array<(details: unknown, callback: (response: unknown) => void) => void> = [];

const webRequestMock = {
  onAuthRequired: {
    addListener: vi.fn(
      (
        listener: (details: unknown, callback: (response: unknown) => void) => void,
        _filter?: unknown,
        _extraInfoSpec?: string[],
      ) => {
        authRequiredListeners.push(listener);
      },
    ),
    removeListener: vi.fn(
      (listener: (details: unknown, callback: (response: unknown) => void) => void) => {
        const idx = authRequiredListeners.indexOf(listener);
        if (idx >= 0) authRequiredListeners.splice(idx, 1);
      },
    ),
    hasListener: vi.fn(() => false),
    hasListeners: vi.fn(() => authRequiredListeners.length > 0),
    _listeners: authRequiredListeners,
  },
};

// ─── Chrome Action (Badge) Mock ──────────────────────────────────
const actionMock = {
  setBadgeText: vi.fn(async (_details: { text: string }) => {}),
  setBadgeBackgroundColor: vi.fn(async (_details: { color: string }) => {}),
  setIcon: vi.fn(async (_details: unknown) => {}),
  setTitle: vi.fn(async (_details: { title: string }) => {}),
};

// ─── Chrome Privacy Mock ─────────────────────────────────────────
const privacyMock = {
  network: {
    webRTCIPHandlingPolicy: {
      set: vi.fn(async (_details: { value: string }) => {}),
      get: vi.fn((_details: unknown, callback?: (details: unknown) => void) => {
        if (callback) callback({ value: "default" });
      }),
      clear: vi.fn(async (_details?: unknown) => {}),
    },
  },
};

// ─── Chrome Notifications Mock ───────────────────────────────────
const notificationsMock = {
  create: vi.fn(
    (_id: string, _options: unknown, _callback?: (notificationId: string) => void) => {},
  ),
  clear: vi.fn((_id: string, _callback?: (wasCleared: boolean) => void) => {}),
};

// ─── Assemble Full Chrome Mock ───────────────────────────────────
const chromeMock = {
  storage: {
    session: createStorageMock(),
    local: createStorageMock(),
    sync: createStorageMock(),
    managed: createStorageMock(),
    onChanged: { addListener: vi.fn() },
  },
  scripting: {
    registerContentScripts: vi.fn(async () => {}),
    unregisterContentScripts: vi.fn(async () => {}),
    getRegisteredContentScripts: vi.fn(async () => []),
  },
  proxy: {
    settings: proxySettingsMock,
  },
  alarms: alarmsMock,
  runtime: runtimeMock,
  webRequest: webRequestMock,
  action: actionMock,
  privacy: privacyMock,
  notifications: notificationsMock,
};

// Assign to globalThis so extension code can use `chrome.*`
(globalThis as Record<string, unknown>).chrome = chromeMock;

// Export for tests that need to access the mock internals
export { chromeMock };
