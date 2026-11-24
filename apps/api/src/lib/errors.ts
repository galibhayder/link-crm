export interface AppError extends Error {
  code: string;
  status: number;
  details?: unknown;
}

export function httpError(status: number, code: string, message: string, details?: unknown): AppError {
  const err = new Error(message) as AppError;
  err.status = status;
  err.code = code;
  err.details = details;
  return err;
}

export const Errors = {
  /** Escape hatch for a status that does not have a named helper below. */
  httpError,
  unauthorized: (message = "Authentication required") => httpError(401, "unauthorized", message),
  forbidden: (message = "You do not have permission to do that") => httpError(403, "forbidden", message),
  /** 404 rather than 403 where revealing existence would itself be a leak. */
  notFound: (entity = "Record") => httpError(404, "not_found", `${entity} not found`),
  badRequest: (message: string, details?: unknown) => httpError(400, "bad_request", message, details),
  conflict: (message: string) => httpError(409, "conflict", message),
  unprocessable: (message: string, details?: unknown) => httpError(422, "unprocessable", message, details),
  tooLarge: (message: string) => httpError(413, "payload_too_large", message),
  rateLimited: (message = "Too many requests") => httpError(429, "rate_limited", message),
  /** 501 for a capability that exists in the interface but not the build. */
  notImplemented: (message: string, details?: unknown) => httpError(501, "not_implemented", message, details),
  /** 503 for a dependency that is not configured. */
  unavailable: (code: string, message: string, details?: unknown) => httpError(503, code, message, details),
  internal: (message = "Something went wrong") => httpError(500, "internal_error", message),
} as const;
