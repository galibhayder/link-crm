import { z } from "zod";

/**
 * A query-string boolean.
 *
 * `z.coerce.boolean()` is WRONG for query strings and the bug is silent:
 * `Boolean("false")` is `true`, because any non-empty string is truthy. So a
 * caller sending `?mine=false` got the opposite of what they asked for — which is
 * how the content page rendered "Nothing assigned" while the summary beside it
 * showed work in progress.
 *
 * This accepts the forms a query string actually carries and rejects the rest, so
 * a typo surfaces instead of quietly meaning `true`.
 */
export const booleanQuery = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0", "yes", "no"])])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    return v === "true" || v === "1" || v === "yes";
  });

/** Optional variant, for a filter that is absent by default. */
export const optionalBooleanQuery = booleanQuery.optional();
