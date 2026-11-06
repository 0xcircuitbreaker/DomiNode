/**
 * Page-world control bridge (ISOLATED world content script). Only injected into
 * origins the operator allowlisted in options; the service worker re-checks the origin.
 *
 * Page usage:
 *   window.postMessage({ dominusnode: "request", id: "1", command: { v: 1, type: "getStatus" } }, location.origin);
 *   window.addEventListener("message", (e) => {
 *     if (e.source === window && e.data?.dominusnode === "response" && e.data.id === "1") console.log(e.data);
 *   });
 * Responses: { dominusnode: "response", id, ok: true, result } | { dominusnode: "response", id, ok: false, error }.
 * On load the bridge posts { dominusnode: "ready", v: 1 }.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function reply(data: Record<string, unknown>): void {
  window.postMessage({ dominusnode: "response", ...data }, window.location.origin);
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const d = event.data as { dominusnode?: unknown; id?: unknown; command?: unknown } | null;
  if (!d || typeof d !== "object" || d.dominusnode !== "request") return;
  if (typeof d.id !== "string" || !ID_RE.test(d.id)) return;
  const id = d.id;
  chrome.runtime
    .sendMessage({ channel: "page-bridge", command: d.command })
    .then((r: { ok: boolean; result?: unknown; error?: string } | undefined) =>
      reply(r?.ok ? { id, ok: true, result: r.result } : { id, ok: false, error: r?.error ?? "No response" }),
    )
    .catch(() => reply({ id, ok: false, error: "Extension unavailable" }));
});

window.postMessage({ dominusnode: "ready", v: 1 }, window.location.origin);
