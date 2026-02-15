export class DominusNodeError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "DominusNodeError";
  }
}

export class AuthenticationError extends DominusNodeError {
  constructor(message = "Authentication failed") {
    super(message, 401);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends DominusNodeError {
  constructor(message = "Access denied") {
    super(message, 403);
    this.name = "AuthorizationError";
  }
}

export class RateLimitError extends DominusNodeError {
  public readonly retryAfterSeconds: number;
  constructor(message = "Rate limit exceeded", retryAfter = 60) {
    super(message, 429);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfter;
  }
}

export class InsufficientBalanceError extends DominusNodeError {
  constructor(message = "Insufficient balance") {
    super(message, 402);
    this.name = "InsufficientBalanceError";
  }
}

export class ValidationError extends DominusNodeError {
  constructor(message = "Validation failed") {
    super(message, 400);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends DominusNodeError {
  constructor(message = "Resource not found") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DominusNodeError {
  constructor(message = "Resource conflict") {
    super(message, 409);
    this.name = "ConflictError";
  }
}

export class ServerError extends DominusNodeError {
  constructor(message = "Server error") {
    super(message, 500);
    this.name = "ServerError";
  }
}

export class NetworkError extends DominusNodeError {
  constructor(message = "Network error") {
    super(message);
    this.name = "NetworkError";
  }
}

export class ProxyError extends DominusNodeError {
  public readonly proxyErrorCode?: string;
  constructor(message: string, proxyErrorCode?: string) {
    super(message);
    this.name = "ProxyError";
    this.proxyErrorCode = proxyErrorCode;
  }
}
