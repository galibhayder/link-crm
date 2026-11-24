/**
 * BACKLINK EXTRACTION.
 *
 * The previous checker did this:
 *
 *     const absoluteFound = html.includes(liveUrl);
 *
 * which asks "does the page contain its own address". That is true of the
 * canonical tag, the og:url, the share buttons and the page's own navigation — so
 * it reported `found: true` for a page whose link had been removed, as long as the
 * page still linked to itself. It also never compared the destination, the anchor
 * text or the rel attribute, so three of the five questions the brief asks were
 * unanswerable.
 *
 * This module parses the anchors out of the HTML properly and answers the actual
 * question: is there an `<a>` whose href lands on the client's target URL, and
 * does its text and rel match what we agreed?
 *
 * No HTML parser dependency: the input is untrusted, and a full parser would be a
 * larger attack surface for no benefit here. Instead this scans `<a ...>` start
 * tags and their text content, which is enough for the question and cannot
 * execute anything.
 */

export interface ExtractedLink {
  /** Resolved absolute href. */
  href: string;
  /** Raw href as authored, for reporting what was actually in the markup. */
  rawHref: string;
  /** Visible text, entities decoded and whitespace collapsed. */
  text: string;
  /** rel attribute, lowercased and split into tokens. */
  rel: string[];
  /** True when the anchor's href was never in the markup (JS-set). */
  dynamic: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
};

/** Decode the handful of entities that change anchor text, then collapse space. */
function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function stripTags(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Read one attribute value from a start tag. Handles single, double and bare. */
function attr(tag: string, name: string): string | null {
  // Quoted form first.
  const quoted = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  if (quoted) return decodeEntities(quoted[2] ?? quoted[3] ?? "");

  // Unquoted form: href=https://x.test/a
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s"'>]+)`, "i").exec(tag);
  if (bare) return decodeEntities(bare[1] ?? "");

  // Boolean attribute, e.g. `rel` with no value is meaningless but `download` is not.
  return null;
}

/**
 * A start tag, ending at a `>` that is not inside a quoted attribute value.
 *
 * The naive `[^>]*` stops at the `>` in `title="a > b"`, which truncates the tag
 * and leaves the rest of the attribute string in the anchor's text. Matching
 * quoted runs explicitly is what makes that not happen.
 */
const TAG_ATTRS = `((?:[^>"']|"[^"]*"|'[^']*')*)`;

/**
 * Extract every anchor in the document.
 *
 * `baseUrl` is used to resolve relative hrefs, because a link written as
 * `/blog/post` is a real backlink and comparing only absolute strings would miss
 * it — which is exactly the kind of link an agency most often buys.
 */
export function extractLinks(html: string, baseUrl: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];

  // Anchors with inline content.
  const anchorRe = new RegExp(`<a\\b${TAG_ATTRS}>([\\s\\S]*?)<\\/a\\s*>`, "gi");
  let match: RegExpExecArray | null;

  while ((match = anchorRe.exec(html)) !== null) {
    const attrs = match[1] ?? "";
    const inner = match[2] ?? "";
    const tag = `<a${attrs}>`;

    const rawHref = attr(tag, "href");
    const relRaw = attr(tag, "rel");

    // An `<a>` with no href is an anchor target, not a link.
    if (rawHref === null || rawHref.trim() === "") {
      links.push({
        href: "",
        rawHref: "",
        text: stripTags(inner),
        rel: relRaw ? relRaw.toLowerCase().split(/\s+/).filter(Boolean) : [],
        dynamic: true,
      });
      continue;
    }

    let href = rawHref.trim();
    try {
      href = new URL(href, baseUrl).toString();
    } catch {
      // Leave it as authored; the comparison will simply not match.
    }

    links.push({
      href,
      rawHref: rawHref.trim(),
      text: stripTags(inner),
      rel: relRaw ? relRaw.toLowerCase().split(/\s+/).filter(Boolean) : [],
      dynamic: false,
    });
  }

  return links;
}

/** Compare two URLs for "same destination", ignoring trivia. */
export function sameDestination(a: string, b: string): boolean {
  const norm = (value: string): string | null => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      // Trailing slash on a path is not a different page.
      const path = url.pathname.replace(/\/+$/, "") || "/";
      // Query strings and fragments are dropped: tracking parameters and
      // `#section` do not change which page is being linked to.
      return `${host}${path}`;
    } catch {
      return null;
    }
  };

  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return a.trim() === b.trim();
  return left === right;
}

function normaliseAnchorForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export interface DestinationCheck {
  /** Did any anchor point at the expected URL? */
  found: boolean;
  /** The matching anchor, when one was found. */
  link: ExtractedLink | null;
  /** Distinct destinations found whose text matched the anchor but URL differed. */
  sameTextDifferentUrl: string[];
}

/**
 * Find the anchor that points at `expectedUrl`.
 *
 * When several anchors point at the same URL (a nav link plus the in-article
 * link), prefer the one whose text matches the agreed anchor: that is the link we
 * were asked to verify, and picking the nav link would report the wrong rel.
 */
export function findDestination(
  links: ExtractedLink[],
  expectedUrl: string,
  expectedAnchor?: string | null,
): DestinationCheck {
  const candidates = links.filter((l) => !l.dynamic && l.href && sameDestination(l.href, expectedUrl));

  if (candidates.length === 0) {
    const anchor = normaliseAnchorForCompare(expectedAnchor ?? "");
    const sameTextDifferentUrl = anchor
      ? [...new Set(links.filter((l) => !l.dynamic && l.href && normaliseAnchorForCompare(l.text) === anchor).map((l) => l.href))]
      : [];
    return { found: false, link: null, sameTextDifferentUrl };
  }

  const anchor = normaliseAnchorForCompare(expectedAnchor ?? "");
  const withMatchingText = anchor
    ? candidates.find((l) => normaliseAnchorForCompare(l.text) === anchor)
    : undefined;

  return { found: true, link: withMatchingText ?? candidates[0] ?? null, sameTextDifferentUrl: [] };
}

export interface AnchorCheck {
  matches: boolean;
  expected: string;
  actual: string;
  /** How the comparison was made, so a mismatch is explainable. */
  mode: "exact" | "normalised" | "contains" | "none";
}

/**
 * Compare anchor text.
 *
 * Three tiers rather than one boolean, because "the anchor is slightly different"
 * and "the anchor is something else entirely" are different conversations with a
 * publisher. Exact equality is the requirement; normalised equality (case,
 * whitespace, smart quotes) is usually acceptable; containment means something
 * was added or dropped.
 */
export function checkAnchor(actual: string, expected: string): AnchorCheck {
  const expectedTrim = (expected ?? "").trim();
  if (expectedTrim.length === 0) {
    return { matches: true, expected: expectedTrim, actual, mode: "none" };
  }

  if (actual.trim() === expectedTrim) {
    return { matches: true, expected: expectedTrim, actual, mode: "exact" };
  }

  const a = normaliseAnchorForCompare(actual);
  const e = normaliseAnchorForCompare(expectedTrim);

  if (a === e) return { matches: true, expected: expectedTrim, actual, mode: "normalised" };
  if (a.includes(e)) return { matches: false, expected: expectedTrim, actual, mode: "contains" };

  return { matches: false, expected: expectedTrim, actual, mode: "none" };
}

export interface RelCheck {
  matches: boolean;
  expected: string[];
  actual: string[];
  /** Attributes present that were not expected. */
  unexpected: string[];
  /** Attributes expected that are missing. */
  missing: string[];
}

/**
 * Compare link attributes.
 *
 * Only the equity-bearing tokens matter: `nofollow`, `sponsored` and `ugc`
 * decide whether a link passes ranking signal, which is the commercial point of
 * the placement.
 *
 * `noopener` and `noreferrer` are IGNORED rather than compared. They are security
 * attributes that CMSs add automatically, they say nothing about link equity, and
 * treating them as a mismatch would flag most correctly-placed links as wrong.
 */
const EQUITY_REL = new Set(["nofollow", "sponsored", "ugc"]);

export function checkRel(actual: string[], expected: string[] | null | undefined): RelCheck {
  const filter = (tokens: string[]) =>
    [...new Set(tokens.map((t) => t.toLowerCase().trim()).filter((t) => EQUITY_REL.has(t)))].sort();

  const actualSet = filter(actual);
  const expectedSet = filter(expected ?? []);

  const missing = expectedSet.filter((t) => !actualSet.includes(t));
  const unexpected = actualSet.filter((t) => !expectedSet.includes(t));

  return {
    matches: missing.length === 0 && unexpected.length === 0,
    expected: expectedSet,
    actual: actualSet,
    unexpected,
    missing,
  };
}

/** Parse a stored rel string ("nofollow sponsored") into tokens. */
export function parseRel(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.toLowerCase().split(/[\s,]+/).filter(Boolean);
}
