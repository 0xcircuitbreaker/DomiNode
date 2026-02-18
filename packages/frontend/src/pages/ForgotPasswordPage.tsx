import { useState } from "react";
import { Link } from "react-router-dom";
import { post } from "../api/client";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError("Email address is required.");
      return;
    }

    setLoading(true);
    try {
      await post("/api/auth/forgot-password", { email: email.trim() });
      setSubmitted(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "An error occurred. Please try again.";
      // Always show the success state on 429 to prevent timing-based enumeration,
      // but surface rate-limit messaging as a distinct notice.
      if (message.toLowerCase().includes("too many requests")) {
        setError(message);
      } else {
        // For all other errors (including 404, 500, network), show the generic
        // success message to prevent email enumeration.
        setSubmitted(true);
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md">
        {/* Brand */}
        <div className="text-center mb-8">
          <Link to="/" className="text-indigo-400 font-bold text-2xl hover:text-indigo-300 transition-colors">
            Dominus Node
          </Link>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8">
          <h1 className="text-xl font-semibold text-white mb-2">Reset your password</h1>
          <p className="text-sm text-gray-400 mb-6">
            Enter your account email and we will send you a reset link.
          </p>

          {submitted ? (
            <div className="space-y-4">
              <div className="bg-indigo-900/30 border border-indigo-700/50 rounded-lg px-4 py-3 text-sm text-indigo-300">
                If an account with that email exists, a password reset link has been sent. Check your inbox.
              </div>
              <p className="text-xs text-gray-500 text-center">
                Did not receive it? Check your spam folder or wait a few minutes before trying again.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate className="space-y-4">
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-1.5">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-colors"
                  disabled={loading}
                />
              </div>

              {error && (
                <div className="bg-red-900/30 border border-red-700/50 rounded-lg px-4 py-3 text-sm text-red-300">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 disabled:cursor-not-allowed text-white text-sm font-medium py-2.5 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-900"
              >
                {loading ? "Sending..." : "Send reset link"}
              </button>
            </form>
          )}

          <div className="mt-6 pt-5 border-t border-gray-800 text-center">
            <Link
              to="/login"
              className="text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              Back to Sign In
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
