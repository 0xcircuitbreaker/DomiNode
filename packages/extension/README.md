# DominusNode Agent Companion (browser extension)

MV3 extension that routes an automated (usually headless) Chromium profile through the
DominusNode gateway, so an AI agent's browser traffic gets the same country / IP class /
sticky-session routing as its API calls, with a hard per-run spend cap.

It also shows the agent's relay nodes, tier progress and credits, and the exact steps to
contribute a machine as a node. It never relays traffic itself: MV3 cannot open raw TCP and
must not see other agents' decrypted traffic.

## How it works

- `chrome.proxy` gets a PAC script: every host except the API host, loopback and plain host
  names goes to `PROXY <gatewayHost>:<gatewayPort>`.
- `chrome.webRequest.onAuthRequired` (`webRequestAuthProvider`) answers the gateway's 407 with
  username = routing flags and password = the `dn_live_` key. It answers only proxy challenges
  from the configured gateway host:port, never site (origin) auth, and only once per request.
- Username flags (parsed by `packages/proxy-gateway/src/auth.ts`):

  | Setting | Flag |
  |---|---|
  | country | `country-US` |
  | IP class | `class-residential` / `class-dc` / `class-mobile` |
  | sticky session | `session-<id>` (Rotate = new id) |
  | plaintext HTTP | `allowhttp-1` (off by default; the exit node can read plaintext, responses carry `X-DominusNode-Exit-Visible: 1`) |

  Example: `agent-country-DE-class-residential-session-40bb5ac94633d551`. The leading `agent`
  keeps the deprecated `dc-`/`residential-` prefix parser from matching.
- Spend cap: the balance is sampled every minute (`POST /api/auth/verify-key` mints a short JWT
  kept in memory, then `GET /api/wallet`). Spend this run = start balance - current balance
  (top-ups are not counted). At the cap, or at a zero balance, the PAC switches to a dead
  loopback proxy (`127.0.0.1:9`) and gateway auth is cancelled: traffic fails, it never goes
  direct with the machine's real IP. Only the operator (popup "New run" or options) starts a
  new run; control channels cannot lift a block.
- An enabled profile without a key also fails closed.
- Pricing comes from `GET /v1/pricing`. Nodes, tier and credits come from `GET /v1/nodes`,
  `GET /v1/node/tier` and `GET /v1/credits` (see `docs/agent-network/AGENT_API.md`).

## Build

```bash
cd packages/extension
npm install
npm run build          # -> dist/chrome  (also build:edge, build:opera, build:all)
npm test               # vitest
npm run typecheck
```

## Headless preconfiguration

Use one of the following. In both, the key is stored only in `chrome.storage.local` (never
`storage.sync`) and is never returned by any status or control response.

### Config shape

The same flat JSON is accepted by the managed policy and by the one-time import:

```json
{
  "apiKey": "dn_live_…",
  "enabled": true,
  "apiBase": "https://api.dominusnode.com",
  "gatewayHost": "proxy.dominusnode.com",
  "gatewayPort": 8080,
  "country": "US",
  "ipClass": "residential",
  "sticky": true,
  "rotateMinutes": 0,
  "plaintext": false,
  "spendCapCents": 500,
  "controlExtensionIds": [],
  "controlPageOrigins": [],
  "exitCheckUrl": "https://ipinfo.io/json"
}
```

`""` means "any" for `country` and `ipClass`. `0` means "no cap" for `spendCapCents`. The schema is in `managed_schema.json`.

### A) Enterprise policy (`chrome.storage.managed`)

Policy keys are bound to an extension ID. An unpacked extension's ID comes from its path
unless the manifest has a `key`. For a stable ID, add a `"key"` (the base64 public key) to
`dist/chrome/manifest.json` or always load from the same path. Then write the policy file:

- Linux Chromium: `/etc/chromium/policies/managed/dominusnode.json`
- Linux Google Chrome: `/etc/opt/chrome/policies/managed/dominusnode.json`
- macOS / Windows: the `3rdparty` policy for the extension, set via MDM or the registry

```json
{ "3rdparty": { "extensions": { "<EXTENSION_ID>": {
  "apiKey": "dn_live_…", "enabled": true, "country": "US", "ipClass": "residential", "spendCapCents": 500
} } } }
```

Policy values override stored ones on every start, and they are locked in the options UI.

### B) One-time import (no root, no policy)

- From the options page: Connection, then One-time import. Paste the JSON or pick a file.
- From a CDP driver: call `dominusnodeImportConfig(cfg)` in the extension service worker, as
  in the snippets below. Only code that already controls the browser through CDP can reach
  this function.

### Playwright (Chromium, new headless)

```js
import { chromium } from "playwright";

const EXT = "/abs/path/packages/extension/dist/chrome";
const ctx = await chromium.launchPersistentContext("", {
  channel: "chromium",          // full Chromium: new headless supports extensions
  headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
await sw.evaluate((cfg) => self.dominusnodeImportConfig(cfg), {
  apiKey: process.env.DN_API_KEY,             // from env, never argv
  country: "US", ipClass: "residential", sticky: true, spendCapCents: 500, enabled: true,
});
const page = await ctx.newPage();
await page.goto("https://example.com");       // routed through the gateway

// Mid-run change without restarting:
await sw.evaluate(() => self.dominusnodeStatus());
```

### Puppeteer

```js
import puppeteer from "puppeteer";

const EXT = "/abs/path/packages/extension/dist/chrome";
const browser = await puppeteer.launch({
  headless: "new",   // or true on Puppeteer >= 22
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"));
const sw = await target.worker();
await sw.evaluate((cfg) => self.dominusnodeImportConfig(cfg), {
  apiKey: process.env.DN_API_KEY, country: "DE", ipClass: "dc", enabled: true, spendCapCents: 200,
});
const page = await browser.newPage();
await page.goto("https://example.com");
```

The Playwright `headless_shell` build (and the old `--headless`) cannot load extensions. Use
full Chromium in new headless mode.

## Agent control channel

Use the control channel to change routing mid-run without restarting. Every message is
validated strictly: unknown fields and wrong types are rejected, and prototype-pollution keys
are stripped. The message size limit is 4 KB.

```json
{ "v": 1, "type": "getStatus" }
{ "v": 1, "type": "setSettings", "settings": { "country": "DE", "ipClass": "mobile", "sticky": true } }
{ "v": 1, "type": "rotateSession" }
{ "v": 1, "type": "enable" }
{ "v": 1, "type": "disable" }
```

- Control messages can change only `enabled`, `country`, `ipClass`, `sticky`, `sessionId`,
  `rotateMinutes` and `plaintext`.
- These are operator-only: the API key, gateway, API base, spend cap, exit check URL and the
  allowlists.
- Replies are `{ ok: true, result: <status> }` or `{ ok: false, error }`. The status has mode,
  flags, spend, cap, balance and block reason. It never includes the key.

### 1) From another extension (`chrome.runtime.onMessageExternal`)

Add the driver extension's ID under Options, then Agent control (or `controlExtensionIds`).
Other senders get `Sender not allowed`.

```js
chrome.runtime.sendMessage("<companion id>", { v: 1, type: "setSettings", settings: { country: "GB" } }, console.log);
```

### 2) Page-world bridge (disabled by default)

The bridge is enabled only for origins listed in `controlPageOrigins`: exact https origins,
or `http://localhost`, with no wildcards. For those origins, a content script is registered
with `chrome.scripting`. The service worker rechecks that the message comes from the exact
origin and the top frame. Any script on a listed page can change routing, so list only
origins you control.

```js
window.postMessage({ dominusnode: "request", id: "1", command: { v: 1, type: "rotateSession" } }, location.origin);
window.addEventListener("message", (e) => {
  if (e.source === window && e.data?.dominusnode === "response" && e.data.id === "1") console.log(e.data);
});
// The bridge announces itself with { dominusnode: "ready", v: 1 }.
```

## Contribute this machine

The Options tab "Contribute this machine" has the same steps as the MCP tool
`dominusnode_node_setup_guide`, with commands for Linux, macOS or Windows:

1. Store the wallet key in a 0600 file.
2. Register with the node-agent CLI.
3. Run it under a supervisor.
4. Verify in the Nodes tab.

Nothing is installed by the extension. There is no native messaging.

## Permissions

| Permission | Why |
|---|---|
| `proxy` | Set the PAC script that routes this profile through the gateway (or blocks at the cap). |
| `webRequest` + `webRequestAuthProvider` | Answer the gateway's proxy 407 with flags and key (`onAuthRequired`, asyncBlocking). |
| `storage` | Settings and key in `storage.local`, run state in `storage.session`, policy in `storage.managed`. |
| `alarms` | Balance polling (1 min) and sticky-session auto-rotation. |
| `scripting` | Register the page-bridge content script only for operator-listed origins. |
| `privacy` | Set `webRTCIPHandlingPolicy` to `disable_non_proxied_udp` while proxying or blocked, so WebRTC cannot reveal the machine's real IP. |
| `host_permissions: <all_urls>` | `onAuthRequired` must see proxy challenges for every URL, and the API/exit-check fetches. |

The `notifications`, `tabs` and `nativeMessaging` permissions are not used. There
are no static content scripts.

## Security notes

- CSP for extension pages: `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`.
- Every API response is size-capped (2 MB), fetched with `redirect: "error"` and
  `credentials: "omit"`, and parsed with recursive `stripDangerousKeys`.
- `dn_live_`, `dn_test_`, `dn_node_` and `dn_proxy_` values and JWTs are scrubbed from every
  error before it reaches the UI or a control reply. The UI shows only the first 8 key chars.
- Exit countries in the OFAC list (CU, IR, KP, RU, SY) are rejected.
