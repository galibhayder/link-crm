import { describe, expect, it } from "vitest";
import { classifyAnchor, displayGroupOf, isOverOptimised } from "./anchor-classifier.js";

/**
 * ANCHOR CLASSIFICATION.
 *
 * The report is only as good as this function, and a wrong label is worse than
 * none — it tells a client their link profile is safe when it is not. These tests
 * pin the four categories the brief names, plus the cases that are easy to get
 * backwards.
 */

const BRAND = { brandName: "Acme", brandDomain: "acme.test" };

describe("classifyAnchor — the four named categories", () => {
  it("classifies the brand name as branded", () => {
    expect(classifyAnchor("Acme", "https://acme.test/pricing", BRAND)).toBe("branded");
    expect(classifyAnchor("Acme analytics", "https://acme.test/x", BRAND)).toBe("branded");
  });

  it("classifies a bare URL as naked_url", () => {
    expect(classifyAnchor("https://acme.test/pricing", "https://acme.test/pricing", BRAND)).toBe("naked_url");
    expect(classifyAnchor("acme.test", "https://acme.test/x", BRAND)).toBe("naked_url");
    expect(classifyAnchor("www.acme.test/pricing", "https://acme.test/x", BRAND)).toBe("naked_url");
  });

  it("classifies filler phrases as generic", () => {
    for (const phrase of ["click here", "read more", "learn more", "this article", "website", "source"]) {
      expect(classifyAnchor(phrase, "https://acme.test/x", BRAND), phrase).toBe("generic");
    }
  });

  it("classifies a term matching the target slug as exact match", () => {
    // The slug of /features/analytics is "analytics".
    expect(classifyAnchor("analytics", "https://acme.test/features/analytics", BRAND)).toBe("exact_match");
    expect(classifyAnchor("best analytics tools", "https://other.test/best-analytics-tools", BRAND)).toBe("exact_match");
  });

  it("classifies a phrase containing the slug as partial match", () => {
    expect(classifyAnchor("analytics platform", "https://acme.test/features/analytics", BRAND)).toBe("partial_match");
    expect(classifyAnchor("our favourite analytics tool", "https://acme.test/analytics", BRAND)).toBe("partial_match");
  });
});

describe("classifyAnchor — precedence and edge cases", () => {
  it("classifies a bare domain as a naked URL, even the client's own", () => {
    // The standard definition: if the anchor text IS the address, it is naked.
    // Calling the client's own domain "branded" would inflate the brand share and
    // hide a naked-link problem behind a number that looks healthy.
    expect(classifyAnchor("acme.test", "https://acme.test/x", BRAND)).toBe("naked_url");
    expect(classifyAnchor("https://acme.test/pricing", "https://acme.test/x", BRAND)).toBe("naked_url");
    expect(classifyAnchor("https://acme.test/pricing", "https://acme.test/pricing", BRAND)).toBe("naked_url");
  });

  it("does not mistake a domain for the brand word", () => {
    // "acme.test" contains "acme" as a substring but the brand is not used as a
    // word, so it must not be branded. Word-boundary matching is the fix.
    expect(classifyAnchor("acmecorp competitor", "https://acme.test/x", BRAND)).not.toBe("branded");
  });

  it("returns null for an empty anchor rather than guessing", () => {
    // An image link has no text. Counting it as "generic" would distort the shares.
    expect(classifyAnchor("", "https://acme.test/x", BRAND)).toBeNull();
    expect(classifyAnchor(null, "https://acme.test/x", BRAND)).toBeNull();
    expect(classifyAnchor("   ", "https://acme.test/x", BRAND)).toBeNull();
  });

  it("classifies image anchors when explicitly marked", () => {
    expect(classifyAnchor("[image: hero]", "https://acme.test/x", BRAND)).toBe("image_alt");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(classifyAnchor("  ACME  ", "https://acme.test/x", BRAND)).toBe("branded");
    expect(classifyAnchor("Click   Here", "https://acme.test/x", BRAND)).toBe("generic");
  });

  it("does not treat a different domain as naked", () => {
    // A different site's domain in the anchor is an editorial citation, not a
    // naked link to the client.
    expect(classifyAnchor("example.org/article", "https://acme.test/x", BRAND)).not.toBe("naked_url");
  });

  it("works without brand context", () => {
    expect(classifyAnchor("click here", "https://acme.test/x")).toBe("generic");
    expect(classifyAnchor("acme.test", "https://acme.test/x")).toBe("naked_url");
  });

  it("treats a descriptive phrase with no usable target as partial match", () => {
    expect(classifyAnchor("a useful industry report", "https://acme.test/blog", BRAND)).toBe("partial_match");
  });

  it("handles a target URL with no path", () => {
    // https://acme.test/ has no slug, so there is nothing to match exactly.
    expect(classifyAnchor("some descriptive phrase", "https://acme.test/", BRAND)).toBe("partial_match");
  });

  it("does not match a slug as a substring of a different word", () => {
    // slug "analytics" must not match "analyticsy" or be confused by "analytic".
    const result = classifyAnchor("analytic", "https://acme.test/analytics", BRAND);
    expect(result).not.toBe("exact_match");
  });
});

describe("displayGroupOf", () => {
  it("groups naked_url under generic_or_naked, as the brief does", () => {
    expect(displayGroupOf("generic")).toBe("generic_or_naked");
    expect(displayGroupOf("naked_url")).toBe("generic_or_naked");
  });

  it("keeps the named categories distinct", () => {
    expect(displayGroupOf("branded")).toBe("branded");
    expect(displayGroupOf("exact_match")).toBe("exact_match");
    expect(displayGroupOf("partial_match")).toBe("partial_match");
  });

  it("reports null and unknown categories as unclassified", () => {
    expect(displayGroupOf(null)).toBe("unclassified");
    expect(displayGroupOf("something_else")).toBe("unclassified");
  });
});

describe("isOverOptimised", () => {
  it("flags a share above the ceiling", () => {
    expect(isOverOptimised("exact_match", 0.3, 0.15)).toBe(true);
  });

  it("does not flag a share at or below the ceiling", () => {
    expect(isOverOptimised("exact_match", 0.15, 0.15)).toBe(false);
    expect(isOverOptimised("exact_match", 0.05, 0.15)).toBe(false);
  });

  it("never flags unclassified or image_alt, which have no healthy range", () => {
    expect(isOverOptimised("unclassified", 0.9, 0.1)).toBe(false);
    expect(isOverOptimised("image_alt", 0.9, 0.1)).toBe(false);
  });
});
