/**
 * Agent-facing refusal for an engaged admin kill switch (ADMIN_API.md §17).
 * 503 + Retry-After + X-DominusNode-Error, body { error, code }.
 */
import type { Response } from "express";
import { killSwitches, type KillSwitchBlock, type PaymentRailSwitch } from "@dominusnode/shared";

export function sendKillSwitchBlock(res: Response, b: KillSwitchBlock): void {
  res.setHeader("Retry-After", String(b.retryAfterSec));
  res.setHeader("X-DominusNode-Error", b.code);
  res.status(b.status).json({ error: b.message, code: b.code });
}

/** Returns true (and responds) when the switch refuses the request. */
export function refusedBySwitch(res: Response, key: "signups" | "api_keys" | "payouts"): boolean {
  const b = killSwitches().check(key);
  if (!b) return false;
  sendKillSwitchBlock(res, b);
  return true;
}

export function refusedByRail(res: Response, rail: PaymentRailSwitch): boolean {
  const b = killSwitches().checkRail(rail);
  if (!b) return false;
  sendKillSwitchBlock(res, b);
  return true;
}
