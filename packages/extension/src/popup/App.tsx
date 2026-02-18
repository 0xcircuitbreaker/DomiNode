import { useState } from "preact/hooks";
import { useExtensionState } from "./useExtensionState.js";
import { TOP_COUNTRIES, US_STATES, MAJOR_US_CITIES } from "../ui/countries.js";
import { LOW_BALANCE_THRESHOLD_CENTS } from "../shared/constants.js";

export function App() {
  const { state, loading, error, sendMessage } = useExtensionState();

  if (loading) {
    return <div class="spinner" />;
  }

  if (!state) {
    return (
      <div class="stack" style={{ padding: "16px" }}>
        <div class="error-banner">{error ?? "Failed to load extension state"}</div>
      </div>
    );
  }

  // MFA pending — show verification screen
  if (state.mfaPending) {
    return <MfaView error={error} sendMessage={sendMessage} />;
  }

  // R31 C-2: Prefer isAuthenticated from sanitized state (tokens are stripped by sanitizeStateForUI)
  const isAuthenticated = !!(state as any).isAuthenticated || !!(state.accessToken || state.apiKey);

  return isAuthenticated ? (
    <AuthenticatedView state={state} error={error} sendMessage={sendMessage} />
  ) : (
    <LoginView error={error} sendMessage={sendMessage} />
  );
}

// ─── MFA Verification View ─────────────────────────────────────
interface MfaViewProps {
  error: string | null;
  sendMessage: (type: string, payload?: unknown) => Promise<unknown>;
}

function MfaView({ error, sendMessage }: MfaViewProps) {
  const [code, setCode] = useState("");
  const [isBackupCode, setIsBackupCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setSubmitting(true);
    await sendMessage("VERIFY_MFA", { code, isBackupCode });
    setSubmitting(false);
  };

  return (
    <div class="stack" style={{ padding: "16px" }}>
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <div style={{ fontSize: "20px", fontWeight: "700", color: "var(--accent)" }}>
          Dominus Node
        </div>
        <div class="text-sm text-muted">Two-Factor Authentication</div>
      </div>

      {error && <div class="error-banner">{error}</div>}

      <form class="stack-sm" onSubmit={handleSubmit}>
        <div class="text-sm text-muted">
          {isBackupCode ? "Enter your 8-digit backup code" : "Enter the 6-digit code from your authenticator app"}
        </div>
        <input
          class="input"
          type="text"
          inputMode="numeric"
          placeholder={isBackupCode ? "00000000" : "000000"}
          value={code}
          maxLength={isBackupCode ? 8 : 6}
          onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ""))}
          required
          style={{ textAlign: "center", fontSize: "18px", letterSpacing: "4px" }}
        />
        <button
          class="btn btn-primary btn-full"
          type="submit"
          disabled={submitting || code.length < (isBackupCode ? 8 : 6)}
        >
          {submitting ? "Verifying..." : "Verify"}
        </button>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <button
            class="btn btn-secondary btn-sm"
            type="button"
            onClick={() => { setIsBackupCode(!isBackupCode); setCode(""); }}
          >
            {isBackupCode ? "Use app code" : "Use backup code"}
          </button>
          <button
            class="btn btn-secondary btn-sm"
            type="button"
            onClick={() => sendMessage("LOGOUT")}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Login View ──────────────────────────────────────────────────
interface LoginViewProps {
  error: string | null;
  sendMessage: (type: string, payload?: unknown) => Promise<unknown>;
}

function LoginView({ error, sendMessage }: LoginViewProps) {
  const [tab, setTab] = useState<"email" | "apikey">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleEmailLogin = async (e: Event) => {
    e.preventDefault();
    setSubmitting(true);
    await sendMessage("LOGIN", { email, password });
    setSubmitting(false);
  };

  const handleKeyLogin = async (e: Event) => {
    e.preventDefault();
    setSubmitting(true);
    await sendMessage("LOGIN_WITH_KEY", { apiKey });
    setSubmitting(false);
  };

  return (
    <div class="stack" style={{ padding: "16px" }}>
      <div style={{ textAlign: "center", padding: "8px 0" }}>
        <div style={{ fontSize: "20px", fontWeight: "700", color: "var(--accent)" }}>
          Dominus Node
        </div>
        <div class="text-sm text-muted">Residential Proxy Network</div>
      </div>

      <div class="tab-group">
        <button
          class={`tab ${tab === "email" ? "active" : ""}`}
          onClick={() => setTab("email")}
        >
          Email
        </button>
        <button
          class={`tab ${tab === "apikey" ? "active" : ""}`}
          onClick={() => setTab("apikey")}
        >
          API Key
        </button>
      </div>

      {error && <div class="error-banner">{error}</div>}

      {tab === "email" ? (
        <form class="stack-sm" onSubmit={handleEmailLogin}>
          <input
            class="input"
            type="email"
            placeholder="Email"
            value={email}
            onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            required
          />
          <input
            class="input"
            type="password"
            placeholder="Password"
            value={password}
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
            required
          />
          <button
            class="btn btn-primary btn-full"
            type="submit"
            disabled={submitting || !email || !password}
          >
            {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>
      ) : (
        <form class="stack-sm" onSubmit={handleKeyLogin}>
          <input
            class="input"
            type="text"
            placeholder="dn_live_..."
            value={apiKey}
            onInput={(e) => setApiKey((e.target as HTMLInputElement).value)}
            required
          />
          <div class="text-sm text-muted">
            Paste your API key from the Dominus Node dashboard
          </div>
          <button
            class="btn btn-primary btn-full"
            type="submit"
            disabled={submitting || !apiKey.startsWith("dn_live_")}
          >
            {submitting ? "Connecting..." : "Connect"}
          </button>
        </form>
      )}

      <button
        class="btn btn-secondary btn-sm"
        style={{ alignSelf: "center" }}
        onClick={() => chrome.runtime.openOptionsPage()}
      >
        Settings
      </button>
    </div>
  );
}

// ─── Authenticated View ──────────────────────────────────────────
interface AuthenticatedViewProps {
  state: import("../shared/types.js").ExtensionState;
  error: string | null;
  sendMessage: (type: string, payload?: unknown) => Promise<unknown>;
}

function AuthenticatedView({ state, error, sendMessage }: AuthenticatedViewProps) {
  const [toggling, setToggling] = useState(false);

  const balanceDollars = (state.balanceCents / 100).toFixed(2);
  const balanceClass =
    state.balanceCents === 0 ? "balance zero" :
    state.balanceCents < LOW_BALANCE_THRESHOLD_CENTS ? "balance low" :
    "balance";

  const statusText = state.isConnected
    ? `Connected via ${state.proxyProtocol.toUpperCase()} to ${state.country}`
    : "Disconnected";

  const handleToggle = async () => {
    setToggling(true);
    await sendMessage("TOGGLE_PROXY");
    setToggling(false);
  };

  // Filter cities by selected state
  const availableCities = state.country === "US" && state.state
    ? MAJOR_US_CITIES.filter((c) => {
        const matchingState = US_STATES.find((s) => s.slug === state.state);
        return matchingState && c.stateCode === matchingState.code;
      })
    : [];

  return (
    <div>
      {/* Header */}
      <div class="header">
        <span class="header-title">Dominus Node</span>
        <span class="header-email" title={state.email ?? "API Key"}>{state.email ?? "API Key"}</span>
      </div>

      <div class="stack" style={{ padding: "12px 16px" }}>
        {/* Balance */}
        <div class="row-between">
          <div>
            <div class="text-sm text-muted">Balance</div>
            <div class={balanceClass}>${balanceDollars}</div>
          </div>
          <button
            class="btn btn-secondary btn-sm"
            onClick={() => sendMessage("REFRESH_BALANCE")}
          >
            Refresh
          </button>
        </div>

        {/* Proxy Toggle */}
        <div
          class={`proxy-toggle ${state.proxyEnabled ? "active" : ""}`}
          onClick={toggling ? undefined : handleToggle}
        >
          <div>
            <div style={{ fontWeight: "600" }}>
              {state.proxyEnabled ? "Proxy ON" : "Proxy OFF"}
            </div>
            <div class="text-sm text-muted">{statusText}</div>
          </div>
          <div class="row" style={{ gap: "12px" }}>
            <div class="proxy-toggle-indicator" />
            <label class="toggle">
              <input
                type="checkbox"
                checked={state.proxyEnabled}
                onChange={handleToggle}
                disabled={toggling}
              />
              <span class="toggle-slider" />
            </label>
          </div>
        </div>

        {/* Error */}
        {(error || state.lastError) && (
          <div class="error-banner">{error ?? state.lastError}</div>
        )}

        {/* Country */}
        <div class="row-between">
          <label class="text-sm text-muted">Country</label>
          <select
            class="select"
            style={{ width: "auto", minWidth: "160px" }}
            value={state.country}
            onChange={(e) =>
              sendMessage("SET_COUNTRY", (e.target as HTMLSelectElement).value)
            }
          >
            {TOP_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* State (US only) */}
        {state.country === "US" && (
          <div class="row-between">
            <label class="text-sm text-muted">State</label>
            <select
              class="select"
              style={{ width: "auto", minWidth: "160px" }}
              value={state.state}
              onChange={(e) =>
                sendMessage("SET_STATE", (e.target as HTMLSelectElement).value)
              }
            >
              <option value="">Any State</option>
              {US_STATES.map((s) => (
                <option key={s.code} value={s.slug}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* City (US only, when state is selected) */}
        {state.country === "US" && state.state && availableCities.length > 0 && (
          <div class="row-between">
            <label class="text-sm text-muted">City</label>
            <select
              class="select"
              style={{ width: "auto", minWidth: "160px" }}
              value={state.city}
              onChange={(e) =>
                sendMessage("SET_CITY", (e.target as HTMLSelectElement).value)
              }
            >
              <option value="">Any City</option>
              {availableCities.map((c) => (
                <option key={c.slug} value={c.slug}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Protocol */}
        <div class="row-between">
          <label class="text-sm text-muted">Protocol</label>
          <div class="tab-group" style={{ width: "auto" }}>
            <button
              class={`tab ${state.proxyProtocol === "http" ? "active" : ""}`}
              onClick={() => sendMessage("SET_PROTOCOL", "http")}
            >
              HTTP
            </button>
            <button
              class={`tab ${state.proxyProtocol === "socks5" ? "active" : ""}`}
              onClick={() => sendMessage("SET_PROTOCOL", "socks5")}
            >
              SOCKS5
            </button>
          </div>
        </div>

        {/* Sticky Session */}
        <div class="row-between">
          <label class="text-sm text-muted">Sticky Session</label>
          <label class="toggle">
            <input
              type="checkbox"
              checked={state.stickySession}
              onChange={() => sendMessage("SET_STICKY", !state.stickySession)}
            />
            <span class="toggle-slider" />
          </label>
        </div>
      </div>

      {/* Footer */}
      <div class="footer">
        <button
          class="icon-btn"
          title="Settings"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          &#9881;
        </button>
        <button
          class="btn btn-danger btn-sm"
          onClick={() => sendMessage("LOGOUT")}
        >
          Logout
        </button>
      </div>
    </div>
  );
}
