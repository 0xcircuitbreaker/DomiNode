import crypto from "node:crypto";

/** Minimum length for API_METRICS_SECRET; shorter values are ignored (fail closed). */
export const MIN_METRICS_SECRET_LENGTH = 32;

/**
 * Access rule for the API's Prometheus /metrics endpoint.
 *
 * Loopback callers (socket address, never X-Forwarded-For) are always allowed.
 * Anyone else needs "Authorization: Bearer <API_METRICS_SECRET>", and only when
 * that secret is set and at least MIN_METRICS_SECRET_LENGTH characters long.
 * With no usable secret, non-loopback callers are refused.
 */
export function metricsAccessAllowed(
  remoteAddress: string | undefined,
  authorization: string | string[] | undefined,
  secret: string | undefined,
): boolean {
  const ip = (remoteAddress ?? "").replace(/^::ffff:/, "");
  if (ip === "127.0.0.1" || ip === "::1") return true;
  if (!secret || secret.length < MIN_METRICS_SECRET_LENGTH) return false;
  if (typeof authorization !== "string") return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(authorization);
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}
