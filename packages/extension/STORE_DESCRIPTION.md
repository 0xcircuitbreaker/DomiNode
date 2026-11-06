# DominusNode Agent Companion

Routes an automated or headless Chromium profile through the DominusNode gateway, which
gives AI agents' browser traffic country, IP class (residential/dc/mobile) and sticky-session
routing.

- Per-run spend cap. When it is reached, traffic is blocked, never sent direct.
- Preconfigure through an enterprise policy or a one-time import. No UI is needed for
  Playwright or Puppeteer runs.
- An allowlisted control channel lets an automation driver change routing mid-run.
- Shows your relay nodes, tier progress and credits, with exact steps to contribute a machine.
- Plaintext HTTP is opt-in only, with an exit-visible warning.
- The API key is stored locally, never synced, and never exposed to pages or other extensions.
- Prices are loaded live from the API.
