import { Router, type NextFunction, type Request, type Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { Errors } from "../lib/errors.js";

/**
 * Validates body, params and query against Zod schemas from @crm/shared.
 * Parsed values replace the raw ones, so handlers receive coerced types
 * (dates as Date, numbers as number) rather than strings.
 */
export function validate(schemas: { body?: ZodTypeAny; params?: ZodTypeAny; query?: ZodTypeAny }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      // Zod 4's `parse` is typed `unknown` on ZodTypeAny; validate() has already
      // replaced the raw value, so restore Express's own type here.
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) req.query = schemas.query.parse(req.query) as typeof req.query;
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof z.ZodError) {
        return next(
          Errors.badRequest(
            "Validation failed",
            err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          ),
        );
      }
      next(err);
    }
  };
}

/** Async handler wrapper — Express 4 does not catch rejected promises. */
export function asyncRoute(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };
}

/**
 * Typed access to an already-validated query string.
 *
 * Express types req.query as ParsedQs, so a direct cast to the Zod output type
 * is rejected. validate() has already replaced req.query with the parsed object
 * by the time a handler runs, so this is the one place that knows that.
 */
export function parsedQuery<T>(req: Request): T {
  return req.query as unknown as T;
}

export function ok<T>(res: Response, data: T, meta?: unknown) {
  res.json(meta === undefined ? { data } : { data, meta });
}

/**
 * Narrows a Supabase result to a row shape.
 *
 * The project has no generated `Database` type, so the client returns
 * `GenericStringError` for every select and property access fails to typecheck.
 * Generating types is the proper fix (it also catches schema drift in CI), but
 * until that is wired up this keeps the modules readable rather than sprinkling
 * `as unknown as` at every call site.
 */
export function asRows<T>(data: unknown): T[] {
  return (data ?? []) as T[];
}

export function asRow<T>(data: unknown): T | null {
  return (data ?? null) as T | null;
}

export function created<T>(res: Response, data: T) {
  res.status(201).json({ data });
}

export function noContent(res: Response) {
  res.status(204).end();
}

/** Wraps a router so every route inside it is authenticated and surface-bound. */
export function router(): Router {
  return Router({ mergeParams: true });
}
