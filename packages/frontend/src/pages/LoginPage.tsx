import { useEffect, useState, useRef, type ReactNode } from "react";
import { useNavigate, Navigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import ThemeToggle from "../components/ThemeToggle";
import NodeNetworkBackground from "../components/NodeNetworkBackground";
import { BRAND_MARK, BRAND_NAME } from "../config/branding";
import { useApi } from "../hooks/useApi";
import { get, post } from "../api/client";
import "./LoginPage.css";

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY || "";

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
            <img src="/logo.svg" alt={BRAND_MARK} className="login-brand-mark" style={{ width: "2.8rem", height: "2.8rem" }} />
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

function hasEthereumProvider(): boolean {
  return typeof window !== "undefined" && typeof (window as any).ethereum !== "undefined";
}

export default function LoginPage() {
  const { user, mfaRequired, login, verifyMfa, cancelMfa, register, walletChallenge, walletLogin } = useAuth();
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
  const [walletLoading, setWalletLoading] = useState(false);
  const [waitlistMode, setWaitlistMode] = useState(searchParams.get("waitlist") === "1");
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistSuccess, setWaitlistSuccess] = useState(false);
  const [waitlistError, setWaitlistError] = useState("");
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [referralCode, setReferralCode] = useState(searchParams.get("ref") ?? "");
  const recaptchaLoaded = useRef(false);

  // Load reCAPTCHA v3 script dynamically (invisible — no checkbox)
  useEffect(() => {
    if (!RECAPTCHA_SITE_KEY || recaptchaLoaded.current) return;
    recaptchaLoaded.current = true;
    const script = document.createElement("script");
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(RECAPTCHA_SITE_KEY)}`;
    script.async = true;
    document.head.appendChild(script);
  }, []);

  const { data: slotsData } = useApi<{ total: number; used: number; remaining: number; unlimited: boolean }>(
    () => get("/api/slots", { redirectOnUnauthorized: false })
  );
  const { data: waitlistData } = useApi<{ pending: number }>(
    () => get("/api/waitlist/count", { redirectOnUnauthorized: false })
  );

  useEffect(() => {
    setIsRegister(searchParams.get("mode") === "register");
  }, [searchParams]);

  const redirectTo = searchParams.get("redirect") ?? "/app";
  // Only allow relative paths to prevent open redirect
  // Block protocol-relative URLs (//evil.com) and backslash bypasses (\/evil.com, \evil.com)
  // Browsers normalize backslashes to forward slashes, so \/evil.com becomes //evil.com
  const normalizedRedirect = redirectTo.replace(/\\/g, "/");
  const safeRedirect =
    normalizedRedirect.startsWith("/") && !normalizedRedirect.startsWith("//")
      ? normalizedRedirect
      : "/app";

  if (user) {
    return <Navigate to={safeRedirect} replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      // reCAPTCHA v3: execute invisibly to get a score-based token
      let captchaToken: string | undefined;
      if (RECAPTCHA_SITE_KEY && window.grecaptcha?.execute) {
        try {
          captchaToken = await window.grecaptcha.execute(RECAPTCHA_SITE_KEY, {
            action: isRegister ? "register" : "login",
          });
        } catch {
          setError("CAPTCHA verification failed. Please refresh and try again.");
          setLoading(false);
          return;
        }
      }

      if (isRegister) {
        await register(email, password, captchaToken, referralCode || undefined);
        setPassword("");
        navigate(safeRedirect);
      } else {
        const result = await login(email, password, captchaToken);
        // Use the returned value instead of React state to avoid race condition
        if (!result.mfaRequired) {
          setPassword("");
          navigate(safeRedirect);
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
      navigate(safeRedirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setLoading(false);
    }
  }

  async function handleWalletLogin() {
    setError("");
    setWalletLoading(true);

    try {
      const ethereum = (window as any).ethereum;
      if (!ethereum) {
        setError("No wallet provider detected. Install MetaMask or another Web3 wallet.");
        return;
      }

      // Request account access
      const accounts: string[] = await ethereum.request({ method: "eth_requestAccounts" });
      if (!accounts || accounts.length === 0) {
        setError("No account selected. Please connect your wallet.");
        return;
      }
      const address = accounts[0].toLowerCase();

      // Get challenge from server
      const challenge = await walletChallenge(address);

      // Sign the message with the wallet
      const signature: string = await ethereum.request({
        method: "personal_sign",
        params: [challenge.message, address],
      });

      // Verify signature and login/register
      await walletLogin(address, signature);
      navigate(safeRedirect);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Wallet sign-in failed";
      // Don't show "User rejected" as an error — they just cancelled
      if (msg.includes("User rejected") || msg.includes("user rejected")) {
        setError("");
      } else {
        setError(msg);
      }
    } finally {
      setWalletLoading(false);
    }
  }

  async function handleWaitlistSubmit(e: React.FormEvent) {
    e.preventDefault();
    setWaitlistError("");
    setWaitlistLoading(true);
    try {
      await post("/api/waitlist/join", { email: waitlistEmail }, { redirectOnUnauthorized: false });
      setWaitlistSuccess(true);
    } catch (err) {
      setWaitlistError(err instanceof Error ? err.message : "Failed to join waitlist");
    } finally {
      setWaitlistLoading(false);
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

  // Waitlist form: show when slots are filled or ?waitlist=1
  const showWaitlist = (waitlistMode || (slotsData && !slotsData.unlimited && slotsData.remaining === 0)) && isRegister;

  if (showWaitlist) {
    return (
      <AuthShell theme={theme} subtitle="Residential Proxy Service">
        <div className="login-form">
          <h2 className="login-form-title">Join the Waitlist</h2>

          <div className="login-alert-info">
            <strong>Alpha Access</strong>
            <p>All {slotsData?.total ?? 250} alpha slots are currently filled.</p>
            {waitlistData && waitlistData.pending > 0 && (
              <p><strong>{waitlistData.pending}</strong> {waitlistData.pending === 1 ? "person" : "people"} already on the waitlist.</p>
            )}
            <p>Join the waitlist and we'll email you when a slot opens.</p>
          </div>

          {waitlistSuccess ? (
            <div className="login-alert-info" style={{ borderColor: "rgba(34, 197, 94, 0.3)", background: "rgba(34, 197, 94, 0.1)" }}>
              <strong style={{ color: "#22c55e" }}>You're on the list!</strong>
              <p>We'll email you when a slot opens up.</p>
            </div>
          ) : (
            <form onSubmit={handleWaitlistSubmit}>
              {waitlistError && (
                <div className="login-alert-error">{waitlistError}</div>
              )}
              <div className="login-field">
                <label htmlFor="waitlist-email">Email</label>
                <input
                  id="waitlist-email"
                  type="email"
                  value={waitlistEmail}
                  onChange={(e) => setWaitlistEmail(e.target.value)}
                  required
                  className="login-input"
                  placeholder="you@example.com"
                />
              </div>
              <button type="submit" disabled={waitlistLoading} className="login-submit">
                {waitlistLoading ? "..." : "Join Waitlist"}
              </button>
            </form>
          )}

          <p className="login-switch-row">
            Already have an account?{" "}
            <button
              type="button"
              onClick={() => { setIsRegister(false); setWaitlistMode(false); setError(""); }}
              className="login-link-button"
            >
              Sign in
            </button>
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell theme={theme} subtitle="Residential Proxy Service">
      <form onSubmit={handleSubmit} className="login-form" aria-label="Login form">
        <h2 className="login-form-title">
          {isRegister ? "Create Account" : "Sign In"}
        </h2>

        {isRegister && (
          <div className="login-alert-info">
            <strong>Alpha Access</strong>
            <p>{slotsData && !slotsData.unlimited ? `${slotsData.remaining} of ${slotsData.total} slots remaining` : "5,000 alpha slots, 250 DC proxies"} | Limited residential bandwidth</p>
            <p>If max bandwidth is reached, service restores within 1-6 hours</p>
          </div>
        )}

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

        {isRegister && (
          <div className="login-field">
            <label htmlFor="login-referral">Referral Code <span style={{ color: "#6b7280", fontWeight: "normal" }}>(optional)</span></label>
            <input
              id="login-referral"
              type="text"
              value={referralCode}
              onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
              maxLength={20}
              className="login-input"
              placeholder="e.g. ABCD1234"
            />
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="login-submit"
        >
          {loading ? "..." : isRegister ? "Create Account" : "Sign In"}
        </button>

        {hasEthereumProvider() && (
          <div className="login-wallet-divider">
            <span>or</span>
          </div>
        )}

        {hasEthereumProvider() && (
          <button
            type="button"
            onClick={handleWalletLogin}
            disabled={walletLoading}
            className="login-submit login-wallet-btn"
          >
            {walletLoading ? "Connecting..." : "Sign in with Wallet"}
          </button>
        )}

        {!isRegister && (
          <p className="login-switch-row">
            <Link to="/forgot-password" className="login-link-button">
              Forgot password?
            </Link>
          </p>
        )}

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
