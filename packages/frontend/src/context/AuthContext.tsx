import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";
import { post, get } from "../api/client";

interface AuthUser {
  id: string;
  email: string;
  is_admin: boolean;
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
  loading: boolean;
  mfaRequired: boolean;
  login: (email: string, password: string) => Promise<{ mfaRequired: boolean }>;
  verifyMfa: (code: string, isBackupCode?: boolean) => Promise<void>;
  cancelMfa: () => void;
  register: (email: string, password: string, captchaToken?: string) => Promise<void>;
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
    get<MeResponse>("/api/auth/me", { redirectOnUnauthorized: false })
      .then((data) => {
        setUser(data.user);
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const login = useCallback(async (email: string, password: string): Promise<{ mfaRequired: boolean }> => {
    const res = await post<LoginResponse>("/api/auth/login", {
      email,
      password,
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

  const register = useCallback(async (email: string, password: string, captchaToken?: string) => {
    const res = await post<{ user: AuthUser }>("/api/auth/register", {
      email,
      password,
      ...(captchaToken ? { captchaToken } : {}),
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

  return (
    <AuthContext.Provider value={{ user, isAdmin, loading, mfaRequired, login, verifyMfa, cancelMfa, register, logout, walletChallenge, walletLogin }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
