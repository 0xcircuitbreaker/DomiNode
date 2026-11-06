import { AccountClient, readCapped } from "../shared/api-client.js";
import { ALARMS, BALANCE_POLL_MINUTES } from "../shared/constants.js";
import type { ControlCommand } from "../shared/control.js";
import { buildUsername, newSessionId } from "../shared/flags.js";
import { safeParse } from "../shared/json.js";
import { loadManagedConfig, parseConfig } from "../shared/managed-config.js";
import { keyPrefix, scrubCredentials } from "../shared/scrub.js";
import { assertGatewayTransport, isLocalGateway, validateSettingsPatch, type Settings } from "../shared/settings.js";
import { applyBalanceSample, newRun, type RunState } from "../shared/spend.js";
import { buildPac, clearProxy, setPac, verifyPac, type GatewayCreds } from "./proxy.js";
import * as store from "./store.js";

/** "error": the PAC could not be applied/verified, so traffic may not be proxied. */
export type Mode = "off" | "proxying" | "blocked" | "no_key" | "error";

export interface ExitInfo {
  country: string | null;
  ip: string | null;
  checkedAt: number;
  exitVisible: boolean;
}

/** Status safe to show anywhere: never contains the API key. */
export interface Status {
  mode: Mode;
  hasApiKey: boolean;
  keyPrefix: string;
  username: string;
  settings: Settings;
  managedKeys: string[];
  run: RunState;
  exit: ExitInfo | null;
  lastError: string | null;
}

/** Narrower status for control channels (no allowlists, endpoints or key prefix). */
export interface ControlStatus {
  mode: Mode;
  username: string;
  country: string | null;
  ipClass: string | null;
  sticky: boolean;
  sessionId: string | null;
  plaintext: boolean;
  exitVisible: boolean;
  spentCents: number;
  spendCapCents: number | null;
  balanceCents: number | null;
  blockReason: string | null;
  /** Why the proxy setting could not be applied/verified (mode "error"). */
  proxyError: string | null;
}

export class Controller {
  settings!: Settings;
  private apiKey: string | null = null;
  run: RunState = newRun();
  exit: ExitInfo | null = null;
  lastError: string | null = null;
  managedKeys: string[] = [];
  private account: AccountClient | null = null;
  private onChange: (() => void) | null = null;
  /** Set when the proxy setting could not be applied or verified (cleared on success). */
  proxyError: string | null = null;
  /** PAC last pushed into chrome.proxy (null when cleared). */
  private appliedPac: string | null = null;

  async init(): Promise<void> {
    this.settings = await store.loadSettings();
    this.apiKey = await store.loadApiKey();
    this.run = await store.loadRun();
    await this.applyManaged();
    await this.apply();
  }

  setChangeListener(fn: () => void): void {
    this.onChange = fn;
  }

  /** Enterprise policy wins over locally stored values for the keys it sets. */
  async applyManaged(): Promise<void> {
    const m = await loadManagedConfig();
    this.managedKeys = Object.keys(m.settings);
    if (m.apiKey) {
      this.managedKeys.push("apiKey");
      if (m.apiKey !== this.apiKey) {
        this.apiKey = m.apiKey;
        await store.saveApiKey(m.apiKey);
      }
    }
    if (m.errors.length) this.lastError = scrubCredentials(`Managed policy: ${m.errors.join("; ")}`);
    if (this.managedKeys.length) {
      this.settings = { ...this.settings, ...m.settings };
      this.ensureSession();
      await store.saveSettings(this.settings);
    }
  }

  get mode(): Mode {
    if (!this.settings.enabled) return "off";
    if (this.proxyError) return "error";
    if (!this.apiKey) return "no_key";
    if (this.run.blocked) return "blocked";
    return "proxying";
  }

  username(): string {
    return buildUsername(this.settings);
  }

  /** Read by the onAuthRequired handler. */
  creds(): GatewayCreds | null {
    if (!this.settings?.enabled) return null;
    if (this.proxyError) {
      return { host: this.settings.gatewayHost, port: this.settings.gatewayPort, auth: null };
    }
    const insecure = !this.settings.gatewayTls && !isLocalGateway(this.settings.gatewayHost);
    const blocked = !this.apiKey || this.run.blocked || insecure;
    return {
      host: this.settings.gatewayHost,
      port: this.settings.gatewayPort,
      auth: blocked ? null : { username: this.username(), password: this.apiKey as string },
    };
  }

  private apiHost(): string {
    return new URL(this.settings.apiBase).hostname;
  }

  private client(): AccountClient | null {
    if (!this.apiKey) return null;
    this.account ??= new AccountClient(this.settings.apiBase, this.apiKey);
    return this.account;
  }

  /** Push current settings into chrome.proxy, badge and alarms. */
  async apply(): Promise<void> {
    this.proxyError = null;
    const mode = this.mode;
    try {
      if (mode === "off") {
        this.appliedPac = null;
        await clearProxy();
      } else {
        // no_key and blocked both fail closed: traffic never leaves DIRECT.
        const pacMode = mode === "proxying" ? "proxy" : "block";
        const { gatewayHost, gatewayPort, gatewayTls } = this.settings;
        let pac: string;
        try {
          pac = buildPac(pacMode, gatewayHost, gatewayPort, this.apiHost(), gatewayTls);
        } catch (err) {
          // Refused transport: fail closed (block), never DIRECT and never plaintext creds.
          this.lastError = scrubCredentials(err);
          pac = buildPac("block", gatewayHost, gatewayPort, this.apiHost(), true);
        }
        this.appliedPac = pac;
        await setPac(pac);
      }
    } catch (err) {
      this.lastError = scrubCredentials(err);
      if (mode !== "off") this.proxyError = this.lastError;
    }
    await this.updateBadge();
    await this.scheduleAlarms();
    this.onChange?.();
  }

  /** chrome.proxy.settings.onChange: re-check that our PAC is still the one in effect. */
  async reverifyProxy(): Promise<void> {
    if (!this.settings?.enabled || !this.appliedPac) return;
    const before = this.proxyError;
    try {
      await verifyPac(this.appliedPac);
      this.proxyError = null;
    } catch (err) {
      this.proxyError = scrubCredentials(err);
      this.lastError = this.proxyError;
    }
    if (before !== this.proxyError) {
      await this.updateBadge();
      this.onChange?.();
    }
  }

  private async updateBadge(): Promise<void> {
    const badge: Record<Mode, [string, string]> = {
      off: ["", "#6b7280"],
      proxying: ["ON", "#16a34a"],
      blocked: ["STOP", "#dc2626"],
      no_key: ["KEY", "#d97706"],
      error: ["ERR", "#dc2626"],
    };
    const [text, color] = badge[this.mode];
    try {
      await chrome.action.setBadgeText({ text });
      await chrome.action.setBadgeBackgroundColor({ color });
    } catch {
      /* action API missing in tests */
    }
  }

  private async scheduleAlarms(): Promise<void> {
    if (this.mode === "proxying" || this.mode === "blocked" || this.mode === "error") {
      chrome.alarms.create(ALARMS.BALANCE, { periodInMinutes: BALANCE_POLL_MINUTES });
    } else await chrome.alarms.clear(ALARMS.BALANCE);
    if (this.settings.sticky && this.settings.rotateMinutes > 0) {
      const existing = await chrome.alarms.get(ALARMS.ROTATE);
      if (existing?.periodInMinutes !== this.settings.rotateMinutes) {
        chrome.alarms.create(ALARMS.ROTATE, { periodInMinutes: this.settings.rotateMinutes });
      }
    } else await chrome.alarms.clear(ALARMS.ROTATE);
  }

  private ensureSession(): void {
    if (this.settings.sticky && !this.settings.sessionId) this.settings.sessionId = newSessionId();
  }

  /**
   * @param scope "operator" (own pages, import): enabling starts a fresh run (new spend
   *   baseline, block lifted). "control": enabling keeps the current run, so a control
   *   driver cannot reset the spend cap by toggling disable/enable.
   */
  async updateSettings(patch: Partial<Settings>, scope: "operator" | "control" = "operator"): Promise<void> {
    const prevBase = this.settings.apiBase;
    const wasEnabled = this.settings.enabled;
    assertGatewayTransport({ ...this.settings, ...patch });
    this.settings = { ...this.settings, ...patch };
    this.ensureSession();
    if (this.settings.apiBase !== prevBase) this.account = null;
    // An operator enable starts a fresh run (spend baseline); a control enable never does.
    if (scope === "operator" && !wasEnabled && this.settings.enabled) await this.resetRun(false);
    await store.saveSettings(this.settings);
    await this.apply();
    if (!wasEnabled && this.settings.enabled) void this.pollBalance();
  }

  async setApiKey(key: string | null): Promise<void> {
    await store.saveApiKey(key);
    this.apiKey = key;
    this.account = null;
    await this.resetRun(false);
    await this.apply();
    if (key) void this.pollBalance();
  }

  async rotateSession(scope: "operator" | "control" = "operator"): Promise<void> {
    await this.updateSettings({ sticky: true, sessionId: newSessionId() }, scope);
    this.exit = null;
  }

  async resetRun(applyNow = true): Promise<void> {
    this.run = newRun();
    await store.saveRun(this.run);
    if (applyNow) {
      await this.apply();
      void this.pollBalance();
    }
  }

  /** Sample the wallet balance; stops proxying (fail closed) when the cap is hit. */
  async pollBalance(): Promise<void> {
    const c = this.client();
    if (!c) return;
    try {
      const bal = await c.balanceCents();
      const wasBlocked = this.run.blocked;
      this.run = applyBalanceSample(this.run, bal, this.settings.spendCapCents);
      await store.saveRun(this.run);
      if (this.run.blocked !== wasBlocked) await this.apply();
      else this.onChange?.();
    } catch (err) {
      this.run = { ...this.run, lastError: scrubCredentials(err) };
      await store.saveRun(this.run);
      this.onChange?.();
    }
  }

  /** Fetch exitCheckUrl through the proxy and record the reported exit country. */
  async checkExit(): Promise<ExitInfo> {
    const url = this.settings.exitCheckUrl;
    if (!url) throw new Error("Set an exit check URL in options first");
    if (this.mode !== "proxying") throw new Error("Proxy is not active");
    const res = await fetch(url, { redirect: "error", credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(20_000) });
    const text = await readCapped(res, 64 * 1024);
    const data = safeParse(text, 64 * 1024) as Record<string, unknown>;
    const pick = (...keys: string[]) => {
      for (const k of keys) if (typeof data[k] === "string" && (data[k] as string).length <= 64) return data[k] as string;
      return null;
    };
    const country = pick("country", "country_code", "countryCode");
    this.exit = {
      country: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : country,
      ip: pick("ip", "query", "origin"),
      checkedAt: Date.now(),
      exitVisible: res.headers.get("x-dominusnode-exit-visible") === "1",
    };
    this.onChange?.();
    return this.exit;
  }

  /** One-time import (options page or CDP). Strict: any bad key rejects the whole import. */
  async importConfig(raw: unknown): Promise<void> {
    const cfg = parseConfig(raw, "strict");
    const locked = cfg.settings;
    for (const k of this.managedKeys) delete (locked as Record<string, unknown>)[k];
    if (cfg.apiKey && !this.managedKeys.includes("apiKey")) {
      await store.saveApiKey(cfg.apiKey);
      this.apiKey = cfg.apiKey;
      this.account = null;
    }
    await this.updateSettings(locked);
  }

  /** Operator settings change (own options/popup pages). Managed keys stay locked. */
  async operatorUpdate(raw: unknown): Promise<void> {
    const patch = validateSettingsPatch(raw, "operator");
    for (const k of Object.keys(patch)) {
      if (this.managedKeys.includes(k)) throw new Error(`${k} is set by enterprise policy`);
    }
    await this.updateSettings(patch);
  }

  async handleControl(cmd: ControlCommand): Promise<ControlStatus> {
    switch (cmd.type) {
      case "getStatus":
        break;
      case "setSettings":
        await this.updateSettings(cmd.settings, "control");
        break;
      case "rotateSession":
        await this.rotateSession("control");
        break;
      case "enable":
        await this.updateSettings({ enabled: true }, "control");
        break;
      case "disable":
        await this.updateSettings({ enabled: false }, "control");
        break;
    }
    return this.controlStatus();
  }

  status(): Status {
    return {
      mode: this.mode,
      hasApiKey: !!this.apiKey,
      keyPrefix: keyPrefix(this.apiKey),
      username: this.username(),
      settings: { ...this.settings },
      managedKeys: [...this.managedKeys],
      run: { ...this.run },
      exit: this.exit,
      lastError: this.lastError,
    };
  }

  controlStatus(): ControlStatus {
    const s = this.settings;
    return {
      mode: this.mode,
      username: this.username(),
      country: s.country,
      ipClass: s.ipClass,
      sticky: s.sticky,
      sessionId: s.sticky ? s.sessionId : null,
      plaintext: s.plaintext,
      exitVisible: s.plaintext,
      spentCents: this.run.spentCents,
      spendCapCents: s.spendCapCents,
      balanceCents: this.run.lastBalanceCents,
      blockReason: this.run.blockReason,
      proxyError: this.proxyError,
    };
  }

  /** For the options page (Nodes / Pricing tabs). */
  accountClient(): AccountClient {
    const c = this.client();
    if (!c) throw new Error("Set an API key first");
    return c;
  }

  get apiBase(): string {
    return this.settings.apiBase;
  }
}
