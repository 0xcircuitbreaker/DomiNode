import { apiRequest, type PricingResponse } from "../shared/api-client.js";
import { ALARMS } from "../shared/constants.js";
import { isAllowedExtensionSender, isAllowedPageSender, validateControlMessage } from "../shared/control.js";
import { isPlainObject } from "../shared/json.js";
import { scrubCredentials } from "../shared/scrub.js";
import { Controller } from "./controller.js";
import { createAuthHandler } from "./proxy.js";
import { syncPageBridge } from "./page-bridge.js";
import { handleInternal } from "./internal.js";

const ctl = new Controller();
const ready = ctl.init().then(
  () => syncPageBridge(ctl.settings.controlPageOrigins),
  (err) => {
    ctl.lastError = scrubCredentials(err);
  },
);

// Keep the page bridge registration in sync with the operator allowlist.
let lastOrigins = "";
ctl.setChangeListener(() => {
  const o = JSON.stringify(ctl.settings.controlPageOrigins);
  if (o !== lastOrigins) {
    lastOrigins = o;
    void syncPageBridge(ctl.settings.controlPageOrigins);
  }
});

// ─── Proxy auth ──────────────────────────────────────────────────
const authHandler = createAuthHandler(() => ctl.creds());
chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    // Wait for init so the first challenge after a cold start is answered.
    void ready.then(() => callback?.(authHandler(details)));
    return undefined;
  },
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);

// ─── Alarms ──────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  void ready.then(async () => {
    if (alarm.name === ALARMS.BALANCE) await ctl.pollBalance();
    if (alarm.name === ALARMS.ROTATE && ctl.settings.sticky) await ctl.rotateSession();
  });
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "managed") void ready.then(async () => { await ctl.applyManaged(); await ctl.apply(); });
});

// ─── Own pages (popup/options) and the page bridge content script ─
function isOwnPage(sender: chrome.runtime.MessageSender): boolean {
  if (sender.id !== chrome.runtime.id || sender.tab?.url?.startsWith("http")) return false;
  const own = chrome.runtime.getURL("");
  return !!sender.url && sender.url.startsWith(own);
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void (async () => {
    await ready;
    if (isPlainObject(message) && message.channel === "page-bridge") {
      // From content/page-bridge.js running in an allowlisted origin.
      if (!isAllowedPageSender(sender, chrome.runtime.id, ctl.settings.controlPageOrigins)) {
        return { ok: false, error: "Origin not allowed" };
      }
      const cmd = validateControlMessage(message.command);
      return { ok: true, result: await ctl.handleControl(cmd) };
    }
    if (!isOwnPage(sender)) return { ok: false, error: "Unauthorized sender" };
    return { ok: true, result: await handleInternal(ctl, message, fetchPricing) };
  })()
    .catch((err) => ({ ok: false, error: scrubCredentials(err) }))
    .then(sendResponse);
  return true;
});

// ─── External control channel (allowlisted extensions only) ──────
chrome.runtime.onMessageExternal.addListener((message: unknown, sender, sendResponse) => {
  void (async () => {
    await ready;
    if (!isAllowedExtensionSender(sender, ctl.settings.controlExtensionIds)) return { ok: false, error: "Sender not allowed" };
    const cmd = validateControlMessage(message);
    return { ok: true, result: await ctl.handleControl(cmd) };
  })()
    .catch((err) => ({ ok: false, error: scrubCredentials(err) }))
    .then(sendResponse);
  return true;
});

function fetchPricing(): Promise<PricingResponse> {
  return apiRequest<PricingResponse>(ctl.apiBase, "/v1/pricing");
}

// ─── CDP hook for headless drivers (only reachable by whoever controls the browser) ─
(globalThis as Record<string, unknown>).dominusnodeImportConfig = async (cfg: unknown) => {
  await ready;
  await ctl.importConfig(cfg);
  return ctl.controlStatus();
};
(globalThis as Record<string, unknown>).dominusnodeStatus = async () => {
  await ready;
  return ctl.controlStatus();
};

chrome.runtime.onStartup.addListener(() => void ready);
chrome.runtime.onInstalled.addListener(() => void ready);
