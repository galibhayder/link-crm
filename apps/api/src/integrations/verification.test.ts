import { describe, expect, it } from "vitest";
import { analysePage, expectedRelFromPlacement } from "./verification.js";

/**
 * THE FIVE QUESTIONS.
 *
 * `analysePage` takes already-fetched HTML, so the judgement about a page is
 * tested without touching the network. One test per question the brief asks:
 *
 *   1. does the page respond           — covered by the integration test
 *   2. does the backlink exist         — here
 *   3. is the destination correct      — here
 *   4. does the anchor match           — here
 *   5. do the attributes match         — here
 */

const PAGE = "https://publisher.test/article";
const TARGET = "https://client.test/pricing";

const analyse = (html: string, overrides: Partial<Omit<Parameters<typeof analysePage>[2], never>> = {}) =>
  analysePage(html, PAGE, { expectedUrl: TARGET, expectedAnchor: "our pricing", expectedRel: [], ...overrides });

describe("Q2 — does the backlink exist", () => {
  it("reports link_missing when there is no anchor to the target", () => {
    const result = analyse(`<p>A page with no relevant links.</p>`);
    expect(result.verdict).toBe("link_missing");
    expect(result.found).toBe(false);
    expect(result.failureReason).toMatch(/No link to/);
  });

  it("does not count the page's own canonical URL as the backlink", () => {
    // The old checker used html.includes(liveUrl) and passed this. It should not.
    const result = analyse(`
      <link rel="canonical" href="${PAGE}">
      <meta property="og:url" content="${PAGE}">
    `);
    expect(result.verdict).toBe("link_missing");
  });

  it("reports found when the anchor points at the target", () => {
    const result = analyse(`<a href="${TARGET}">our pricing</a>`);
    expect(result.found).toBe(true);
    expect(result.verdict).toBe("ok");
    expect(result.foundUrl).toBe(TARGET);
  });

  it("finds a relative link to the target", () => {
    // A link written as a path is still a link.
    const result = analyse(`<a href="/pricing">our pricing</a>`, { expectedUrl: "https://publisher.test/pricing" });
    expect(result.found).toBe(true);
    expect(result.urlMatches).toBe(true);
  });
});

describe("Q3 — is the destination correct", () => {
  it("reports url_mismatch when the anchor text exists but points elsewhere", () => {
    const result = analyse(`<a href="https://client.test/features">our pricing</a>`);
    expect(result.verdict).toBe("url_mismatch");
    expect(result.found).toBe(false);
    expect(result.failureReason).toMatch(/points at/);
  });

  it("treats www, trailing slash and query params as the same destination", () => {
    for (const href of [
      "https://www.client.test/pricing/",
      "https://client.test/pricing?utm_source=x",
      "https://client.test/pricing#section",
    ]) {
      const result = analyse(`<a href="${href}">our pricing</a>`);
      expect(result.urlMatches, href).toBe(true);
      expect(result.verdict, href).toBe("ok");
    }
  });

  it("treats a different path as a mismatch", () => {
    const result = analyse(`<a href="https://client.test/other-page">our pricing</a>`);
    expect(result.found).toBe(false);
  });
});

describe("Q4 — does the anchor text match", () => {
  it("passes an exact anchor", () => {
    const result = analyse(`<a href="${TARGET}">our pricing</a>`);
    expect(result.anchor.matches).toBe(true);
    expect(result.verdict).toBe("ok");
  });

  it("passes an anchor that differs only in case and spacing", () => {
    const result = analyse(`<a href="${TARGET}">  Our   Pricing </a>`);
    expect(result.anchor.matches).toBe(true);
  });

  it("flags a different anchor", () => {
    const result = analyse(`<a href="${TARGET}">click here</a>`);
    expect(result.verdict).toBe("anchor_mismatch");
    expect(result.anchorFoundText).toBe("click here");
    expect(result.failureReason).toMatch(/Anchor text differs/);
  });

  it("flags a longer anchor as a containment, and says so", () => {
    const result = analyse(`<a href="${TARGET}">our pricing plans for teams</a>`);
    expect(result.verdict).toBe("anchor_mismatch");
    expect(result.failureReason).toMatch(/longer/);
  });

  it("accepts any anchor when none was agreed", () => {
    const result = analyse(`<a href="${TARGET}">whatever text</a>`, { expectedAnchor: null });
    expect(result.anchor.matches).toBe(true);
    expect(result.verdict).toBe("ok");
  });

  it("prefers the in-article link over a nav link to the same URL", () => {
    // Two anchors to the same page with different text: the agreed one is the link
    // we were asked to verify, so its rel is the one that counts.
    const html = `
      <nav><a href="${TARGET}">Pricing</a></nav>
      <article><a href="${TARGET}" rel="nofollow">our pricing</a></article>
    `;
    const result = analyse(html, { expectedRel: ["nofollow"] });
    expect(result.rel.matches).toBe(true);
  });
});

describe("Q5 — do the attributes match", () => {
  it("flags a missing nofollow — the commercial failure case", () => {
    const result = analyse(`<a href="${TARGET}">our pricing</a>`, { expectedRel: ["nofollow"] });
    expect(result.verdict).toBe("attr_mismatch");
    expect(result.rel.missing).toEqual(["nofollow"]);
    expect(result.failureReason).toMatch(/Missing rel/);
  });

  it("flags an unexpected nofollow on a link that should be followed", () => {
    const result = analyse(`<a href="${TARGET}" rel="nofollow">our pricing</a>`, { expectedRel: [] });
    expect(result.verdict).toBe("attr_mismatch");
    expect(result.rel.unexpected).toEqual(["nofollow"]);
  });

  it("passes a matching nofollow", () => {
    const result = analyse(`<a href="${TARGET}" rel="nofollow">our pricing</a>`, { expectedRel: ["nofollow"] });
    expect(result.verdict).toBe("ok");
  });

  it("ignores noopener and noreferrer, which CMSs inject", () => {
    const result = analyse(`<a href="${TARGET}" rel="nofollow noopener noreferrer">our pricing</a>`, {
      expectedRel: ["nofollow"],
    });
    expect(result.verdict).toBe("ok");
  });

  it("reports anchor problems before attribute problems", () => {
    // Both are wrong; the anchor is the more serious one, so it is reported first.
    const result = analyse(`<a href="${TARGET}" rel="nofollow">click here</a>`, { expectedRel: [] });
    expect(result.verdict).toBe("anchor_mismatch");
  });
});

describe("expectedRelFromPlacement", () => {
  it("derives rel from link_type when no explicit rel is stored", () => {
    expect(expectedRelFromPlacement("dofollow", null)).toEqual([]);
    expect(expectedRelFromPlacement("nofollow", null)).toEqual(["nofollow"]);
    expect(expectedRelFromPlacement("ugc", null)).toEqual(["ugc"]);
    expect(expectedRelFromPlacement("sponsored", null)).toEqual(["sponsored"]);
  });

  it("prefers an explicit rel attribute when present", () => {
    expect(expectedRelFromPlacement("dofollow", "nofollow sponsored")).toEqual(["nofollow", "sponsored"]);
  });

  it("treats an unset link type as followed", () => {
    expect(expectedRelFromPlacement(null, null)).toEqual([]);
  });
});
