import { useState } from "preact/hooks";
import { useExtensionState } from "../popup/useExtensionState.js";
import { ALL_COUNTRIES } from "../ui/countries.js";
import { LOW_BALANCE_THRESHOLD_CENTS } from "../shared/constants.js";

// Truncate error messages to prevent UI overflow and potential content injection
const MAX_ERROR_LENGTH = 200;
function truncateError(msg: string | null | undefined): string {
  if (!msg) return "";
  if (msg.length <= MAX_ERROR_LENGTH) return msg;
  return msg.slice(0, MAX_ERROR_LENGTH) + "...";
}

const ROTATION_OPTIONS = [
  { value: 0, label: "Off" },
  { value: 1, label: "1 min" },
  { value: 5, label: "5 min" },
  { value: 10, label: "10 min" },
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
];

export function App() {
  const { state, loading, error, sendMessage } = useExtensionState();

  if (loading) {
    return (
      <div class="options-container">
        <div class="spinner" />
      </div>
    );
  }

  if (!state) {
    return (
      <div class="options-container">
        <div class="error-banner">{truncateError(error) || "Failed to load extension state"}</div>
      </div>
    );
  }

  // Prefer isAuthenticated from sanitized state (tokens are stripped by sanitizeStateForUI)
  const isAuthenticated = !!(state as any).isAuthenticated || !!(state.accessToken || state.apiKey);

  return (
    <div class="options-container">
      <h1 style={{ fontSize: "24px", fontWeight: "700", color: "var(--accent)", marginBottom: "24px" }}>
        Dominus Node Settings
      </h1>

      {error && <div class="error-banner" style={{ marginBottom: "16px" }}>{truncateError(error)}</div>}

      {isAuthenticated ? (
        <AuthenticatedSettings state={state} error={error} sendMessage={sendMessage} />
      ) : (
        <LoginSection error={error} sendMessage={sendMessage} />
      )}
    </div>
  );
}

// ─── Login Section ───────────────────────────────────────────────
interface LoginSectionProps {
  error: string | null;
  sendMessage: (type: string, payload?: unknown) => Promise<unknown>;
}

function LoginSection({ error, sendMessage }: LoginSectionProps) {
  const [tab, setTab] = useState<"email" | "apikey">("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleEmailLogin = async (e: Event) => {
    e.preventDefault();
    setSubmitting(true);
    await sendMessage("LOGIN", { email, password });
    setPassword(""); // Clear credential from component state immediately
    setSubmitting(false);
  };

  const handleKeyLogin = async (e: Event) => {
    e.preventDefault();
    setSubmitting(true);
    await sendMessage("LOGIN_WITH_KEY", { apiKey });
    setApiKey(""); // Clear credential from component state immediately
    setSubmitting(false);
  };

  return (
    <div class="section">
      <div class="section-title">Login</div>
      <div class="card stack">
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

        {error && <div class="error-banner">{truncateError(error)}</div>}

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
              class="btn btn-primary"
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
              class="btn btn-primary"
              type="submit"
              disabled={submitting || !apiKey.startsWith("dn_live_")}
            >
              {submitting ? "Connecting..." : "Connect with API Key"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Authenticated Settings ──────────────────────────────────────
interface AuthenticatedSettingsProps {
  state: import("../shared/types.js").ExtensionState;
  error: string | null;
  sendMessage: (type: string, payload?: unknown) => Promise<unknown>;
}

function AuthenticatedSettings({ state, sendMessage }: AuthenticatedSettingsProps) {
  const balanceDollars = (state.balanceCents / 100).toFixed(2);
  const balanceClass =
    state.balanceCents === 0 ? "balance zero" :
    state.balanceCents < LOW_BALANCE_THRESHOLD_CENTS ? "balance low" :
    "balance";

  return (
    <>
      {/* Account */}
      <div class="section">
        <div class="section-title">Account</div>
        <div class="card stack-sm">
          <div class="row-between">
            <div>
              <div class="text-sm text-muted">Email</div>
              <div>{state.email ?? "API Key authentication"}</div>
            </div>
          </div>
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
          <button
            class="btn btn-danger btn-sm"
            style={{ alignSelf: "flex-start" }}
            onClick={() => sendMessage("LOGOUT")}
          >
            Logout
          </button>
        </div>
      </div>

      {/* Proxy Settings */}
      <div class="section">
        <div class="section-title">Proxy Settings</div>
        <div class="card stack-sm">
          {/* Proxy Toggle */}
          <div class="label-row">
            <label>Proxy Enabled</label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={state.proxyEnabled}
                onChange={() => sendMessage("TOGGLE_PROXY")}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          {/* Country */}
          <div class="label-row">
            <label>Country</label>
            <select
              class="select"
              style={{ width: "auto", minWidth: "200px" }}
              value={state.country}
              onChange={(e) =>
                sendMessage("SET_COUNTRY", (e.target as HTMLSelectElement).value)
              }
            >
              {ALL_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name} ({c.code})
                </option>
              ))}
            </select>
          </div>

          {/* Protocol */}
          <div class="label-row">
            <label>Protocol</label>
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
          <div class="label-row">
            <label>Sticky Session</label>
            <label class="toggle">
              <input
                type="checkbox"
                checked={state.stickySession}
                onChange={() => sendMessage("SET_STICKY", !state.stickySession)}
              />
              <span class="toggle-slider" />
            </label>
          </div>

          {/* Rotation Interval */}
          <div class="label-row">
            <label>Auto-Rotate</label>
            <select
              class="select"
              style={{ width: "auto", minWidth: "120px" }}
              value={state.rotationIntervalMinutes}
              onChange={(e) =>
                sendMessage("SET_ROTATION", Number((e.target as HTMLSelectElement).value))
              }
            >
              {ROTATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Session Controls */}
      <div class="section">
        <div class="section-title">Session</div>
        <div class="card stack-sm">
          <div class="row-between">
            <div>
              <div class="text-sm text-muted">Session ID</div>
              <div style={{ fontFamily: "monospace", fontSize: "13px" }}>
                {state.sessionId ?? "None (rotating)"}
              </div>
            </div>
            <button
              class="btn btn-secondary btn-sm"
              onClick={() => sendMessage("ROTATE_SESSION")}
              disabled={!state.stickySession}
            >
              Rotate Now
            </button>
          </div>
          <div class="row-between">
            <div>
              <div class="text-sm text-muted">Status</div>
              <div>
                {state.isConnected ? (
                  <span class="text-success">Connected</span>
                ) : (
                  <span class="text-muted">Disconnected</span>
                )}
                {state.isConnected && (
                  <span class="text-muted">
                    {" "}via {state.proxyProtocol.toUpperCase()} to {state.country}
                  </span>
                )}
              </div>
            </div>
          </div>
          {state.lastError && (
            <div class="error-banner">{truncateError(state.lastError)}</div>
          )}
        </div>
      </div>

      {/* Advanced */}
      <div class="section">
        <div class="section-title">Advanced</div>
        <div class="card stack-sm">
          <div class="text-sm text-muted">
            API Base URL is configured at build time. Current:
          </div>
          <div style={{ fontFamily: "monospace", fontSize: "13px", color: "var(--text-secondary)" }}>
            {state.apiKey ? "API Key mode (direct proxy)" : "https://proxy.dominusnode.com"}
          </div>
        </div>
      </div>
    </>
  );
}
