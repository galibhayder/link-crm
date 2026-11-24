import { API_BASE } from "./env.js";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(status: number, code: string, message: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  get isAuthError() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }

  /** Field-level messages from a Zod validation failure, for inline form errors. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const item of this.details) {
      if (item && typeof item === "object" && "path" in item && "message" in item) {
        const path = String((item as { path: unknown }).path);
        if (!out[path]) out[path] = String((item as { message: unknown }).message);
      }
    }
    return out;
  }
}

interface ApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown; requestId?: string };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  token?: string | null;
  signal?: AbortSignal;
  /** Extra headers, e.g. for the HMAC job endpoints. */
  headers?: Record<string, string>;
}

/**
 * The single API entry point.
 *
 * Parses the { data } / { error } envelope, turns a failure into a typed
 * ApiError carrying the server's code and request id, and never swallows a
 * non-2xx into a silent `undefined`.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<ApiEnvelope<T>> {
  const { method = "GET", body, token, signal, headers = {} } = options;

  const requestHeaders: Record<string, string> = {
    accept: "application/json",
    ...headers,
  };

  if (body !== undefined) requestHeaders["content-type"] = "application/json";
  if (token) requestHeaders.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error)?.name === "AbortError") throw err;
    // Network-level failure: the server is down or unreachable.
    throw new ApiError(0, "network_error", "Cannot reach the server. Check your connection.", undefined);
  }

  if (response.status === 204) {
    return { data: undefined as T };
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const errorBody = (payload ?? {}) as ErrorEnvelope;
    const error = new ApiError(
      response.status,
      errorBody.error?.code ?? "unknown_error",
      errorBody.error?.message ?? `Request failed with status ${response.status}`,
      errorBody.error?.details,
      errorBody.error?.requestId ?? response.headers.get("x-request-id") ?? undefined,
    );

    // A 401 means the session is gone or was revoked. Tell the auth provider so
    // the user is redirected to sign in rather than left on a failing page.
    //
    // EXCEPT when the request carried no token at all: that is a hook firing
    // before the session has hydrated, not a lost session. Treating it as one
    // signed the user out on every hard refresh of a deep link — the page mounted,
    // a data hook fired without a token, got 401, and bounced to /login while a
    // perfectly valid session sat in storage.
    //
    // 403 is deliberately not included either: that is a permission problem, and
    // signing the user out would be the wrong response to it.
    if (response.status === 401 && token) notifyUnauthorized();

    throw error;
  }

  return (payload ?? { data: null }) as ApiEnvelope<T>;
}

/** Convenience wrapper returning just the data. */
export async function apiGet<T>(path: string, token?: string | null, signal?: AbortSignal) {
  const res = await apiRequest<T>(path, { token, signal });
  return res.data;
}

/**
 * Called when the API rejects a request with 401.
 *
 * A token can expire, or become stale after a server-side role change. Without
 * this the user sits on a page that silently fails to load, with no indication
 * that they need to sign in again. Set by the auth provider on mount.
 */
let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

export function notifyUnauthorized() {
  unauthorizedHandler?.();
}

/**
 * Base for unauthenticated endpoints (/health/*).
 *
 * Exported so callers never hardcode a same-origin path: in a split deployment
 * the API lives on another host, and a literal "/health/ready" would poll the
 * static site instead.
 */
export { API_BASE };

export function buildQuery(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
