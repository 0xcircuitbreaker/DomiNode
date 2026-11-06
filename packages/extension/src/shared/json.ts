const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Recursively remove prototype-pollution keys (in place). Returns the input. */
export function stripDangerousKeys<T>(obj: T, depth = 0): T {
  if (depth > 50 || !obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    for (const item of obj) stripDangerousKeys(item, depth + 1);
    return obj;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (DANGEROUS_KEYS.has(key)) delete record[key];
    else if (record[key] && typeof record[key] === "object") stripDangerousKeys(record[key], depth + 1);
  }
  return obj;
}

/** JSON.parse with a size cap and prototype-pollution stripping. */
export function safeParse(text: string, maxBytes = 1024 * 1024): unknown {
  if (text.length > maxBytes) throw new Error("JSON too large");
  return stripDangerousKeys(JSON.parse(text));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}
