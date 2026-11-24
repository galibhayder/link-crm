import { describe, expect, it } from "vitest";
import { analysePage } from "./verification.js";

/**
 * ANCHOR CATEGORY CROSS-CHECK.
 *
 * `expectedAnchorType` was declared on the verification input and passed by both
 * callers, but read by neither — the placement's recorded category was never
 * compared against what was actually on the page. A placement filed as
 * `exact_match` whose live anchor reads "click here" is mislabelled, and every
 * anchor report built on that label is wrong.
 *
 * The check is reported as `anchorCategoryMatches` rather than changing `verdict`,
 * because a mislabelled category is a recordkeeping problem, not a broken link, and
 * it must not mask a genuine anchor or attribute failure.
 */

const PAGE = "https://publisher.test/article";
const TARGET = "https://client.test/analytics";

const judge = (html: string, expectedAnchorType: string | null) =>
  analysePage(html, PAGE, {
    expectedUrl: TARGET,
    expectedAnchor: null,
    expectedRel: [],
    expectedAnchorType,
  });

describe("anchor category cross-check", () => {
  it("reports a match when the live anchor agrees with the recorded category", () => {
    // The slug is "analytics", so this anchor is exact_match.
    const result = judge(`<a href="${TARGET}">analytics</a>`, "exact_match");
    expect(result.detail.classifiedAnchorType).toBe("exact_match");
    expect(result.detail.anchorCategoryMatches).toBe(true);
  });

  it("reports a mismatch when the anchor was filed under the wrong category", () => {
    // Filed as exact match, actually a generic phrase.
    const result = judge(`<a href="${TARGET}">click here</a>`, "exact_match");
    expect(result.detail.classifiedAnchorType).toBe("generic");
    expect(result.detail.anchorCategoryMatches).toBe(false);
  });

  it("treats generic and naked_url as the same display group", () => {
    // Both roll up into "Generic / Naked URL", so filing a bare URL as generic is
    // not a category error at the level the report cares about.
    const result = judge(`<a href="${TARGET}">https://client.test/analytics</a>`, "generic");
    expect(result.detail.classifiedAnchorType).toBe("naked_url");
    expect(result.detail.anchorCategoryMatches).toBe(true);
  });

  it("returns null when the placement has no recorded category", () => {
    const result = judge(`<a href="${TARGET}">analytics</a>`, null);
    expect(result.detail.anchorCategoryMatches).toBeNull();
  });

  it("does not override a real anchor mismatch with a category match", () => {
    // The anchor is wrong AND the category agrees; the verdict must still be the
    // anchor problem, because that is what the publisher has to fix.
    const result = analysePage(`<a href="${TARGET}">something else</a>`, PAGE, {
      expectedUrl: TARGET,
      expectedAnchor: "analytics",
      expectedRel: [],
      expectedAnchorType: "partial_match",
    });
    expect(result.verdict).toBe("anchor_mismatch");
  });

  it("still classifies when the anchor was found via a different link", () => {
    const html = `
      <nav><a href="${TARGET}">Pricing</a></nav>
      <article><a href="${TARGET}">best analytics tools</a></article>
    `;
    const result = analysePage(html, PAGE, { expectedUrl: TARGET, expectedRel: [], expectedAnchorType: "exact_match" });
    // "best analytics tools" is not the slug itself, so it is a partial match.
    expect(result.detail.classifiedAnchorType).toBe("partial_match");
    expect(result.detail.anchorCategoryMatches).toBe(false);
  });
});
