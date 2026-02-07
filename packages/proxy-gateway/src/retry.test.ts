import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IncomingMessage } from "node:http";

// Mock @dominode/shared to avoid module load issues
vi.mock("@dominode/shared", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Instead of trying to mock sleep within the same module (which doesn't work
// with vi.mock partial mocking), we mock setTimeout directly to make sleep instant.
vi.useFakeTimers();

import { executeWithRetry, sleep, promisifyRequest, type RetryOptions, type RequestFn } from "./retry.js";
import * as http from "node:http";

/** Helper to create a fake IncomingMessage with the given status code */
function fakeResponse(statusCode: number): IncomingMessage {
  return {
    statusCode,
    headers: {},
    destroy: vi.fn(),
  } as unknown as IncomingMessage;
}

// Helper that advances timers so sleep() resolves immediately
async function flushSleep(): Promise<void> {
  await vi.advanceTimersByTimeAsync(10_000);
}

describe("proxy-gateway/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const defaultOpts: RetryOptions = {
    maxRetries: 2,
    baseDelayMs: 200,
    retryableStatuses: new Set([502, 503]),
  };

  describe("sleep", () => {
    it("should resolve after the given delay", async () => {
      const promise = sleep(100);
      vi.advanceTimersByTime(100);
      await promise;
    });
  });

  describe("executeWithRetry", () => {
    it("should succeed on first try with no retries", async () => {
      const response = fakeResponse(200);
      const requestFn: RequestFn = vi.fn().mockResolvedValue(response);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(response);
      expect(result.retries).toBe(0);
      expect(result.totalDelayMs).toBe(0);
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it("should retry on 502 and succeed on second attempt", async () => {
      const failResponse = fakeResponse(502);
      const successResponse = fakeResponse(200);
      const requestFn: RequestFn = vi.fn()
        .mockResolvedValueOnce(failResponse)
        .mockResolvedValueOnce(successResponse);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(successResponse);
      expect(result.retries).toBe(1);
      expect(result.totalDelayMs).toBe(200); // baseDelay * 2^0 = 200
      expect(requestFn).toHaveBeenCalledTimes(2);
      // The first failed response should be destroyed
      expect(failResponse.destroy).toHaveBeenCalled();
    });

    it("should retry on 503 and succeed on third attempt", async () => {
      const fail1 = fakeResponse(503);
      const fail2 = fakeResponse(503);
      const success = fakeResponse(200);
      const requestFn: RequestFn = vi.fn()
        .mockResolvedValueOnce(fail1)
        .mockResolvedValueOnce(fail2)
        .mockResolvedValueOnce(success);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(success);
      expect(result.retries).toBe(2);
      // baseDelay * 2^0 + baseDelay * 2^1 = 200 + 400 = 600
      expect(result.totalDelayMs).toBe(600);
      expect(requestFn).toHaveBeenCalledTimes(3);
      expect(fail1.destroy).toHaveBeenCalled();
      expect(fail2.destroy).toHaveBeenCalled();
    });

    it("should give up after maxRetries exhausted and return last response", async () => {
      const fail1 = fakeResponse(502);
      const fail2 = fakeResponse(502);
      const fail3 = fakeResponse(502);
      const requestFn: RequestFn = vi.fn()
        .mockResolvedValueOnce(fail1)
        .mockResolvedValueOnce(fail2)
        .mockResolvedValueOnce(fail3);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      // Should return the last failed response (after all retries)
      expect(result.response).toBe(fail3);
      expect(result.retries).toBe(2);
      expect(result.totalDelayMs).toBe(600);
      expect(requestFn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it("should not retry on non-retryable status 404", async () => {
      const response = fakeResponse(404);
      const requestFn: RequestFn = vi.fn().mockResolvedValue(response);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(response);
      expect(result.retries).toBe(0);
      expect(result.totalDelayMs).toBe(0);
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it("should not retry on non-retryable status 500", async () => {
      const response = fakeResponse(500);
      const requestFn: RequestFn = vi.fn().mockResolvedValue(response);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(response);
      expect(result.retries).toBe(0);
      expect(result.totalDelayMs).toBe(0);
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it("should not retry on status 200", async () => {
      const response = fakeResponse(200);
      const requestFn: RequestFn = vi.fn().mockResolvedValue(response);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(response);
      expect(result.retries).toBe(0);
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it("should use exponential backoff timing", async () => {
      const opts: RetryOptions = {
        maxRetries: 3,
        baseDelayMs: 100,
        retryableStatuses: new Set([502]),
      };

      const requestFn: RequestFn = vi.fn()
        .mockResolvedValueOnce(fakeResponse(502))
        .mockResolvedValueOnce(fakeResponse(502))
        .mockResolvedValueOnce(fakeResponse(502))
        .mockResolvedValueOnce(fakeResponse(200));

      const resultPromise = executeWithRetry(requestFn, opts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response.statusCode).toBe(200);
      expect(result.retries).toBe(3);
      // 100*2^0 + 100*2^1 + 100*2^2 = 100 + 200 + 400 = 700
      expect(result.totalDelayMs).toBe(700);
    });

    it("should support custom retry options", async () => {
      const customOpts: RetryOptions = {
        maxRetries: 1,
        baseDelayMs: 50,
        retryableStatuses: new Set([429]),
      };

      const fail = fakeResponse(429);
      const success = fakeResponse(200);
      const requestFn: RequestFn = vi.fn()
        .mockResolvedValueOnce(fail)
        .mockResolvedValueOnce(success);

      const resultPromise = executeWithRetry(requestFn, customOpts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(success);
      expect(result.retries).toBe(1);
      expect(result.totalDelayMs).toBe(50);
    });

    it("should not retry custom non-retryable status with custom options", async () => {
      const customOpts: RetryOptions = {
        maxRetries: 2,
        baseDelayMs: 100,
        retryableStatuses: new Set([429]),
      };

      // 502 is not in the custom retryable set
      const response = fakeResponse(502);
      const requestFn: RequestFn = vi.fn().mockResolvedValue(response);

      const resultPromise = executeWithRetry(requestFn, customOpts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(response);
      expect(result.retries).toBe(0);
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it("should handle maxRetries of 0 (no retries)", async () => {
      const opts: RetryOptions = {
        maxRetries: 0,
        baseDelayMs: 200,
        retryableStatuses: new Set([502]),
      };

      const response = fakeResponse(502);
      const requestFn: RequestFn = vi.fn().mockResolvedValue(response);

      const resultPromise = executeWithRetry(requestFn, opts);
      await flushSleep();
      const result = await resultPromise;

      expect(result.response).toBe(response);
      expect(result.retries).toBe(0);
      expect(result.totalDelayMs).toBe(0);
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it("should propagate request function errors without retrying", async () => {
      const requestFn: RequestFn = vi.fn().mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(executeWithRetry(requestFn, defaultOpts)).rejects.toThrow("ECONNREFUSED");
      expect(requestFn).toHaveBeenCalledTimes(1);
    });

    it("should handle mixed retryable then success correctly", async () => {
      const fail502 = fakeResponse(502);
      const fail503 = fakeResponse(503);
      const success = fakeResponse(301);
      const requestFn: RequestFn = vi.fn()
        .mockResolvedValueOnce(fail502)
        .mockResolvedValueOnce(fail503)
        .mockResolvedValueOnce(success);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      // 301 is not retryable, so it should be returned
      expect(result.response).toBe(success);
      expect(result.retries).toBe(2);
      expect(requestFn).toHaveBeenCalledTimes(3);
      expect(fail502.destroy).toHaveBeenCalled();
      expect(fail503.destroy).toHaveBeenCalled();
    });

    it("should handle response with no statusCode", async () => {
      // statusCode is undefined, which maps to 0 via ?? operator
      const response = { headers: {}, destroy: vi.fn() } as unknown as IncomingMessage;
      const requestFn: RequestFn = vi.fn().mockResolvedValue(response);

      const resultPromise = executeWithRetry(requestFn, defaultOpts);
      await flushSleep();
      const result = await resultPromise;

      // 0 is not in retryable statuses, so returns immediately
      expect(result.response).toBe(response);
      expect(result.retries).toBe(0);
    });
  });

  describe("promisifyRequest", () => {
    it("should make an HTTP request and resolve with the response", async () => {
      // Create a local test server
      const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end("OK");
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      try {
        const responsePromise = promisifyRequest({ hostname: "127.0.0.1", port, method: "GET", path: "/" });
        // Need to advance timers for the request to connect
        vi.useRealTimers();
        const response = await responsePromise;
        vi.useFakeTimers();

        expect(response.statusCode).toBe(200);
        response.destroy();
      } finally {
        server.close();
      }
    });

    it("should send body when provided as a string", async () => {
      let receivedBody = "";
      const server = http.createServer((req, res) => {
        req.on("data", (chunk: Buffer) => { receivedBody += chunk.toString(); });
        req.on("end", () => {
          res.writeHead(200);
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      try {
        vi.useRealTimers();
        const response = await promisifyRequest(
          { hostname: "127.0.0.1", port, method: "POST", path: "/" },
          "hello body",
        );
        vi.useFakeTimers();

        expect(response.statusCode).toBe(200);
        expect(receivedBody).toBe("hello body");
        response.destroy();
      } finally {
        server.close();
      }
    });

    it("should send body when provided as a Buffer", async () => {
      let receivedBody = Buffer.alloc(0);
      const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => { chunks.push(chunk); });
        req.on("end", () => {
          receivedBody = Buffer.concat(chunks);
          res.writeHead(200);
          res.end("OK");
        });
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      try {
        vi.useRealTimers();
        const response = await promisifyRequest(
          { hostname: "127.0.0.1", port, method: "POST", path: "/" },
          Buffer.from("buffer body"),
        );
        vi.useFakeTimers();

        expect(response.statusCode).toBe(200);
        expect(receivedBody.toString()).toBe("buffer body");
        response.destroy();
      } finally {
        server.close();
      }
    });

    it("should send request with null body", async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end("OK");
      });

      await new Promise<void>((resolve) => server.listen(0, resolve));
      const port = (server.address() as any).port;

      try {
        vi.useRealTimers();
        const response = await promisifyRequest(
          { hostname: "127.0.0.1", port, method: "GET", path: "/" },
          null,
        );
        vi.useFakeTimers();

        expect(response.statusCode).toBe(200);
        response.destroy();
      } finally {
        server.close();
      }
    });

    it("should reject on connection error", async () => {
      vi.useRealTimers();
      // Connect to a port that's not listening
      await expect(
        promisifyRequest({ hostname: "127.0.0.1", port: 1, method: "GET", path: "/" }),
      ).rejects.toThrow();
      vi.useFakeTimers();
    });
  });
});
