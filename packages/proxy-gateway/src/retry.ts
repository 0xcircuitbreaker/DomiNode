import * as http from "node:http";
import { createLogger } from "@dominode/shared";

const log = createLogger("proxy:retry");

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  retryableStatuses: Set<number>;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: parseInt(process.env["PROXY_MAX_RETRIES"] ?? "2", 10),
  baseDelayMs: parseInt(process.env["PROXY_RETRY_BASE_DELAY_MS"] ?? "200", 10),
  retryableStatuses: new Set([502, 503]),
};

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

/**
 * Execute an HTTP request function with retry logic.
 *
 * If the response status is retryable (502, 503 by default),
 * waits with exponential backoff and retries up to maxRetries times.
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

    lastResponse = await requestFn();
    const status = lastResponse.statusCode ?? 0;

    // If not retryable, return immediately
    if (!options.retryableStatuses.has(status)) {
      return { response: lastResponse, retries, totalDelayMs };
    }

    // If this was the last allowed attempt, return the failing response
    if (attempt === options.maxRetries) {
      break;
    }

    // Calculate exponential backoff: baseDelay * 2^attempt
    const delayMs = options.baseDelayMs * Math.pow(2, attempt);
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
