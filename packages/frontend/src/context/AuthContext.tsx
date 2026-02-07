import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { post, setToken, setRefreshToken, clearToken, getToken } from "../api/client";

const ADMIN_KEY = "dominode_is_admin";

interface AuthUser {
  id: string;
  email: string;
  is_admin: boolean;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  isAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

interface AuthResponse {
  token: string;
  refreshToken: string;
  user: AuthUser;
}

function loadInitialState(): { user: AuthUser | null; token: string | null } {
  const token = getToken();
  if (!token) return { user: null, token: null };

  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    // Validate payload structure
    if (typeof payload.userId !== "string" || typeof payload.email !== "string") {
      clearToken();
      return { user: null, token: null };
    }
    const isAdmin = localStorage.getItem(ADMIN_KEY) === "true";
    return {
      token,
      user: { id: payload.userId, email: payload.email, is_admin: isAdmin },
    };
  } catch {
    clearToken();
    return { user: null, token: null };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const initial = loadInitialState();
  const [user, setUser] = useState<AuthUser | null>(initial.user);
  const [token, setTokenState] = useState<string | null>(initial.token);

  const login = useCallback(async (email: string, password: string) => {
    const res = await post<AuthResponse>("/api/auth/login", {
      email,
      password,
    });
    setToken(res.token);
    setRefreshToken(res.refreshToken);
    setTokenState(res.token);
    localStorage.setItem(ADMIN_KEY, String(res.user.is_admin ?? false));
    setUser(res.user);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const res = await post<AuthResponse>("/api/auth/register", {
      email,
      password,
    });
    setToken(res.token);
    setRefreshToken(res.refreshToken);
    setTokenState(res.token);
    localStorage.setItem(ADMIN_KEY, String(res.user.is_admin ?? false));
    setUser(res.user);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    localStorage.removeItem(ADMIN_KEY);
    setTokenState(null);
    setUser(null);
  }, []);

  const isAdmin = user?.is_admin ?? false;

  return (
    <AuthContext.Provider value={{ user, token, isAdmin, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
