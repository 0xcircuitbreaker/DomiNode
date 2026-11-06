import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import ThemeToggle from "../components/ThemeToggle";
import NodeNetworkBackground from "../components/NodeNetworkBackground";
import { BRAND_MARK, BRAND_NAME } from "../config/branding";
import "./LoginPage.css";

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY || "";

function AuthShell({ theme, subtitle, children }: { theme: "light" | "dark"; subtitle: string; children: ReactNode }) {
  return (
    <div className="login-root" data-theme={theme}>
      <NodeNetworkBackground theme={theme} className="login-node-network" />
      <div className="login-shell">
        <header className="login-header">
          <span className="login-brand">
            <img src="/logo.svg" alt={BRAND_MARK} className="login-brand-mark" style={{ width: "2.8rem", height: "2.8rem" }} />
            <span>{BRAND_NAME}</span>
          </span>
          <ThemeToggle compact className="login-theme-toggle" />
        </header>
        <div className="login-panel">
          <div className="login-panel-head">
            <h1>{BRAND_NAME}</h1>
            <p>{subtitle}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Only same-origin relative paths are accepted as post-login redirects (no //host, no backslashes). */
export function safeRedirectPath(raw: string | null): string {
  const r = (raw ?? "/admin").replace(/\\/g, "/");
  return r.startsWith("/") && !r.startsWith("//") ? r : "/admin";
}

export default function LoginPage() {
  const { user, mfaRequired, login, verifyMfa, cancelMfa } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const recaptchaLoaded = useRef(false);
  const target = safeRedirectPath(searchParams.get("redirect"));

  // reCAPTCHA v3 (invisible) when configured
  useEffect(() => {
    if (!RECAPTCHA_SITE_KEY || recaptchaLoaded.current) return;
    recaptchaLoaded.current = true;
    const script = document.createElement("script");
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(RECAPTCHA_SITE_KEY)}`;
    script.async = true;
    document.head.appendChild(script);
  }, []);

  if (user) return <Navigate to={target} replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      let captchaToken: string | undefined;
      if (RECAPTCHA_SITE_KEY && window.grecaptcha?.execute) {
        try {
          captchaToken = await window.grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: "login" });
        } catch {
          setError("CAPTCHA verification failed. Please refresh and try again.");
          return;
        }
      }
      const r = await login(email, password, captchaToken);
      if (!r.mfaRequired) {
        setPassword("");
        navigate(target);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfa(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await verifyMfa(mfaCode, useBackupCode);
      setMfaCode("");
      setPassword("");
      navigate(target);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  }

  if (mfaRequired) {
    const len = useBackupCode ? 8 : 6;
    return (
      <AuthShell theme={theme} subtitle="Two-factor authentication">
        <form onSubmit={handleMfa} className="login-form" aria-label="MFA form">
          <h2 className="login-form-title">{useBackupCode ? "Enter backup code" : "Enter authentication code"}</h2>
          <p className="login-form-copy">
            {useBackupCode ? "Enter one of your 8-digit backup codes." : "Enter the 6-digit code from your authenticator app."}
          </p>
          {error && <div role="alert" className="login-alert-error">{error}</div>}
          <input type="text" inputMode="numeric" autoComplete="one-time-code" aria-label="Authentication code"
            value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))} required maxLength={len}
            className="login-input login-input-code" placeholder={"0".repeat(len)} autoFocus />
          <button type="submit" disabled={loading || mfaCode.length < len} className="login-submit">
            {loading ? "Verifying..." : "Verify"}
          </button>
          <div className="login-actions-row">
            <button type="button" className="login-link-button" onClick={() => { setUseBackupCode(!useBackupCode); setMfaCode(""); setError(""); }}>
              {useBackupCode ? "Use authenticator app" : "Use backup code"}
            </button>
            <button type="button" className="login-link-button login-link-button-muted" onClick={() => { cancelMfa(); setMfaCode(""); setError(""); }}>
              Cancel
            </button>
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell theme={theme} subtitle="Operator console">
      <form onSubmit={handleSubmit} className="login-form" aria-label="Sign in form">
        <h2 className="login-form-title">Sign in</h2>
        <p className="login-form-copy">Restricted to network operators. Activity is audited.</p>
        {error && <div role="alert" className="login-alert-error">{error}</div>}
        <div className="login-field">
          <label htmlFor="login-email">Email</label>
          <input id="login-email" type="email" autoComplete="username" required value={email}
            onChange={(e) => setEmail(e.target.value)} className="login-input" placeholder="admin@example.com" />
        </div>
        <div className="login-field">
          <label htmlFor="login-password">Password</label>
          <input id="login-password" type="password" autoComplete="current-password" required minLength={8} value={password}
            onChange={(e) => setPassword(e.target.value)} className="login-input" />
        </div>
        <button type="submit" disabled={loading} className="login-submit">{loading ? "Signing in..." : "Sign in"}</button>
        <div className="login-switch-row">
          <Link to="/forgot-password" className="login-link-button">Forgot password?</Link>
        </div>
      </form>
    </AuthShell>
  );
}
