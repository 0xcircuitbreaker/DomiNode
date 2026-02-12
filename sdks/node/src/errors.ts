export class DomiNodeError extends Error {
  constructor(message: string, public readonly statusCode?: number) {
    super(message);
    this.name = "DomiNodeError";
  }
}

export class AuthenticationError extends DomiNodeError {
  constructor(message = "Authentication failed") {
    super(message, 401);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends DomiNodeError {
  constructor(message = "Access denied") {
    super(message, 403);
    this.name = "AuthorizationError";
  }
}

export class RateLimitError extends DomiNodeError {
  public readonly retryAfterSeconds: number;
  constructor(message = "Rate limit exceeded", retryAfter = 60) {
    super(message, 429);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfter;
  }
}

export class InsufficientBalanceError extends DomiNodeError {
  constructor(message = "Insufficient balance") {
    super(message, 402);
    this.name = "InsufficientBalanceError";
  }
}

export class ValidationError extends DomiNodeError {
  constructor(message = "Validation failed") {
    super(message, 400);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends DomiNodeError {
  constructor(message = "Resource not found") {
    super(message, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DomiNodeError {
  constructor(message = "Resource conflict") {
    super(message, 409);
    this.name = "ConflictError";
  }
}

export class ServerError extends DomiNodeError {
  constructor(message = "Server error") {
    super(message, 500);
    this.name = "ServerError";
  }
}

export class NetworkError extends DomiNodeError {
  constructor(message = "Network error") {
    super(message);
    this.name = "NetworkError";
  }
}

export class ProxyError extends DomiNodeError {
  public readonly proxyErrorCode?: string;
  constructor(message: string, proxyErrorCode?: string) {
    super(message);
    this.name = "ProxyError";
    this.proxyErrorCode = proxyErrorCode;
  }
}
