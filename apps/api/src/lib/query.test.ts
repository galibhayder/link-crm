import { describe, expect, it } from "vitest";
import { booleanQuery, optionalBooleanQuery } from "./query.js";

/**
 * QUERY-STRING BOOLEANS.
 *
 * `z.coerce.boolean()` is the obvious way to parse one and it is silently wrong:
 * `Boolean("false")` is `true`, because any non-empty string is truthy.
 *
 * The real consequence was a content page that rendered "Nothing assigned" while
 * the summary beside it reported work in progress: the UI sent `?mine=false` for a
 * reviewer, the server read it as `true`, and filtered to that user's own
 * (empty) assignment list.
 */

describe("booleanQuery", () => {
  it("parses the string 'false' as false", () => {
    // The bug: z.coerce.boolean() returns true here.
    expect(booleanQuery.parse("false")).toBe(false);
  });

  it("parses the string 'true' as true", () => {
    expect(booleanQuery.parse("true")).toBe(true);
  });

  it("accepts 1/0 and yes/no", () => {
    expect(booleanQuery.parse("1")).toBe(true);
    expect(booleanQuery.parse("0")).toBe(false);
    expect(booleanQuery.parse("yes")).toBe(true);
    expect(booleanQuery.parse("no")).toBe(false);
  });

  it("passes a real boolean through unchanged", () => {
    expect(booleanQuery.parse(true)).toBe(true);
    expect(booleanQuery.parse(false)).toBe(false);
  });

  it("rejects something that is neither, rather than guessing", () => {
    // A typo must surface. Treating "flase" as true is how a filter silently
    // inverts and nobody notices.
    expect(() => booleanQuery.parse("flase")).toThrow();
    expect(() => booleanQuery.parse("2")).toThrow();
    expect(() => booleanQuery.parse("")).toThrow();
  });

  it("is not fooled by an empty string being truthy in JS", () => {
    expect(booleanQuery.safeParse("").success).toBe(false);
  });
});

describe("optionalBooleanQuery", () => {
  it("is undefined when absent, so the filter simply does not apply", () => {
    expect(optionalBooleanQuery.parse(undefined)).toBeUndefined();
  });

  it("still parses false correctly when present", () => {
    expect(optionalBooleanQuery.parse("false")).toBe(false);
  });
});
