// ─── Extension State ──────────────────────────────────────────────
export interface ExtensionState {
  // Auth
  apiKey: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  userId: string | null;
  email: string | null;

  // MFA
  mfaPending: boolean;
  mfaChallengeToken: string | null;

  // Proxy config
  proxyEnabled: boolean;
  proxyProtocol: "http" | "socks5";
  country: string; // ISO 3166-1 alpha-2 (e.g., "US")
  state: string; // lowercase state name (e.g., "california")
  city: string; // lowercase city name (e.g., "losangeles")
  asn: number | null; // ASN number (placeholder)
  stickySession: boolean;
  sessionId: string | null;
  rotationIntervalMinutes: number; // 0 = no auto-rotation

  // Runtime
  balanceCents: number;
  isConnected: boolean;
  lastError: string | null;
}

export const DEFAULT_STATE: ExtensionState = {
  apiKey: null,
  accessToken: null,
  refreshToken: null,
  userId: null,
  email: null,
  mfaPending: false,
  mfaChallengeToken: null,
  proxyEnabled: false,
  proxyProtocol: "http",
  country: "US",
  state: "",
  city: "",
  asn: null,
  stickySession: false,
  sessionId: null,
  rotationIntervalMinutes: 0,
  balanceCents: 0,
  isConnected: false,
  lastError: null,
};

// ─── Messages (popup/options ↔ background) ────────────────────────
export type MessageType =
  | "LOGIN"
  | "LOGIN_WITH_KEY"
  | "VERIFY_MFA"
  | "LOGOUT"
  | "TOGGLE_PROXY"
  | "SET_COUNTRY"
  | "SET_STATE"
  | "SET_CITY"
  | "SET_ASN"
  | "SET_PROTOCOL"
  | "SET_STICKY"
  | "SET_ROTATION"
  | "GET_STATE"
  | "ROTATE_SESSION"
  | "REFRESH_BALANCE";

export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
}

export interface MessageResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ─── Proxy Config ─────────────────────────────────────────────────
export interface ProxyServerConfig {
  httpProxy: { host: string; port: number };
  socks5Proxy: { host: string; port: number };
  supportedCountries: string[];
  blockedCountries: string[];
}

// ─── Adapter Proxy Config ────────────────────────────────────────
export interface ProxyAdapterConfig {
  host: string;
  port: number;
  protocol: "http" | "socks5";
  username: string;
  password: string;
}
