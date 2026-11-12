/**
 * Opaque keyset cursor for lists ordered by (created_at DESC, id DESC).
 * Encoded as base64url("<ISO timestamp>|<uuid>"). Clients must treat it as
 * opaque and pass it back as ?cursor=.
 */

export interface KeysetCursor {
  createdAt: Date;
  id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");
}

/** Decode a cursor; null when malformed (callers answer 400 INVALID_CURSOR). */
export function decodeCursor(raw: unknown): KeysetCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 128 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const s = Buffer.from(raw, "base64url").toString("utf8");
  const [ts, id, extra] = s.split("|");
  if (extra !== undefined || !ts || !id || !UUID_RE.test(id)) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime()) || d.toISOString() !== ts) return null;
  return { createdAt: d, id: id.toLowerCase() };
}
