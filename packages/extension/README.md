# Dominus Node Proxy - Browser Extension

Browser extension for routing traffic through the Dominus Node proxy network. Supports datacenter and residential proxy pools with geo-targeting, sticky sessions, automatic IP rotation, real-time wallet balance tracking, and WebRTC leak protection.

## Features

- **Datacenter + Residential Proxy Support** -- Connect through DC proxies ($3/GB) or residential proxies ($5/GB) via HTTP or SOCKS5 protocols.
- **Geo-Targeting** -- Select exit country from 70+ supported countries. US users get additional state-level and city-level targeting (50 states, 20 major cities).
- **Session Management** -- Enable sticky sessions to maintain the same IP across requests. Manual or automatic session rotation on configurable intervals (1, 5, 10, 15, or 30 minutes).
- **Real-Time Balance Tracking** -- Wallet balance polls every 2 minutes. Badge indicator shows connection status, low balance warnings, and auto-disables the proxy when balance reaches zero.
- **WebRTC Leak Protection** -- Content script forces `RTCPeerConnection` to relay-only mode (`iceTransportPolicy: "relay"`), and the `privacy` API sets `webRTCIPHandlingPolicy` to `disable_non_proxied_udp` when the proxy is active. Both mechanisms prevent your real IP from leaking through WebRTC.
- **Two-Factor Authentication** -- Full MFA support including TOTP authenticator codes and backup codes.
- **Dual Authentication** -- Sign in with email/password or paste an API key directly (`dn_live_...`).
- **Auto-Reconnect** -- Proxy connection is automatically restored after browser restarts if it was previously enabled.
- **Low Balance Notifications** -- Desktop notifications warn when balance drops below $1.00 and when it reaches $0.00.
- **Badge Status Indicators** -- Green "ON" badge when connected, yellow "$!" for low balance, red "ERR" for errors.

## Installation

### From Browser Stores

| Browser | Link |
|---------|------|
| Chrome | [Chrome Web Store](https://chrome.google.com/webstore/detail/dominus-node-proxy/) |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/dominus-node-proxy/) |
| Edge | [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/dominus-node-proxy/) |
| Opera | [Opera Add-ons](https://addons.opera.com/en/extensions/details/dominus-node-proxy/) |

### From Source (Development)

1. Clone the repository and navigate to the extension package:

```bash
cd packages/extension
npm install
```

2. Build for your target browser:

```bash
# Build all targets at once
npm run build:all

# Or build for a specific browser
npm run build:chrome
npm run build:firefox
npm run build:opera
npm run build:edge
```

3. Load the unpacked extension:

- **Chrome**: Navigate to `chrome://extensions/`, enable "Developer mode", click "Load unpacked", select `dist/chrome/`.
- **Firefox**: Navigate to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", select `dist/firefox/manifest.json`.
- **Edge**: Navigate to `edge://extensions/`, enable "Developer mode", click "Load unpacked", select `dist/edge/`.
- **Opera**: Navigate to `opera://extensions/`, enable "Developer mode", click "Load unpacked", select `dist/opera/`.

## Build Targets

Each build target produces a self-contained directory under `dist/<browser>/` with the compiled manifest, scripts, HTML pages, CSS, and icons.

| Target | Command | Output | Notes |
|--------|---------|--------|-------|
| Chrome | `npm run build:chrome` | `dist/chrome/` | MV3 service worker, `webRequestAuthProvider` permission |
| Firefox | `npm run build:firefox` | `dist/firefox/` | MV3 background scripts (not service worker), `browser_specific_settings` with gecko ID, no `webRequestAuthProvider` |
| Edge | `npm run build:edge` | `dist/edge/` | Same manifest structure as Chrome |
| Opera | `npm run build:opera` | `dist/opera/` | Same manifest structure as Chrome |

All builds use esbuild with ESM output format, ES2022 target, and Preact JSX. Production builds (`NODE_ENV=production`) are minified with no sourcemaps.

## Tech Stack

- **UI Framework**: Preact 10 (lightweight React alternative, ~3KB)
- **Language**: TypeScript (strict mode)
- **Bundler**: esbuild
- **Testing**: Vitest
- **Manifest**: MV3 (Manifest V3)
- **Popup**: Preact SPA for quick proxy toggle, country selection, protocol switching
- **Options Page**: Full-page Preact SPA with advanced settings (rotation interval, all countries, session management)

## Project Structure

```
packages/extension/
├── build.mjs                    # esbuild build script
├── package.json                 # Dependencies and build scripts
├── tsconfig.json                # TypeScript configuration
├── vitest.config.ts             # Test configuration
├── manifests/
│   ├── chrome.json              # Chrome/Chromium manifest
│   ├── firefox.json             # Firefox manifest (gecko settings)
│   ├── edge.json                # Edge manifest
│   └── opera.json               # Opera manifest
├── src/
│   ├── adapters/
│   │   ├── chromium-proxy.ts    # Chrome/Edge/Opera proxy API adapter
│   │   └── firefox-proxy.ts     # Firefox proxy API adapter
│   ├── assets/icons/            # Extension icons (16, 48, 128px)
│   ├── background/
│   │   ├── index.ts             # Service worker entrypoint, message router, alarms
│   │   ├── auth-manager.ts      # Login, logout, MFA, token refresh
│   │   ├── balance-poller.ts    # Periodic wallet balance polling
│   │   ├── badge-manager.ts     # Badge text/color updates
│   │   ├── proxy-controller.ts  # Enable/disable/reconfigure proxy
│   │   └── token-refresher.ts   # JWT access token auto-refresh
│   ├── content/
│   │   └── webrtc-block.ts      # WebRTC leak prevention (MAIN world)
│   ├── options/
│   │   ├── index.html           # Options page shell
│   │   ├── index.tsx            # Options page Preact entrypoint
│   │   └── App.tsx              # Full settings UI
│   ├── popup/
│   │   ├── index.html           # Popup shell
│   │   ├── index.tsx            # Popup Preact entrypoint
│   │   ├── App.tsx              # Main popup UI (login, proxy toggle, geo)
│   │   └── useExtensionState.ts # Shared state hook
│   ├── shared/
│   │   ├── api-client.ts        # HTTP client for Dominus Node REST API
│   │   ├── constants.ts         # API URLs, ports, alarm names, thresholds
│   │   ├── proxy-config.ts      # Proxy username builder, session ID generator
│   │   ├── state.ts             # Extension state persistence (chrome.storage)
│   │   └── types.ts             # TypeScript interfaces and message types
│   └── ui/
│       ├── countries.ts         # Country, state, city option lists
│       └── styles.css           # Shared dark-theme CSS
└── dist/                        # Build output (gitignored)
    ├── chrome/
    ├── firefox/
    ├── edge/
    └── opera/
```

## Permissions Explained

| Permission | Reason |
|------------|--------|
| `proxy` | Core functionality. Configures the browser's proxy settings to route traffic through Dominus Node servers. |
| `storage` | Persists user preferences, authentication state, and proxy configuration between browser sessions. |
| `webRequest` | Intercepts proxy authentication challenges (HTTP 407 responses) to supply credentials automatically. |
| `webRequestAuthProvider` | (Chromium only) Required by MV3 to provide proxy authentication credentials in response to 407 challenges. |
| `alarms` | Schedules periodic tasks: JWT token refresh (every 12 minutes), wallet balance polling (every 2 minutes), and optional session rotation. |
| `notifications` | Displays desktop alerts for low balance warnings ($1.00 threshold) and zero-balance proxy auto-disable. |
| `privacy` | Accesses `chrome.privacy.network.webRTCIPHandlingPolicy` to disable non-proxied UDP when the proxy is active, preventing WebRTC IP leaks. |
| `<all_urls>` (host permission) | Routes all browser HTTP/HTTPS traffic through the configured proxy server. Also required for the WebRTC leak prevention content script to run on all pages. |

## Supported Browsers

| Browser | Minimum Version | Manifest | Notes |
|---------|----------------|----------|-------|
| Chrome | 88+ | MV3 | Full support including `webRequestAuthProvider` |
| Firefox | 109+ | MV3 | Uses `browser_specific_settings` with gecko ID `proxy@dominusnode.com` |
| Edge | 88+ | MV3 | Chromium-based, same capabilities as Chrome |
| Opera | 74+ | MV3 | Chromium-based, same capabilities as Chrome |

## Running Tests

```bash
npm run test
```

Tests use Vitest with Chrome extension API mocks. Coverage includes the background service worker message handler, proxy controller, auth manager, API client, and state management.

## License

MIT
