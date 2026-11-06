const SCRIPT_ID = "dominusnode-page-bridge";

/** Chrome match patterns cannot carry a port; the service worker re-checks the exact origin. */
export function originsToMatches(origins: readonly string[]): string[] {
  const out = new Set<string>();
  for (const o of origins) {
    try {
      const u = new URL(o);
      out.add(`${u.protocol}//${u.hostname}/*`);
    } catch {
      /* skip invalid */
    }
  }
  return [...out];
}

/**
 * The page bridge is disabled by default: the content script is only registered
 * (chrome.scripting) for origins the operator lists, and unregistered when the list is empty.
 */
export async function syncPageBridge(origins: readonly string[]): Promise<void> {
  if (!chrome.scripting?.registerContentScripts) return;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] }).catch(() => []);
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  const matches = originsToMatches(origins);
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: SCRIPT_ID, matches, js: ["content/page-bridge.js"], runAt: "document_start", allFrames: false, persistAcrossSessions: true },
  ]);
}
