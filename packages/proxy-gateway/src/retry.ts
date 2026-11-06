import * as http from "node:http";
import { createLogger } from "@dominusnode/shared";

const log = createLogger("proxy:retry");

/** Socket error codes that are safe to retry */
export const RETRYABLE_ERRORS = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN", // DNS temporary failure
]);

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  retryableStatuses: Set<number>;
  retryableErrors: Set<string>;
  jitter: boolean;
}

// Validate retry config env vars for NaN/range
const parsedMaxRetries = parseInt(process.env["PROXY_MAX_RETRIES"] ?? "2", 10);
const parsedBaseDelay = parseInt(process.env["PROXY_RETRY_BASE_DELAY_MS"] ?? "200", 10);

if (isNaN(parsedMaxRetries) || parsedMaxRetries < 0 || parsedMaxRetries > 10) {
  throw new Error("PROXY_MAX_RETRIES must be between 0 and 10");
}
if (isNaN(parsedBaseDelay) || parsedBaseDelay < 0 || parsedBaseDelay > 10000) {
  throw new Error("PROXY_RETRY_BASE_DELAY_MS must be between 0 and 10000");
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: parsedMaxRetries,
  baseDelayMs: parsedBaseDelay,
  retryableStatuses: new Set([502, 503]),
  retryableErrors: RETRYABLE_ERRORS,
  jitter: true,
};

// No-retry options for non-idempotent HTTP methods (POST/PUT/DELETE/PATCH)
export const NO_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 0,
  baseDelayMs: 0,
  retryableStatuses: new Set(),
  retryableErrors: new Set(),
  jitter: false,
};

/** Safe HTTP methods that can be retried without risk of duplicate side effects */
export const SAFE_RETRY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Get appropriate retry options based on HTTP method */
export function getRetryOptionsForMethod(method: string): RetryOptions {
  return SAFE_RETRY_METHODS.has(method.toUpperCase()) ? DEFAULT_RETRY_OPTIONS : NO_RETRY_OPTIONS;
}

export interface RetryResult {
  response: http.IncomingMessage;
  retries: number;
  totalDelayMs: number;
}

/**
 * Sleep for the given number of milliseconds.
 * Exported for testability (can be mocked to avoid real delays).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Make an HTTP request that returns an IncomingMessage.
 * This is the operation type that executeWithRetry wraps.
 */
export type RequestFn = () => Promise<http.IncomingMessage>;

/** Add random jitter to delay (0-50% of base delay) */
function addJitter(delayMs: number): number {
  return delayMs + Math.floor(Math.random() * delayMs * 0.5);
}

/** Check if an error is retryable based on its code */
function isRetryableError(err: unknown, retryableErrors: Set<string>): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code != null && retryableErrors.has(code);
}

/**
 * Execute an HTTP request function with retry logic.
 *
 * Retries on retryable HTTP status codes (502, 503 by default)
 * and retryable socket errors (ECONNREFUSED, ECONNRESET, ETIMEDOUT, etc.).
 * Uses exponential backoff with optional jitter.
 *
 * The caller is responsible for consuming/destroying the returned response.
 * Intermediate retryable responses are destroyed before retrying.
 */
export async function executeWithRetry(
  requestFn: RequestFn,
  options: RetryOptions = DEFAULT_RETRY_OPTIONS,
): Promise<RetryResult> {
  let lastResponse: http.IncomingMessage | undefined;
  let retries = 0;
  let totalDelayMs = 0;

  for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
    // Destroy previous response body if retrying
    if (lastResponse) {
      lastResponse.destroy();
    }

    try {
      lastResponse = await requestFn();
    } catch (err) {
      // Check if this is a retryable connection error
      if (attempt < options.maxRetries && isRetryableError(err, options.retryableErrors)) {
        const baseDelay = options.baseDelayMs * Math.pow(2, attempt);
        const delayMs = options.jitter ? addJitter(baseDelay) : baseDelay;
        totalDelayMs += delayMs;
        retries++;

        log.warn("retrying after connection error", {
          attempt: attempt + 1,
          maxRetries: options.maxRetries,
          error: (err as NodeJS.ErrnoException).code,
          delayMs,
        });

        await sleep(delayMs);
        continue;
      }
      // Non-retryable error or retries exhausted — propagate
      throw err;
    }

    const status = lastResponse.statusCode ?? 0;

    // If not retryable, return immediately
    if (!options.retryableStatuses.has(status)) {
      return { response: lastResponse, retries, totalDelayMs };
    }

    // If this was the last allowed attempt, return the failing response
    if (attempt === options.maxRetries) {
      break;
    }

    // Calculate exponential backoff with optional jitter
    const baseDelay = options.baseDelayMs * Math.pow(2, attempt);
    const delayMs = options.jitter ? addJitter(baseDelay) : baseDelay;
    totalDelayMs += delayMs;
    retries++;

    log.warn("retrying upstream request", {
      attempt: attempt + 1,
      maxRetries: options.maxRetries,
      status,
      delayMs,
    });

    await sleep(delayMs);
  }

  // All retries exhausted — return the last response
  return { response: lastResponse!, retries, totalDelayMs };
}

/**
 * Wrap a Node.js http.request call into a Promise that resolves
 * with the IncomingMessage (response).
 *
 * The returned promise rejects on connection errors.
 * The caller should pipe the request body after calling this.
 */
export function promisifyRequest(
  reqOptions: http.RequestOptions,
  body?: Buffer | string | null,
): Promise<http.IncomingMessage> {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request(reqOptions, (res) => {
      resolve(res);
    });

    req.on("error", reject);

    if (body != null) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

// ─── Relay node retry (DESIGN.md §4 step 5, §8) ─────────────────────

/** OPEN_ERR codes that may be retried once on a different node. */
export const NODE_RETRY_CODES: ReadonlySet<string> = new Set(["DIAL_FAIL", "DNS_FAIL"]);

/**
 * Open an upstream via `attempt(excludeNodeIds)`, retrying exactly once on a
 * different node when the first failure carries a DIAL_FAIL/DNS_FAIL code.
 * Anything else (FLOOR_BLOCKED, PORT_BLOCKED, CAP_EXCEEDED, timeouts,
 * selection errors) is rethrown immediately.
 */
export async function withNodeRetry<T>(
  attempt: (excludeNodeIds: string[]) => Promise<{ nodeId: string; value: T }>,
  failedNodeId: (err: unknown) => string | null,
  codeOf: (err: unknown) => string | null,
): Promise<{ nodeId: string; value: T; retries: number }> {
  try {
    const r = await attempt([]);
    return { ...r, retries: 0 };
  } catch (err) {
    const code = codeOf(err);
    const nodeId = failedNodeId(err);
    if (!code || !NODE_RETRY_CODES.has(code) || !nodeId) throw err;
    log.warn("relay open failed, retrying on another node", { code });
    const r = await attempt([nodeId]);
    return { ...r, retries: 1 };
  }
}
