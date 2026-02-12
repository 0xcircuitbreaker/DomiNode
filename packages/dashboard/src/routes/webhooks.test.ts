import { describe, it, expect, vi } from "vitest";
import { webhookIpCheck } from "./webhooks.js";
import type { Request, Response, NextFunction } from "express";

function mockReq(ip: string): Partial<Request> {
  return {
    ip,
    socket: { remoteAddress: ip } as never,
  };
}

function mockRes(): Partial<Response> & { statusCode: number; body: unknown } {
  const res: Partial<Response> & { statusCode: number; body: unknown } = {
    statusCode: 0,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res as Response;
    },
    json(obj: unknown) {
      res.body = obj;
      return res as Response;
    },
  };
  return res;
}

describe("webhookIpCheck", () => {
  it("should allow request from an IP in the allowlist", () => {
    const allowedIps = new Set(["1.2.3.4", "5.6.7.8"]);
    const middleware = webhookIpCheck(allowedIps, "test");
    const req = mockReq("1.2.3.4");
    const res = mockRes();
    const next = vi.fn();

    middleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0); // not set
  });

  it("should reject request from an IP not in the allowlist", () => {
    const allowedIps = new Set(["1.2.3.4"]);
    const middleware = webhookIpCheck(allowedIps, "test");
    const req = mockReq("9.9.9.9");
    const res = mockRes();
    const next = vi.fn();

    middleware(req as Request, res as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden" });
  });

  it("should skip IP check when allowlist is empty", () => {
    const allowedIps = new Set<string>();
    const middleware = webhookIpCheck(allowedIps, "test");
    const req = mockReq("9.9.9.9");
    const res = mockRes();
    const next = vi.fn();

    middleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalled();
  });

  it("should strip IPv6-mapped IPv4 prefix (::ffff:)", () => {
    const allowedIps = new Set(["10.0.0.1"]);
    const middleware = webhookIpCheck(allowedIps, "test");
    const req = mockReq("::ffff:10.0.0.1");
    const res = mockRes();
    const next = vi.fn();

    middleware(req as Request, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalled();
  });

  it("should reject IPv6-mapped IP that doesn't match", () => {
    const allowedIps = new Set(["10.0.0.1"]);
    const middleware = webhookIpCheck(allowedIps, "test");
    const req = mockReq("::ffff:10.0.0.2");
    const res = mockRes();
    const next = vi.fn();

    middleware(req as Request, res as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("should fall back to socket.remoteAddress when req.ip is undefined", () => {
    const allowedIps = new Set(["1.2.3.4"]);
    const middleware = webhookIpCheck(allowedIps, "test");
    const req = {
      ip: undefined,
      socket: { remoteAddress: "1.2.3.4" },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as Response, next as NextFunction);

    expect(next).toHaveBeenCalled();
  });

  it("should reject when both req.ip and socket.remoteAddress are undefined", () => {
    const allowedIps = new Set(["1.2.3.4"]);
    const middleware = webhookIpCheck(allowedIps, "test");
    const req = {
      ip: undefined,
      socket: { remoteAddress: undefined },
    } as unknown as Request;
    const res = mockRes();
    const next = vi.fn();

    middleware(req, res as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});
