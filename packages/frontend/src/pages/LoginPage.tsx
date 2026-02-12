import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, Navigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import ThemeToggle from "../components/ThemeToggle";
import NodeNetworkBackground from "../components/NodeNetworkBackground";
import { BRAND_MARK, BRAND_NAME } from "../config/branding";
import "./LoginPage.css";

interface AuthShellProps {
  theme: "light" | "dark";
  subtitle: string;
  children: ReactNode;
}

function AuthShell({ theme, subtitle, children }: AuthShellProps) {
  return (
    <div className="login-root" data-theme={theme}>
      <NodeNetworkBackground theme={theme} className="login-node-network" />
      <div className="login-shell">
        <header className="login-header">
          <Link to="/" className="login-brand">
            <span className="login-brand-mark">{BRAND_MARK}</span>
            <span>{BRAND_NAME}</span>
          </Link>
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

export default function LoginPage() {
  const { user, mfaRequired, login, verifyMfa, cancelMfa, register } = useAuth();
  const { theme } = useTheme();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [isRegister, setIsRegister] = useState(searchParams.get("mode") === "register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setIsRegister(searchParams.get("mode") === "register");
  }, [searchParams]);

  if (user) {
    return <Navigate to="/app" replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      if (isRegister) {
        await register(email, password);
        setPassword("");
        navigate("/app");
      } else {
        const result = await login(email, password);
        // Use the returned value instead of React state to avoid race condition
        if (!result.mfaRequired) {
          setPassword("");
          navigate("/app");
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await verifyMfa(mfaCode, useBackupCode);
      setMfaCode("");
      navigate("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  }

  // MFA verification step
  if (mfaRequired) {
    return (
      <AuthShell theme={theme} subtitle="Two-Factor Authentication">
        <form onSubmit={handleMfaSubmit} className="login-form" aria-label="MFA form">
          <h2 className="login-form-title">
            {useBackupCode ? "Enter Backup Code" : "Enter Authentication Code"}
          </h2>

          <p className="login-form-copy">
            {useBackupCode
              ? "Enter one of your 8-digit backup codes."
              : "Enter the 6-digit code from your authenticator app."}
          </p>

          {error && (
            <div className="login-alert-error">
              {error}
            </div>
          )}

          <div>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ""))}
              required
              maxLength={useBackupCode ? 8 : 6}
              className="login-input login-input-code"
              placeholder={useBackupCode ? "00000000" : "000000"}
              autoFocus
            />
          </div>

          <button
            type="submit"
            disabled={loading || mfaCode.length < (useBackupCode ? 8 : 6)}
            className="login-submit"
          >
            {loading ? "Verifying..." : "Verify"}
          </button>

          <div className="login-actions-row">
            <button
              type="button"
              onClick={() => { setUseBackupCode(!useBackupCode); setMfaCode(""); setError(""); }}
              className="login-link-button"
            >
              {useBackupCode ? "Use authenticator app" : "Use backup code"}
            </button>
            <button
              type="button"
              onClick={() => { cancelMfa(); setMfaCode(""); setError(""); }}
              className="login-link-button login-link-button-muted"
            >
              Cancel
            </button>
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell theme={theme} subtitle="Residential Proxy Service">
      <form onSubmit={handleSubmit} className="login-form" aria-label="Login form">
        <h2 className="login-form-title">
          {isRegister ? "Create Account" : "Sign In"}
        </h2>

        {error && (
          <div className="login-alert-error">
            {error}
          </div>
        )}

        <div className="login-field">
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="login-input"
            placeholder="you@example.com"
          />
        </div>

        <div className="login-field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="login-input"
            placeholder="Min 8 characters"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="login-submit"
        >
          {loading ? "..." : isRegister ? "Create Account" : "Sign In"}
        </button>

        <p className="login-switch-row">
          {isRegister ? "Already have an account?" : "Don't have an account?"}{" "}
          <button
            type="button"
            onClick={() => { setIsRegister(!isRegister); setError(""); }}
            className="login-link-button"
          >
            {isRegister ? "Sign in" : "Register"}
          </button>
        </p>
      </form>
    </AuthShell>
  );
}
