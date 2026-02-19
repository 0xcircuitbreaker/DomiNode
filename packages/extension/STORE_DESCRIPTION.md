# Dominus Node Proxy -- Store Listing Assets

This document contains all text and metadata needed for browser extension store submissions across Chrome Web Store, Firefox Add-ons (AMO), Microsoft Edge Add-ons, and Opera Add-ons.

---

## Short Description (max 132 characters)

```
Dominus Node Proxy - Route traffic through DC & residential proxies with geo-targeting, session control, and real-time tracking.
```

Character count: 131

---

## Full Description

```
Dominus Node Proxy connects your browser to the Dominus Node rotating proxy network. Route all browser traffic through datacenter or residential proxy IPs with a single click.

WHAT IT DOES

Dominus Node Proxy configures your browser to send all HTTP and HTTPS traffic through Dominus Node proxy servers. You authenticate with your Dominus Node account (email/password or API key), select your desired exit country and protocol, and toggle the proxy on. All traffic is then routed through the proxy network, metered by bandwidth, and billed against your prepaid wallet balance.

KEY FEATURES

-- One-Click Proxy Toggle: Enable or disable the proxy instantly from the popup. Connection status is shown via the toolbar badge (green = connected, yellow = low balance, red = error).

-- Dual Protocol Support: Choose between HTTP and SOCKS5 proxy protocols depending on your needs.

-- Geo-Targeting: Select your exit country from 70+ supported countries. Users targeting the United States get additional granularity with state-level and city-level selection (all 50 states, 20 major cities).

-- Sticky Sessions: Enable sticky sessions to maintain the same exit IP across multiple requests. Useful for multi-step workflows that require IP consistency.

-- Automatic IP Rotation: Configure automatic session rotation at intervals of 1, 5, 10, 15, or 30 minutes. The extension generates a new session ID and reconfigures the proxy automatically.

-- Real-Time Balance Tracking: Your Dominus Node wallet balance is displayed in the popup and polled every 2 minutes. If your balance reaches zero, the proxy is automatically disabled and you receive a desktop notification.

-- Low Balance Warnings: Desktop notifications alert you when your balance drops below $1.00 so you can top up before service interruption.

-- WebRTC Leak Protection: A content script overrides RTCPeerConnection to enforce relay-only ICE transport policy on all pages. Additionally, the Chrome privacy API is used to set the WebRTC IP handling policy to "disable non-proxied UDP" while the proxy is active. Both mechanisms prevent your real IP address from being exposed through WebRTC.

-- Two-Factor Authentication: Full support for TOTP authenticator app codes and 8-digit backup codes during login.

-- Auto-Reconnect: If the proxy was enabled when you closed the browser, the extension automatically re-establishes the connection on the next launch (provided you have sufficient balance).

AUTHENTICATION

Sign in using one of two methods:
1. Email and password (your Dominus Node account credentials)
2. API key (paste your dn_live_... key from the Dominus Node dashboard)

Both methods are available from the popup and the full options page.

HOW BILLING WORKS

Dominus Node uses a prepaid wallet model. All bandwidth consumed through the proxy is metered and debited from your wallet balance in real time. Top up your wallet via the Dominus Node web dashboard using credit card (Stripe) or cryptocurrency (BTC, ETH, and other supported currencies via NOWPayments). The extension itself does not process payments -- it only displays your current balance and warns you when it is low.

PRICING

Datacenter proxies: $3.00 per GB
Residential proxies: $5.00 per GB

REQUIREMENTS

A Dominus Node account with a funded wallet is required to use this extension. Create an account at https://dominusnode.com.
```

---

## Feature List (Bullet Format)

For store listings that accept a separate feature/highlight section:

```
- One-click proxy toggle from the browser toolbar
- HTTP and SOCKS5 protocol support
- Geo-targeting with 70+ countries, US state and city selection
- Sticky sessions for consistent IP across requests
- Automatic session rotation (1-30 minute intervals)
- Real-time wallet balance display with 2-minute polling
- WebRTC leak protection (relay-only ICE + privacy API)
- Low balance and zero balance desktop notifications
- Two-factor authentication (TOTP + backup codes)
- Auto-reconnect on browser restart
- Dark theme interface
```

---

## Permissions Justification

The following text explains each requested permission. Include this in the "Justify permissions" field during store submission.

### proxy

Core functionality of the extension. This permission is required to configure the browser's proxy settings so that HTTP and HTTPS traffic is routed through Dominus Node proxy servers. Without this permission, the extension cannot function.

### storage

Used to persist user preferences (selected country, protocol, sticky session settings, rotation interval) and authentication state (encrypted tokens) between browser sessions. The extension stores data only in chrome.storage.local. No data is synced to cloud storage.

### webRequest

Required to intercept HTTP 407 (Proxy Authentication Required) responses. When the proxy server challenges the browser for credentials, this permission allows the extension to supply the user's API key automatically without manual prompting. This is essential for seamless proxy authentication.

### webRequestAuthProvider (Chromium only)

Required by Manifest V3 on Chromium-based browsers to programmatically respond to proxy authentication challenges. This is the MV3 replacement for the blocking webRequest authentication flow. Firefox does not require this permission.

### alarms

Schedules three periodic background tasks: (1) JWT access token refresh every 12 minutes to maintain authentication, (2) wallet balance polling every 2 minutes to keep the displayed balance current and detect zero-balance conditions, and (3) optional session rotation at user-configured intervals. No alarms run more frequently than once per minute.

### notifications

Displays two types of desktop notifications: (1) a low balance warning when the wallet drops below $1.00, and (2) a zero-balance alert when the proxy is automatically disabled due to insufficient funds. Notifications are not used for marketing or promotional purposes.

### privacy

Accesses the chrome.privacy.network.webRTCIPHandlingPolicy setting. When the proxy is enabled, this is set to "disable_non_proxied_udp" to prevent WebRTC from revealing the user's real IP address. When the proxy is disabled, the setting is restored to "default". This is a privacy protection feature, not a data collection mechanism.

### Host permission: <all_urls>

Required for two reasons: (1) The proxy configuration must apply to all URLs so that all browser traffic is routed through the proxy server -- restricting to specific domains would defeat the purpose of a proxy extension. (2) The WebRTC leak prevention content script must inject into all pages at document_start to override RTCPeerConnection before any page scripts can establish direct peer connections.

---

## Privacy Disclosure

Use this text for the privacy practices / data disclosure sections of each store.

### What data the extension collects

- **Authentication credentials**: Email address and authentication tokens are stored locally in chrome.storage.local to maintain your login session. API keys are stored locally to authenticate proxy connections. These credentials are transmitted only to Dominus Node servers (api.dominusnode.com) over HTTPS.

- **Proxy configuration preferences**: Your selected country, protocol, sticky session setting, and rotation interval are stored locally in chrome.storage.local. These settings are not transmitted to any server except as part of the proxy connection username (country and session parameters).

- **Wallet balance**: Your current account balance in cents is fetched from the Dominus Node API and stored locally for display purposes.

### What data the extension does NOT collect

- The extension does not collect browsing history, page content, form data, cookies, or any other user activity data.
- The extension does not track which websites you visit. Traffic routing is handled by the proxy server, not the extension.
- The extension does not contain analytics, telemetry, or tracking code of any kind.
- The extension does not use chrome.storage.sync -- all data stays on your local device.
- The extension does not communicate with any third-party servers. All network requests go exclusively to Dominus Node API endpoints.

### Data transmission

All data transmitted by the extension is sent exclusively to Dominus Node servers (api.dominusnode.com) over HTTPS. The extension does not transmit data to any other servers. The proxy server routes your traffic to your requested destinations but the extension itself has no visibility into that traffic.

### Data retention

Authentication tokens are stored until you log out or they expire. Proxy settings are stored until you change them or uninstall the extension. No data is retained on remote servers by the extension. Server-side data retention is governed by the Dominus Node privacy policy at https://dominusnode.com/privacy.

---

## Category Recommendations

| Store | Primary Category | Secondary Category |
|-------|-----------------|-------------------|
| Chrome Web Store | Productivity | Developer Tools |
| Firefox Add-ons (AMO) | Privacy & Security | -- |
| Microsoft Edge Add-ons | Privacy | Developer Tools |
| Opera Add-ons | Privacy & Security | Developer Tools |

---

## Suggested Tags / Keywords

```
proxy, residential proxy, datacenter proxy, rotating proxy, geo-targeting, SOCKS5, HTTP proxy, IP rotation, WebRTC leak protection, privacy, proxy manager, proxy extension, VPN alternative, web scraping, geo-unblock
```

---

## Store Listing Metadata

| Field | Value |
|-------|-------|
| Extension Name | Dominus Node Proxy |
| Version | 0.1.0 |
| Author / Publisher | Dominus Node |
| Website | https://dominusnode.com |
| Support URL | https://dominusnode.com/support |
| Privacy Policy URL | https://dominusnode.com/privacy |
| Content Rating | Everyone |
| Language | English |
| Manifest Version | 3 |

---

## Screenshot Recommendations

Prepare the following screenshots for store submissions (1280x800 or 640x400 pixels):

1. **Popup - Connected State**: Show the popup with proxy enabled, green "ON" badge, a country selected (e.g., United States), balance displayed, HTTP protocol selected.
2. **Popup - Login Screen**: Show the email/password login tab and the API key login tab.
3. **Options Page - Proxy Settings**: Show the full options page with proxy toggle, country dropdown, protocol selector, sticky session toggle, and rotation interval.
4. **Options Page - Account Section**: Show the account section with email, balance, and logout button.
5. **WebRTC Protection**: Show a WebRTC leak test page confirming no real IP leak while the proxy is active.

---

## Promotional Tile Text (if required)

### Small Tile (440x280)

```
Route all browser traffic through Dominus Node proxies.
70+ countries. HTTP + SOCKS5. WebRTC leak protection.
```

### Large Tile (920x680)

```
Dominus Node Proxy

Datacenter and residential proxies in your browser.
Geo-target 70+ countries with state and city precision.
Sticky sessions, automatic rotation, real-time balance tracking.
WebRTC leak protection built in.
```
