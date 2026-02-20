import { useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { post } from "../api/client";

type PageState = "form" | "success" | "error";

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const rawToken = searchParams.get("token");

  // R37 C-2: Validate token format before sending to API to prevent injection.
  // Tokens should be hex or alphanumeric, with a reasonable length (16-512 chars).
  const TOKEN_RE = /^[a-zA-Z0-9._-]+$/;
  const token =
    rawToken && rawToken.length >= 16 && rawToken.length <= 512 && TOKEN_RE.test(rawToken)
      ? rawToken
      : null;

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [pageState, setPageState] = useState<PageState>(token ? "form" : "error");
  const [errorMessage, setErrorMessage] = useState(
    token
      ? ""
      : rawToken
        ? "Invalid reset token format. Please request a new password reset link."
        : "No reset token found. Please request a new password reset link."
  );
  const [successMessage, setSuccessMessage] = useState("");

  // Inline validation
  const passwordTooShort = newPassword.length > 0 && newPassword.length < 8;
  const passwordMismatch =
    confirmPassword.length > 0 && newPassword !== confirmPassword;
  const isFormValid =
    newPassword.length >= 8 && newPassword === confirmPassword;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!isFormValid || !token) return;

    setErrorMessage("");
    setLoading(true);

    try {
      const result = await post<{ message: string }>("/api/auth/reset-password", {
        token,
        newPassword,
      });
      setSuccessMessage(result.message || "Your password has been reset successfully.");
      setPageState("success");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-flex items-center gap-2 text-gray-300 hover:text-white transition-colors">
            <img src="/logo.svg" alt="Dominus Node" className="w-8 h-8" />
            <span className="text-lg font-semibold">Dominus Node</span>
          </Link>
        </div>

        {/* Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 shadow-2xl">
          {pageState === "success" && (
            <div className="text-center">
              <div className="w-12 h-12 bg-green-900/40 border border-green-700/50 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-6 h-6 text-green-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
              </div>
              <h1 className="text-xl font-semibold text-white mb-2">Password Reset</h1>
              <p className="text-gray-400 text-sm mb-6">{successMessage}</p>
              <Link
                to="/login"
                className="inline-block w-full text-center bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
              >
                Sign In
              </Link>
            </div>
          )}

          {pageState === "error" && (
            <div className="text-center">
              <div className="w-12 h-12 bg-red-900/40 border border-red-700/50 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg
                  className="w-6 h-6 text-red-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </div>
              <h1 className="text-xl font-semibold text-white mb-2">Invalid Link</h1>
              <p className="text-gray-400 text-sm mb-6">{errorMessage}</p>
              <Link
                to="/login"
                className="inline-block w-full text-center bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2.5 px-4 rounded-lg transition-colors"
              >
                Back to Sign In
              </Link>
            </div>
          )}

          {pageState === "form" && (
            <>
              <div className="mb-6">
                <h1 className="text-xl font-semibold text-white mb-1">Set New Password</h1>
                <p className="text-gray-400 text-sm">
                  Enter a new password for your account. It must be at least 8 characters long.
                </p>
              </div>

              {errorMessage && (
                <div
                  role="alert"
                  className="mb-5 px-4 py-3 rounded-lg bg-red-900/30 border border-red-700/50 text-red-300 text-sm"
                >
                  {errorMessage}
                </div>
              )}

              <form onSubmit={handleSubmit} noValidate aria-label="Reset password form">
                <div className="mb-4">
                  <label
                    htmlFor="new-password"
                    className="block text-sm font-medium text-gray-300 mb-1.5"
                  >
                    New Password
                  </label>
                  <input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    autoFocus
                    autoComplete="new-password"
                    minLength={8}
                    placeholder="Min 8 characters"
                    className={[
                      "w-full bg-gray-800 border rounded-lg px-3.5 py-2.5 text-white placeholder-gray-500 text-sm",
                      "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors",
                      passwordTooShort
                        ? "border-red-600"
                        : "border-gray-700 hover:border-gray-600",
                    ].join(" ")}
                    aria-describedby={passwordTooShort ? "pw-length-error" : undefined}
                  />
                  {passwordTooShort && (
                    <p id="pw-length-error" className="mt-1.5 text-xs text-red-400">
                      Password must be at least 8 characters.
                    </p>
                  )}
                </div>

                <div className="mb-6">
                  <label
                    htmlFor="confirm-password"
                    className="block text-sm font-medium text-gray-300 mb-1.5"
                  >
                    Confirm Password
                  </label>
                  <input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    placeholder="Repeat your new password"
                    className={[
                      "w-full bg-gray-800 border rounded-lg px-3.5 py-2.5 text-white placeholder-gray-500 text-sm",
                      "focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors",
                      passwordMismatch
                        ? "border-red-600"
                        : "border-gray-700 hover:border-gray-600",
                    ].join(" ")}
                    aria-describedby={passwordMismatch ? "pw-match-error" : undefined}
                  />
                  {passwordMismatch && (
                    <p id="pw-match-error" className="mt-1.5 text-xs text-red-400">
                      Passwords do not match.
                    </p>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={loading || !isFormValid}
                  className={[
                    "w-full font-medium py-2.5 px-4 rounded-lg transition-colors text-sm",
                    loading || !isFormValid
                      ? "bg-indigo-800 text-indigo-300 cursor-not-allowed"
                      : "bg-indigo-600 hover:bg-indigo-500 text-white",
                  ].join(" ")}
                >
                  {loading ? "Resetting..." : "Reset Password"}
                </button>
              </form>

              <p className="mt-5 text-center text-sm text-gray-500">
                Remember your password?{" "}
                <Link to="/login" className="text-indigo-400 hover:text-indigo-300 transition-colors">
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
