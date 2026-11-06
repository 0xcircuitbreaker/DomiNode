/**
 * Error hierarchy. Every message passes through scrubCredentials() so API
 * keys (dn_live_/dn_test_/dn_node_/dn_proxy_) and JWTs never reach logs or
 * callers via error strings.
 */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /dn_(?:live|test|node|proxy)_[A-Za-z0-9_-]+/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
];

export function scrubCredentials(message: string): string {
  let out = String(message);
  for (const re of CREDENTIAL_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export class DominusNodeError extends Error {
  /** Server error code (`{code}` in the error body), e.g. "INVALID_CHALLENGE". */
  public readonly code?: string;
  /** Extra numeric detail the server sent (e.g. `max` for CAP_ABOVE_DEFAULT, `cap` for node limit). */
  public readonly details?: Record<string, number | string>;
  constructor(message: string, public readonly statusCode?: number, code?: string, details?: Record<string, number | string>) {
    super(scrubCredentials(message));
    this.name = "DominusNodeError";
    if (code !== undefined) this.code = code;
    if (details !== undefined) this.details = details;
  }
}

type Extra = [code?: string, details?: Record<string, number | string>];

export class AuthenticationError extends DominusNodeError {
  constructor(message = "Authentication failed", ...x: Extra) { super(message, 401, ...x); this.name = "AuthenticationError"; }
}
export class InsufficientBalanceError extends DominusNodeError {
  constructor(message = "Insufficient balance", ...x: Extra) { super(message, 402, ...x); this.name = "InsufficientBalanceError"; }
}
export class AuthorizationError extends DominusNodeError {
  constructor(message = "Access denied", ...x: Extra) { super(message, 403, ...x); this.name = "AuthorizationError"; }
}
export class NotFoundError extends DominusNodeError {
  constructor(message = "Resource not found", ...x: Extra) { super(message, 404, ...x); this.name = "NotFoundError"; }
}
export class ConflictError extends DominusNodeError {
  constructor(message = "Resource conflict", ...x: Extra) { super(message, 409, ...x); this.name = "ConflictError"; }
}
export class RateLimitError extends DominusNodeError {
  public readonly retryAfterSeconds: number;
  constructor(message = "Rate limit exceeded", retryAfter = 60, ...x: Extra) {
    super(message, 429, ...x);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfter;
  }
}
export class ServerError extends DominusNodeError {
  constructor(message = "Server error", status = 500, ...x: Extra) { super(message, status, ...x); this.name = "ServerError"; }
}
/** HTTP 400, or a client-side argument check that failed before any request was sent (statusCode undefined). */
export class ValidationError extends DominusNodeError {
  constructor(message = "Validation failed", status: number | undefined = 400, ...x: Extra) { super(message, status, ...x); this.name = "ValidationError"; }
}
export class NetworkError extends DominusNodeError {
  constructor(message = "Network error") { super(message); this.name = "NetworkError"; }
}
/** The server sent something the SDK refuses to act on (e.g. a challenge message that differs from the locally built one). */
export class ProtocolError extends DominusNodeError {
  constructor(message: string) { super(message); this.name = "ProtocolError"; }
}
/** Failure inside proxy.fetch(): blocked target, tunnel refused, size cap, timeout. */
export class ProxyError extends DominusNodeError {
  constructor(message: string, statusCode?: number) { super(message, statusCode); this.name = "ProxyError"; }
}

/** Client-side argument validation failure (no request sent). */
export function invalidArg(message: string): ValidationError {
  return new ValidationError(message, undefined, "INVALID_ARGUMENT");
}
