import { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { post } from "../api/client";

type VerifyState = "loading" | "success" | "error" | "no-token";

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const [state, setState] = useState<VerifyState>("loading");
  const [message, setMessage] = useState("");

  // R38 H-1: Validate token format before sending to API to prevent injection
  const TOKEN_RE = /^[a-zA-Z0-9._-]+$/;

  useEffect(() => {
    const rawToken = searchParams.get("token");

    if (!rawToken) {
      setState("no-token");
      return;
    }

    // Validate token format: alphanumeric + ._- , 16-512 chars
    if (rawToken.length < 16 || rawToken.length > 512 || !TOKEN_RE.test(rawToken)) {
      setMessage("Invalid verification token format. Please use the link from your confirmation email.");
      setState("error");
      return;
    }

    const token = rawToken;
    let cancelled = false;

    post<{ message: string }>("/api/auth/verify-email", { token }, { redirectOnUnauthorized: false })
      .then((data) => {
        if (cancelled) return;
        setMessage(data?.message ?? "Your email has been verified.");
        setState("success");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMessage(err instanceof Error ? err.message : "Verification failed. The link may be expired or invalid.");
        setState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 shadow-lg">
          {state === "loading" && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div
                className="w-10 h-10 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin"
                role="status"
                aria-label="Verifying email"
              />
              <h1 className="text-lg font-semibold text-gray-100">Verifying your email…</h1>
              <p className="text-sm text-gray-400">Please wait while we confirm your address.</p>
            </div>
          )}

          {state === "success" && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-12 h-12 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-green-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-xl font-semibold text-gray-100">Email Verified</h1>
              <p className="text-sm text-gray-400">{message}</p>
              <div className="flex flex-col gap-2 w-full pt-2">
                <Link
                  to="/app"
                  className="w-full text-center px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
                >
                  Go to Dashboard
                </Link>
                <Link
                  to="/login"
                  className="w-full text-center px-4 py-2 rounded-lg border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-gray-100 text-sm font-medium transition-colors"
                >
                  Sign In
                </Link>
              </div>
            </div>
          )}

          {state === "error" && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-red-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h1 className="text-xl font-semibold text-gray-100">Verification Failed</h1>
              <p className="text-sm text-gray-400">{message}</p>
              <div className="flex flex-col gap-2 w-full pt-2">
                <Link
                  to="/login?mode=register"
                  className="w-full text-center px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
                >
                  Back to Register
                </Link>
                <Link
                  to="/login"
                  className="w-full text-center px-4 py-2 rounded-lg border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-gray-100 text-sm font-medium transition-colors"
                >
                  Sign In
                </Link>
              </div>
            </div>
          )}

          {state === "no-token" && (
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="w-12 h-12 rounded-full bg-yellow-500/10 border border-yellow-500/30 flex items-center justify-center">
                <svg
                  className="w-6 h-6 text-yellow-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                  />
                </svg>
              </div>
              <h1 className="text-xl font-semibold text-gray-100">Invalid Link</h1>
              <p className="text-sm text-gray-400">
                No verification token was found. Please use the link from your confirmation email.
              </p>
              <Link
                to="/login"
                className="w-full text-center px-4 py-2 rounded-lg border border-gray-700 hover:border-gray-600 text-gray-300 hover:text-gray-100 text-sm font-medium transition-colors"
              >
                Back to Sign In
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
