import { describe, expect, it } from "vitest";
import {
  checkAnchor,
  checkRel,
  extractLinks,
  findDestination,
  parseRel,
  sameDestination,
} from "./link-extraction.js";

/**
 * LINK EXTRACTION.
 *
 * The previous checker asked `html.includes(liveUrl)` — "does this page contain
 * its own address". That is true of the canonical tag, the og:url and the page's
 * own navigation, so a removed link still reported as present. These tests pin the
 * behaviour that replaced it.
 */

const BASE = "https://publisher.test/article";

describe("extractLinks", () => {
  it("extracts an anchor, its text and its href", () => {
    const links = extractLinks(`<p>See <a href="https://client.test/pricing">our pricing</a>.</p>`, BASE);
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toBe("https://client.test/pricing");
    expect(links[0]?.text).toBe("our pricing");
  });

  it("resolves a relative href against the page", () => {
    // A link written as /pricing is a real backlink; comparing only absolute
    // strings would miss exactly the links an agency most often buys.
    const links = extractLinks(`<a href="/pricing">pricing</a>`, BASE);
    expect(links[0]?.href).toBe("https://publisher.test/pricing");
  });

  it("strips inline markup from the anchor text", () => {
    const links = extractLinks(`<a href="/x"><strong>best</strong> <em>tools</em></a>`, BASE);
    expect(links[0]?.text).toBe("best tools");
  });

  it("does not treat the page's own canonical URL as a backlink", () => {
    // This is the regression the old implementation got wrong.
    const html = `
      <link rel="canonical" href="https://publisher.test/article">
      <meta property="og:url" content="https://publisher.test/article">
      <a href="/about">about</a>
    `;
    const links = extractLinks(html, BASE);
    const toSelf = links.filter((l) => sameDestination(l.href, BASE));
    expect(toSelf).toHaveLength(0);
  });

  it("finds a link that points at the canonical URL when it really exists", () => {
    const html = `<a href="https://publisher.test/article">read this article</a>`;
    const links = extractLinks(html, BASE);
    expect(links.some((l) => sameDestination(l.href, BASE))).toBe(true);
  });

  it("decodes HTML entities in anchor text", () => {
    const links = extractLinks(`<a href="/x">Q&amp;A with Acme &mdash; 2026</a>`, BASE);
    expect(links[0]?.text).toBe("Q&A with Acme \u2014 2026");
  });

  it("parses rel into tokens", () => {
    const links = extractLinks(`<a href="/x" rel="nofollow sponsored">x</a>`, BASE);
    expect(links[0]?.rel).toEqual(["nofollow", "sponsored"]);
  });

  it("handles single-quoted and unquoted attributes", () => {
    const a = extractLinks(`<a href='/one'>1</a>`, BASE);
    const b = extractLinks(`<a href=/two>2</a>`, BASE);
    expect(a[0]?.href).toBe("https://publisher.test/one");
    expect(b[0]?.href).toBe("https://publisher.test/two");
  });

  it("marks an anchor with no href as dynamic, not as a link", () => {
    const links = extractLinks(`<a name="section">anchor target</a>`, BASE);
    expect(links[0]?.dynamic).toBe(true);
    expect(links[0]?.href).toBe("");
  });

  it("finds every anchor in a document with several", () => {
    const html = `
      <a href="https://a.test/1">one</a>
      <a href="https://b.test/2">two</a>
      <a href="https://c.test/3">three</a>
    `;
    expect(extractLinks(html, BASE)).toHaveLength(3);
  });

  it("is not confused by a > inside an attribute value", () => {
    const html = `<a href="/x" title="a > b">text</a>`;
    const links = extractLinks(html, BASE);
    expect(links[0]?.text).toBe("text");
    expect(links[0]?.href).toBe("https://publisher.test/x");
  });
});

describe("sameDestination", () => {
  it("ignores www, trailing slashes, query strings and fragments", () => {
    expect(sameDestination("https://www.client.test/pricing/", "https://client.test/pricing")).toBe(true);
    expect(sameDestination("https://client.test/p?utm_source=x", "https://client.test/p")).toBe(true);
    expect(sameDestination("https://client.test/p#section", "https://client.test/p")).toBe(true);
  });

  it("treats different paths as different destinations", () => {
    expect(sameDestination("https://client.test/pricing", "https://client.test/features")).toBe(false);
  });

  it("treats different hosts as different destinations", () => {
    expect(sameDestination("https://client.test/p", "https://other.test/p")).toBe(false);
  });
});

describe("findDestination", () => {
  const links = [
    { href: "https://publisher.test/nav", rawHref: "/nav", text: "home", rel: [], dynamic: false },
    {
      href: "https://client.test/pricing",
      rawHref: "https://client.test/pricing",
      text: "our pricing",
      rel: ["nofollow"],
      dynamic: false,
    },
  ];

  it("finds the anchor pointing at the expected URL", () => {
    const result = findDestination(links, "https://client.test/pricing", "our pricing");
    expect(result.found).toBe(true);
    expect(result.link?.text).toBe("our pricing");
  });

  it("prefers the anchor whose text matches when several point at the same URL", () => {
    // A nav link and an in-article link to the same page: picking the nav link
    // would report the wrong rel attribute.
    const withNav = [
      { href: "https://client.test/", rawHref: "/", text: "Client", rel: [], dynamic: false },
      { href: "https://client.test/", rawHref: "/", text: "acme analytics", rel: ["nofollow"], dynamic: false },
    ];
    const result = findDestination(withNav, "https://client.test/", "acme analytics");
    expect(result.link?.rel).toEqual(["nofollow"]);
  });

  it("reports when the anchor text exists but points elsewhere", () => {
    // This is a URL mismatch, not a missing link — a different conversation with
    // the publisher, and the reason the verdict distinguishes them.
    const result = findDestination(links, "https://client.test/features", "our pricing");
    expect(result.found).toBe(false);
    expect(result.sameTextDifferentUrl).toContain("https://client.test/pricing");
  });

  it("ignores dynamic anchors with no href", () => {
    const withDynamic = [
      ...links,
      { href: "", rawHref: "", text: "our pricing", rel: [], dynamic: true },
    ];
    const result = findDestination(withDynamic, "https://client.test/pricing", "our pricing");
    expect(result.link?.dynamic).toBe(false);
  });
});

describe("checkAnchor", () => {
  it("matches exactly", () => {
    expect(checkAnchor("best tools", "best tools")).toMatchObject({ matches: true, mode: "exact" });
  });

  it("matches after normalising case and whitespace", () => {
    expect(checkAnchor("  Best   Tools ", "best tools")).toMatchObject({ matches: true, mode: "normalised" });
  });

  it("matches after normalising smart quotes", () => {
    expect(checkAnchor("Acme\u2019s guide", "Acme's guide")).toMatchObject({ matches: true, mode: "normalised" });
  });

  it("reports a longer anchor as a containment, not a match", () => {
    const result = checkAnchor("the best tools for seo", "best tools");
    expect(result.matches).toBe(false);
    expect(result.mode).toBe("contains");
  });

  it("reports an unrelated anchor as no match", () => {
    expect(checkAnchor("click here", "best tools")).toMatchObject({ matches: false, mode: "none" });
  });

  it("treats a missing expected anchor as satisfied", () => {
    // No agreed anchor means there is nothing to check; reporting a failure would
    // flag every placement without one.
    expect(checkAnchor("anything", "")).toMatchObject({ matches: true, mode: "none" });
  });
});

describe("checkRel", () => {
  it("matches when both are empty (a followed link)", () => {
    expect(checkRel([], [])).toMatchObject({ matches: true, missing: [], unexpected: [] });
  });

  it("matches nofollow", () => {
    expect(checkRel(["nofollow"], ["nofollow"])).toMatchObject({ matches: true });
  });

  it("reports a missing nofollow — the commercial failure case", () => {
    const result = checkRel([], ["nofollow"]);
    expect(result.matches).toBe(false);
    expect(result.missing).toEqual(["nofollow"]);
  });

  it("reports an unexpected nofollow", () => {
    const result = checkRel(["nofollow"], []);
    expect(result.matches).toBe(false);
    expect(result.unexpected).toEqual(["nofollow"]);
  });

  it("ignores noopener and noreferrer, which CMSs inject", () => {
    // Reporting these as mismatches would bury the signal in noise.
    expect(checkRel(["nofollow", "noopener", "noreferrer"], ["nofollow"])).toMatchObject({ matches: true });
  });

  it("compares ugc and sponsored", () => {
    expect(checkRel(["ugc"], ["ugc"])).toMatchObject({ matches: true });
    expect(checkRel(["sponsored"], ["ugc"])).toMatchObject({ matches: false });
  });
});

describe("parseRel", () => {
  it("splits on whitespace and commas, case-insensitively", () => {
    expect(parseRel("NOFOLLOW, Sponsored")).toEqual(["nofollow", "sponsored"]);
    expect(parseRel(null)).toEqual([]);
    expect(parseRel("")).toEqual([]);
  });
});
