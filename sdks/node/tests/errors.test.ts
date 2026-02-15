import { describe, it, expect } from "vitest";
import {
  DominusNodeError,
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  InsufficientBalanceError,
  ValidationError,
  NotFoundError,
  ConflictError,
  ServerError,
  NetworkError,
  ProxyError,
} from "../src/errors.js";

describe("Error hierarchy", () => {
  it("DominusNodeError stores message and statusCode", () => {
    const err = new DominusNodeError("test error", 418);
    expect(err.message).toBe("test error");
    expect(err.statusCode).toBe(418);
    expect(err.name).toBe("DominusNodeError");
    expect(err instanceof Error).toBe(true);
  });

  it("AuthenticationError defaults to 401", () => {
    const err = new AuthenticationError();
    expect(err.statusCode).toBe(401);
    expect(err.name).toBe("AuthenticationError");
    expect(err instanceof DominusNodeError).toBe(true);
  });

  it("AuthorizationError defaults to 403", () => {
    const err = new AuthorizationError();
    expect(err.statusCode).toBe(403);
    expect(err.name).toBe("AuthorizationError");
  });

  it("RateLimitError stores retryAfterSeconds", () => {
    const err = new RateLimitError("slow down", 30);
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.name).toBe("RateLimitError");
  });

  it("RateLimitError defaults retryAfterSeconds to 60", () => {
    const err = new RateLimitError();
    expect(err.retryAfterSeconds).toBe(60);
  });

  it("InsufficientBalanceError defaults to 402", () => {
    const err = new InsufficientBalanceError();
    expect(err.statusCode).toBe(402);
    expect(err.name).toBe("InsufficientBalanceError");
  });

  it("ValidationError defaults to 400", () => {
    const err = new ValidationError("bad input");
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("bad input");
  });

  it("NotFoundError defaults to 404", () => {
    const err = new NotFoundError();
    expect(err.statusCode).toBe(404);
  });

  it("ConflictError defaults to 409", () => {
    const err = new ConflictError("duplicate");
    expect(err.statusCode).toBe(409);
    expect(err.message).toBe("duplicate");
  });

  it("ServerError defaults to 500", () => {
    const err = new ServerError();
    expect(err.statusCode).toBe(500);
    expect(err.name).toBe("ServerError");
  });

  it("NetworkError has no statusCode", () => {
    const err = new NetworkError("ECONNREFUSED");
    expect(err.statusCode).toBeUndefined();
    expect(err.name).toBe("NetworkError");
  });

  it("ProxyError stores optional proxyErrorCode", () => {
    const err = new ProxyError("tunnel failed", "PROXY_TIMEOUT");
    expect(err.proxyErrorCode).toBe("PROXY_TIMEOUT");
    expect(err.name).toBe("ProxyError");
    expect(err.statusCode).toBeUndefined();
  });

  it("all error types can be caught as DominusNodeError", () => {
    const errors = [
      new AuthenticationError(),
      new AuthorizationError(),
      new RateLimitError(),
      new InsufficientBalanceError(),
      new ValidationError(),
      new NotFoundError(),
      new ConflictError(),
      new ServerError(),
      new NetworkError(),
      new ProxyError("err"),
    ];

    for (const err of errors) {
      expect(err instanceof DominusNodeError).toBe(true);
    }
  });
});
