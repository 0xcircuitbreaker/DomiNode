import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { humanAuthGate, isHumanAuthPath, requireHumanLogin } from "./human-auth.js";

async function hit(path: string): Promise<number> {
  const app = express();
  const r = express.Router();
  r.use(humanAuthGate);
  const ok = (_q: express.Request, s: express.Response): void => {
    s.json({ ok: true });
  };
  r.post("/login", ok);
  r.post("/register", ok);
  r.post("/forgot-password", ok);
  r.post("/reset-password", ok);
  r.post("/mfa/verify", ok);
  r.post("/refresh", ok);
  app.use("/api/auth", r);
  const srv = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => srv.once("listening", () => resolve()));
  try {
    const { port } = srv.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST" });
    return res.status;
  } finally {
    srv.close();
  }
}

describe("humanAuthGate with ADMIN_HUMAN_LOGIN off", () => {
  afterEach(() => {
    delete process.env["ADMIN_HUMAN_LOGIN"];
  });

  for (const p of [
    "/api/auth/login",
    "/api/auth/LOGIN",
    "/api/auth/login/",
    "/api/auth/Login//",
    "/api/auth/Register",
    "/api/auth/Forgot-Password/",
    "/api/auth/RESET-PASSWORD",
    "/api/auth/Mfa/verify",
    "/api/auth/MFA/Verify/",
  ]) {
    it(`404s ${p}`, async () => {
      expect(await hit(p)).toBe(404);
    });
  }

  it("leaves non-human routes alone", async () => {
    expect(await hit("/api/auth/refresh")).toBe(200);
  });

  it("lets variants through when enabled", async () => {
    process.env["ADMIN_HUMAN_LOGIN"] = "true";
    expect(await hit("/api/auth/LOGIN")).toBe(200);
  });

  it("isHumanAuthPath normalizes case and trailing slashes", () => {
    expect(isHumanAuthPath("/MFA")).toBe(true);
    expect(isHumanAuthPath("/reset-password/")).toBe(true);
    expect(isHumanAuthPath("/mfaother")).toBe(false);
    expect(isHumanAuthPath("/refresh")).toBe(false);
  });

  it("requireHumanLogin answers 404 when off and calls next when on", () => {
    let code = 0;
    let called = false;
    const res = {
      status(c: number) {
        code = c;
        return this;
      },
      json() {
        return this;
      },
    };
    requireHumanLogin({} as never, res as never, () => {
      called = true;
    });
    expect(code).toBe(404);
    expect(called).toBe(false);
    process.env["ADMIN_HUMAN_LOGIN"] = "true";
    requireHumanLogin({} as never, res as never, () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
