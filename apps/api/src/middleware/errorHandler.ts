import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import type { AppError } from "../lib/errors.js";

/**
 * Single exit point for failures.
 *
 * Known errors carry a status and a code. Unknown errors are logged with the
 * request id and returned as a generic 500 — a stack trace or driver message in
 * a response is an information leak.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.requestId;

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "bad_request",
        message: "Validation failed",
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        requestId,
      },
    });
    return;
  }

  const appErr = err as Partial<AppError>;
  const status = typeof appErr.status === "number" ? appErr.status : 500;
  const code = typeof appErr.code === "string" ? appErr.code : "internal_error";

  if (status >= 500) {
    req.log?.error({ err, requestId }, "Unhandled error");
  } else {
    req.log?.warn({ code, message: (err as Error)?.message, requestId }, "Request failed");
  }

  // Only a genuine 500 is masked. A 501 or 503 is a deliberate, actionable
  // refusal ("no email provider is configured") and hiding its message would
  // leave the caller with "Something went wrong" and no way to fix it.
  const message =
    status === 500 && env.NODE_ENV === "production"
      ? "Something went wrong"
      : ((err as Error)?.message ?? "Something went wrong");

  res.status(status).json({
    error: {
      code,
      message,
      ...(appErr.details ? { details: appErr.details } : {}),
      requestId,
    },
  });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: "not_found", message: `No route for ${req.method} ${req.originalUrl}`, requestId: req.requestId },
  });
}
