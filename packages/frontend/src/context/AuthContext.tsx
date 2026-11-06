import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { post, get, ApiError } from "../api/client";

type AdminRole = "none" | "admin" | "cybersecurity_admin" | "root_admin";

interface AuthUser {
  id: string;
  email: string;
  is_admin: boolean;
  admin_role: AdminRole;
  wallet_address?: string | null;
  log_target_hosts?: boolean;
  email_verified?: boolean;
}

interface WalletChallengeResponse {
  message: string;
  nonce: string;
}

interface AuthState {
  user: AuthUser | null;
  isAdmin: boolean;
  adminRole: AdminRole;
  loading: boolean;
  mfaRequired: boolean;
  login: (email: string, password: string, captchaToken?: string) => Promise<{ mfaRequired: boolean }>;
  verifyMfa: (code: string, isBackupCode?: boolean) => Promise<void>;
  cancelMfa: () => void;
  register: (email: string, password: string, captchaToken?: string, referralCode?: string) => Promise<void>;
  logout: () => Promise<void>;
  walletChallenge: (address: string) => Promise<WalletChallengeResponse>;
  walletLogin: (address: string, signature: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface MeResponse {
  user: AuthUser;
}

interface LoginResponse {
  user?: AuthUser;
  mfaRequired?: boolean;
}

interface MfaVerifyResponse {
  user: AuthUser;
}

interface WalletVerifyResponse {
  user: AuthUser;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mfaRequired, setMfaRequired] = useState(false);

  // On mount: check session via GET /api/auth/me (cookie-based)
  useEffect(() => {
    // Only 401/403 means "not signed in". Rate limits (429) and transient
    // errors are retried so an admin is not bounced to the login page.
    let cancelled = false;
    const check = async (attempt: number): Promise<void> => {
      try {
        const data = await get<MeResponse>("/api/auth/me", { redirectOnUnauthorized: false });
        if (!cancelled) setUser(data.user);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (status !== 401 && status !== 403 && attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
          if (!cancelled) return check(attempt + 1);
          return;
        }
        if (!cancelled) setUser(null);
      }
    };
    void check(0).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string, captchaToken?: string): Promise<{ mfaRequired: boolean }> => {
    const res = await post<LoginResponse>("/api/auth/login", {
      email,
      password,
      ...(captchaToken ? { captchaToken } : {}),
    });
    if (res.mfaRequired) {
      setMfaRequired(true);
      return { mfaRequired: true };
    }
    if (res.user) {
      setUser(res.user);
    }
    return { mfaRequired: false };
  }, []);

  const verifyMfa = useCallback(async (code: string, isBackupCode = false) => {
    const res = await post<MfaVerifyResponse>("/api/auth/mfa/verify", {
      code,
      isBackupCode,
    });
    setMfaRequired(false);
    setUser(res.user);
  }, []);

  const cancelMfa = useCallback(() => {
    setMfaRequired(false);
  }, []);

  const register = useCallback(async (email: string, password: string, captchaToken?: string, referralCode?: string) => {
    const res = await post<{ user: AuthUser }>("/api/auth/register", {
      email,
      password,
      ...(captchaToken ? { captchaToken } : {}),
      ...(referralCode ? { referralCode } : {}),
    });
    setUser(res.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await post("/api/auth/logout", {});
    } catch {
      console.warn("Server-side logout failed");
    }
    setUser(null);
    setMfaRequired(false);
  }, []);

  const walletChallenge = useCallback(async (address: string): Promise<WalletChallengeResponse> => {
    return post<WalletChallengeResponse>("/api/auth/wallet/challenge", { address });
  }, []);

  const walletLogin = useCallback(async (address: string, signature: string) => {
    const res = await post<WalletVerifyResponse>("/api/auth/wallet/verify", {
      address,
      signature,
    });
    setUser(res.user);
  }, []);

  const isAdmin = user?.is_admin ?? false;
  const adminRole: AdminRole = user?.admin_role ?? "none";

  return (
    <AuthContext.Provider value={{ user, isAdmin, adminRole, loading, mfaRequired, login, verifyMfa, cancelMfa, register, logout, walletChallenge, walletLogin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
