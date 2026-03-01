import { describe, it, expect, vi, beforeEach } from "vitest";
import { setAuthCookies, clearAuthCookies, getAccessCookieName, getRefreshCookieName } from "./cookies.js";

describe("cookies helper", () => {
  let res: { cookie: ReturnType<typeof vi.fn>; clearCookie: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    res = {
      cookie: vi.fn(),
      clearCookie: vi.fn(),
    };
  });

  it("should return correct cookie names", () => {
    expect(getAccessCookieName()).toBe("dominusnode_access");
    expect(getRefreshCookieName()).toBe("dominusnode_refresh");
  });

  it("should set access and refresh cookies", () => {
    setAuthCookies(res as never, "access-token-123", "refresh-token-456");

    expect(res.cookie).toHaveBeenCalledTimes(2);

    // Access cookie
    const [accessName, accessValue, accessOpts] = res.cookie.mock.calls[0];
    expect(accessName).toBe("dominusnode_access");
    expect(accessValue).toBe("access-token-123");
    expect(accessOpts.httpOnly).toBe(true);
    expect(accessOpts.sameSite).toBe("strict");
    expect(accessOpts.path).toBe("/api");
    expect(accessOpts.maxAge).toBe(15 * 60 * 1000);

    // Refresh cookie — restricted to /api/auth path
    const [refreshName, refreshValue, refreshOpts] = res.cookie.mock.calls[1];
    expect(refreshName).toBe("dominusnode_refresh");
    expect(refreshValue).toBe("refresh-token-456");
    expect(refreshOpts.httpOnly).toBe(true);
    expect(refreshOpts.sameSite).toBe("strict");
    expect(refreshOpts.path).toBe("/api/auth");
    expect(refreshOpts.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("should clear all auth cookies including MFA challenge", () => {
    clearAuthCookies(res as never);

    // clearAuthCookies now clears 3 cookies (access + refresh + MFA challenge)
    expect(res.clearCookie).toHaveBeenCalledTimes(3);
    expect(res.clearCookie).toHaveBeenCalledWith("dominusnode_access", expect.objectContaining({
      httpOnly: true,
      sameSite: "strict",
      path: "/api",
    }));
    expect(res.clearCookie).toHaveBeenCalledWith("dominusnode_refresh", expect.objectContaining({
      httpOnly: true,
      sameSite: "strict",
      path: "/api/auth",
    }));
    expect(res.clearCookie).toHaveBeenCalledWith("dominusnode_mfa_challenge", expect.objectContaining({
      httpOnly: true,
      sameSite: "strict",
      path: "/api/auth/mfa",
    }));
  });

  it("should set secure=false when NODE_ENV is not production", () => {
    setAuthCookies(res as never, "a", "b");
    const [, , opts] = res.cookie.mock.calls[0];
    expect(opts.secure).toBe(false);
  });
});
