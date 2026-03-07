# DomiNode Browser Extension

Team: **Frontend**

MV3 browser extension for Chrome, Firefox, Opera, Edge. Built with esbuild.

## Rules
- Proxy username: HYPHENS not underscores (country-US not country_US)
- safeJson: throws on empty body instead of returning undefined
- Removed 0.0.0.0 from localhost allowlist
- Path validation required on all file/URL inputs
- Extension storage: use chrome.storage.local, not localStorage
