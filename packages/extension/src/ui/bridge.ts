import type { Status } from "../background/controller.js";

export type { Status };

/** Message the service worker from the popup/options pages. */
export async function send<T = Status>(type: string, payload?: unknown): Promise<T> {
  const r = (await chrome.runtime.sendMessage({ type, payload })) as { ok: boolean; result?: T; error?: string } | undefined;
  if (!r) throw new Error("No response from background");
  if (!r.ok) throw new Error(r.error ?? "Request failed");
  return r.result as T;
}
