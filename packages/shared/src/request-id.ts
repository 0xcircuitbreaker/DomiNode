import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Request ids: accepted from the client's X-Request-Id when well formed,
 * otherwise generated. Carried through async work with AsyncLocalStorage so
 * every log line written while handling a request includes it.
 */

export const REQUEST_ID_HEADER = "X-Request-Id";
const VALID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Use the incoming id when it is 1-64 chars of [A-Za-z0-9._:-]; else a new UUID. */
export function resolveRequestId(incoming: unknown): string {
  const v = Array.isArray(incoming) ? incoming[0] : incoming;
  return typeof v === "string" && VALID.test(v) ? v : randomUUID();
}

const store = new AsyncLocalStorage<{ requestId: string }>();

/** Run fn with requestId bound for logging. */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return store.run({ requestId }, fn);
}

/** The request id bound to the current async context, if any. */
export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId;
}
