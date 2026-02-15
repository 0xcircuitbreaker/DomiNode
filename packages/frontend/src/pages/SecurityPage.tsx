import { useState, useEffect, useCallback } from "react";
import { get, post } from "../api/client";
import { useAuth } from "../context/AuthContext";

interface MfaStatus {
  enabled: boolean;
  backupCodesRemaining: number;
}

interface MfaSetupResponse {
  secret: string;
  otpauthUri: string;
  backupCodes: string[];
}

function isWalletEmail(email: string): boolean {
  return email.endsWith("@wallet.dominusnode.com");
}

export default function SecurityPage() {
  const { user } = useAuth();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Setup flow state
  const [setupData, setSetupData] = useState<MfaSetupResponse | null>(null);
  const [enableCode, setEnableCode] = useState("");
  const [enabling, setEnabling] = useState(false);

  // Disable flow state
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [disabling, setDisabling] = useState(false);

  // Password change state
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState("");

  const isWallet = user ? isWalletEmail(user.email) : false;

  const fetchStatus = useCallback(async () => {
    try {
      const data = await get<MfaStatus>("/api/auth/mfa/status");
      setStatus(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load MFA status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // R15 H-4: Auto-clear MFA setup data after 5 minutes to prevent indefinite secret display
  useEffect(() => {
    if (!setupData) return;
    const timer = setTimeout(() => {
      setSetupData(null);
      setEnableCode("");
      setError("MFA setup timed out. Please start again.");
    }, 5 * 60 * 1000);
    return () => clearTimeout(timer);
  }, [setupData]);

  async function handleSetup() {
    setError("");
    setLoading(true);
    try {
      const data = await post<MfaSetupResponse>("/api/auth/mfa/setup", {});
      setSetupData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleEnable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setEnabling(true);
    try {
      await post("/api/auth/mfa/enable", { code: enableCode });
      setSetupData(null);
      setEnableCode("");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    } finally {
      setEnabling(false);
    }
  }

  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setDisabling(true);
    try {
      await post("/api/auth/mfa/disable", {
        password: disablePassword,
        code: disableCode,
      });
      setShowDisable(false);
      setDisablePassword("");
      setDisableCode("");
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable MFA");
    } finally {
      setDisabling(false);
    }
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setPasswordMessage("");
    setChangingPassword(true);
    try {
      await post("/api/auth/change-password", {
        currentPassword,
        newPassword,
      });
      setPasswordMessage("Password changed successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setShowPasswordChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password change failed");
    } finally {
      setChangingPassword(false);
    }
  }

  if (loading && !status) {
    return <div className="p-8 text-center text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Security</h1>

      {error && (
        <div className="text-sm text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-4 py-3">
          {error}
        </div>
      )}

      {passwordMessage && (
        <div className="text-sm text-green-400 bg-green-400/10 border border-green-400/20 rounded-lg px-4 py-3">
          {passwordMessage}
        </div>
      )}

      {/* Wallet Authentication Info */}
      {isWallet && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-6 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h2 className="text-base sm:text-lg font-semibold">Wallet Authentication</h2>
              <p className="text-sm text-gray-400 mt-1">
                Your account is secured with EIP-191 Ethereum wallet signature authentication.
              </p>
            </div>
            <span className="self-start px-3 py-1 text-xs font-medium rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 flex-shrink-0">
              Active
            </span>
          </div>
          <p className="text-sm text-gray-400 min-w-0">
            Wallet address: <code className="text-indigo-300 font-mono text-xs break-all">{user?.wallet_address ?? user?.email.split("@")[0]}</code>
          </p>
          <p className="text-xs text-gray-500">
            Wallet-authenticated accounts use cryptographic signatures instead of passwords. No password can be set for this account.
          </p>
        </div>
      )}

      {/* Two-Factor Authentication */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h2 className="text-base sm:text-lg font-semibold">Two-Factor Authentication</h2>
            <p className="text-sm text-gray-400 mt-1">
              Add an extra layer of security to your account using a TOTP authenticator app.
            </p>
          </div>
          <span className={`self-start px-3 py-1 text-xs font-medium rounded-full flex-shrink-0 ${
            status?.enabled
              ? "bg-green-500/20 text-green-400 border border-green-500/30"
              : "bg-gray-700/50 text-gray-400 border border-gray-600"
          }`}>
            {status?.enabled ? "Enabled" : "Disabled"}
          </span>
        </div>

        {status?.enabled && (
          <div className="text-sm text-gray-400">
            Backup codes remaining: <span className="font-mono text-gray-200">{status.backupCodesRemaining}</span>
          </div>
        )}

        {/* Setup flow: not enabled and no active setup */}
        {!status?.enabled && !setupData && (
          <button
            onClick={handleSetup}
            disabled={loading}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Set Up 2FA
          </button>
        )}

        {/* Setup flow: secret generated, waiting for verification */}
        {setupData && (
          <div className="space-y-4 border-t border-gray-800 pt-4">
            <h3 className="font-semibold">Scan QR Code</h3>
            <p className="text-sm text-gray-400">
              Scan this URI with your authenticator app (Google Authenticator, Authy, 1Password):
            </p>
            <div className="bg-gray-800 rounded-lg p-3">
              <code className="text-xs text-indigo-300 break-all">{setupData.otpauthUri}</code>
            </div>
            <p className="text-sm text-gray-400">
              Or enter this secret manually: <code className="text-indigo-300 font-mono">{setupData.secret}</code>
            </p>

            <div className="border-t border-gray-800 pt-4">
              <h3 className="font-semibold mb-2">Backup Codes</h3>
              <p className="text-sm text-red-400 mb-2">
                Save these codes securely. Each can only be used once.
              </p>
              <div className="bg-gray-800 rounded-lg p-3 grid grid-cols-1 xs:grid-cols-2 gap-2">
                {setupData.backupCodes.map((code, i) => (
                  <code key={i} className="text-sm font-mono text-gray-200">{code}</code>
                ))}
              </div>
            </div>

            <form onSubmit={handleEnable} className="border-t border-gray-800 pt-4 space-y-3">
              <label className="block text-sm text-gray-400">
                Enter the 6-digit code from your authenticator app to verify:
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={enableCode}
                onChange={(e) => setEnableCode(e.target.value.replace(/\D/g, ""))}
                maxLength={6}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500 text-center text-xl tracking-widest"
                placeholder="000000"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={enabling || enableCode.length !== 6}
                  className="bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {enabling ? "Verifying..." : "Enable 2FA"}
                </button>
                <button
                  type="button"
                  onClick={() => { setSetupData(null); setEnableCode(""); setError(""); }}
                  className="bg-gray-700 hover:bg-gray-600 text-white font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Disable flow */}
        {status?.enabled && !showDisable && (
          <button
            onClick={() => setShowDisable(true)}
            className="bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/30 font-medium px-4 py-2 rounded-lg transition-colors"
          >
            Disable 2FA
          </button>
        )}

        {showDisable && (
          <form onSubmit={handleDisable} className="border-t border-gray-800 pt-4 space-y-3">
            <p className="text-sm text-red-400">
              Disabling 2FA will remove the extra security layer. You will need your password and a verification code.
            </p>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Password</label>
              <input
                type="password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                required
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">TOTP or backup code</label>
              <input
                type="text"
                inputMode="numeric"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, ""))}
                required
                maxLength={8}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={disabling || !disablePassword || !disableCode}
                className="bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors"
              >
                {disabling ? "Disabling..." : "Disable 2FA"}
              </button>
              <button
                type="button"
                onClick={() => { setShowDisable(false); setDisablePassword(""); setDisableCode(""); setError(""); }}
                className="bg-gray-700 hover:bg-gray-600 text-white font-medium px-4 py-2 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Password Change - only for non-wallet accounts */}
      {!isWallet && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-6 space-y-4">
          <div>
            <h2 className="text-base sm:text-lg font-semibold">Password</h2>
            <p className="text-sm text-gray-400 mt-1">
              Change your account password. All existing sessions will be revoked.
            </p>
          </div>

          {!showPasswordChange ? (
            <button
              onClick={() => setShowPasswordChange(true)}
              className="bg-gray-700 hover:bg-gray-600 text-white font-medium px-4 py-2 rounded-lg transition-colors"
            >
              Change Password
            </button>
          ) : (
            <form onSubmit={handlePasswordChange} className="border-t border-gray-800 pt-4 space-y-3">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Current Password</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-400 mb-1">New Password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500"
                  placeholder="Min 8 characters"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={changingPassword || !currentPassword || !newPassword}
                  className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  {changingPassword ? "Changing..." : "Update Password"}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowPasswordChange(false); setCurrentPassword(""); setNewPassword(""); setError(""); }}
                  className="bg-gray-700 hover:bg-gray-600 text-white font-medium px-4 py-2 rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
