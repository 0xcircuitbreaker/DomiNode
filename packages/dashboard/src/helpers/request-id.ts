import type { Request, Response, NextFunction } from "express";
import { resolveRequestId, runWithRequestId } from "@dominusnode/shared";

/**
 * X-Request-Id: accept a valid incoming id (1-64 chars of [A-Za-z0-9._:-])
 * or generate one; set it on the response; add `requestId` to JSON error
 * bodies (status >= 400, plain object with `error`); bind it to log lines.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const id = resolveRequestId(req.headers["x-request-id"]);
  (req as unknown as { requestId: string }).requestId = id;
  res.setHeader("X-Request-Id", id);

  const json = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (
      res.statusCode >= 400 &&
      body !== null && typeof body === "object" && !Array.isArray(body) &&
      "error" in (body as Record<string, unknown>) &&
      !("requestId" in (body as Record<string, unknown>))
    ) {
      return json({ ...(body as Record<string, unknown>), requestId: id });
    }
    return json(body);
  }) as Response["json"];

  runWithRequestId(id, () => next());
}
