/**
 * ANCHOR CLASSIFICATION.
 *
 * The agency brief asks for anchors to be categorised into Branded, Exact Match,
 * Partial Match and Generic/Naked URL, and for the distribution to be tracked so
 * over-optimisation is visible before Google notices.
 *
 * This is a heuristic, not a fact. Nothing here can know which of a client's
 * terms they actually want to rank for, so `exact_match` and `partial_match` are
 * derived from the target URL's path against the anchor text. That is the best
 * available signal, it is deterministic, and — most importantly — it is
 * OVERRIDABLE: a human can set `anchor_type` explicitly and this function never
 * runs for that placement. A classifier that silently re-labels a human's
 * judgement would make the whole report untrustworthy.
 *
 * Kept in packages/shared so the API (which writes the category) and the UI
 * (which previews it while typing an anchor) agree by construction.
 */

export const ANCHOR_CATEGORIES = [
  "branded",
  "exact_match",
  "partial_match",
  "generic",
  "naked_url",
  "image_alt",
] as const;

export type AnchorCategory = (typeof ANCHOR_CATEGORIES)[number];

/**
 * The four categories the brief names, for display.
 *
 * `naked_url` is shown under "Generic / Naked URL" because that is how the brief
 * groups it, but it is stored distinctly: a bare URL and the words "click here"
 * are different signals to a search engine and collapsing them at the storage
 * layer would lose the ability to tell them apart later.
 */
export const ANCHOR_DISPLAY_GROUPS = ["branded", "exact_match", "partial_match", "generic_or_naked"] as const;
export type AnchorDisplayGroup = (typeof ANCHOR_DISPLAY_GROUPS)[number];

export function displayGroupOf(category: string | null | undefined): AnchorDisplayGroup | "unclassified" {
  switch (category) {
    case "branded":
      return "branded";
    case "exact_match":
      return "exact_match";
    case "partial_match":
      return "partial_match";
    case "generic":
    case "naked_url":
      return "generic_or_naked";
    default:
      return "unclassified";
  }
}

/** Phrases that are anchors only in the loosest sense: they describe nothing. */
const GENERIC_PHRASES = new Set([
  "click here",
  "here",
  "read more",
  "learn more",
  "more",
  "this",
  "this page",
  "this article",
  "this post",
  "this website",
  "this site",
  "website",
  "site",
  "link",
  "source",
  "reference",
  "see more",
  "find out more",
  "check it out",
  "view",
  "visit",
  "details",
  "info",
  "information",
  "homepage",
  "home page",
]);

export interface AnchorContext {
  /** The client's brand name, e.g. "Acme". Used to detect branded anchors. */
  brandName?: string | null;
  /** The client's domain, e.g. "acme.com". A naked anchor is often this. */
  brandDomain?: string | null;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Minimal URL decomposition, without the global `URL` constructor.
 *
 * This package is compiled for BOTH the browser and Node and declares neither the
 * DOM nor the Node lib, so `new URL()` is not in scope. A regex is enough for the
 * two things needed here — the path's last segment and the hostname — and it keeps
 * the module dependency-free and identical in both environments.
 */
function splitUrl(value: string): { host: string; path: string } | null {
  const trimmed = value.trim();
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/?#]*)([^?#]*)/i.exec(trimmed);
  if (!match) return null;

  const scheme = match[1]?.toLowerCase();
  // A bare word like "analytics" parses as a host with no scheme; that is fine for
  // slug extraction but must not be treated as a domain, so callers check `host`
  // for a dot.
  const host = (match[2] ?? "").toLowerCase().replace(/^www\./, "");
  const path = match[3] ?? "";

  if (!scheme && !host.includes(".")) return null;
  return { host, path };
}

/** Strip a URL down to a comparable slug: "/features/analytics" → "analytics". */
function lastPathSegment(url: string | null | undefined): string {
  if (!url) return "";
  const parts = splitUrl(url);
  if (!parts) return "";

  const segments = parts.path.split("/").filter(Boolean);
  const last = segments[segments.length - 1] ?? "";
  // Drop a file extension: "best-tools.html" → "best-tools".
  return last.replace(/\.(html?|php|aspx?)$/i, "");
}

/** Hostname without "www.", for comparing against an anchor. */
function hostOf(value: string | null | undefined): string {
  if (!value) return "";
  const parts = splitUrl(value);
  if (!parts || !parts.host.includes(".")) return "";
  return parts.host;
}

/**
 * Is this anchor a bare URL rather than words?
 *
 * "https://acme.test/pricing", "www.acme.test", "acme.test" and "acme.test/x" all
 * qualify. "acme.test pricing" does not — that is a phrase that happens to start
 * with a domain, and calling it a naked URL would hide a real editorial anchor.
 */
function urlLikeKind(anchor: string): "full" | "domain" | null {
  const a = anchor.trim();

  // A scheme makes it unambiguous: this is a URL, whatever the host.
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(a)) return "full";
  if (/^www\.\S+\.\S+/i.test(a)) return "full";

  // A bare domain, with an optional path — and nothing else.
  if (/^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(a)) return "domain";

  return null;
}

function isNakedUrl(anchor: string, brandDomain: string): boolean {
  const kind = urlLikeKind(anchor);
  if (!kind) return false;
  // When we know the brand domain, only the brand's own domain counts: another
  // site's domain is an editorial citation, not a naked link to the client.
  if (brandDomain) return anchor.toLowerCase().includes(brandDomain);
  return true;
}

function isBranded(anchor: string, ctx: AnchorContext): boolean {
  const brandLower = normalise(ctx.brandName ?? "");
  if (!brandLower) return false;

  // Match the brand as a WORD, not as an arbitrary substring.
  //
  // A plain `anchor.includes("acme")` matches "acme.test" — the brand's own
  // domain written as text, which is a naked URL, not a branding anchor. It also
  // matches "acmecorp competitor", which is a different company. Requiring word
  // boundaries is what makes "Acme" branded without swallowing domains.
  if (anchor === brandLower) return true;

  const wordBoundary = new RegExp(`(^|\\s)${escapeRegExp(brandLower)}(\\s|$)`);
  if (wordBoundary.test(anchor)) return true;

  // "Acme's platform" — a possessive is still the brand as a word.
  return new RegExp(`(^|\\s)${escapeRegExp(brandLower)}'s(\\s|$)`).test(anchor);
}

/**
 * Classify one anchor.
 *
 * Returns `null` when there is nothing to classify, rather than guessing: an
 * empty anchor on an image link is not "generic", it is simply absent, and
 * counting it would distort every share in the report.
 */
export function classifyAnchor(
  anchorText: string | null | undefined,
  targetUrl?: string | null,
  context: AnchorContext = {},
): AnchorCategory | null {
  const raw = (anchorText ?? "").trim();
  if (raw.length === 0) return null;

  // An image anchor has no meaningful text-to-keyword relationship.
  if (/^\[?image:/i.test(raw) || /^\[image alt:/i.test(raw)) return "image_alt";

  const anchor = normalise(raw);
  const brandDomain = hostOf(context.brandDomain ?? "");

  // NAKED URL IS CHECKED FIRST, before the brand-name match.
  //
  // Order matters here and getting it wrong biases the report in the direction
  // that looks healthy. "https://acme.test/pricing" contains the brand name
  // "Acme" as a substring, so a brand check running first labels it branded — and
  // the client is told their anchors are on-brand when a third of them are bare
  // URLs. A URL is never a brand phrase, so it is classified as what it is.
  if (isNakedUrl(raw, brandDomain)) return "naked_url";

  if (isBranded(anchor, context)) return "branded";
  if (GENERIC_PHRASES.has(anchor)) return "generic";

  // Compare against the target page's slug.
  const slug = normalise(lastPathSegment(targetUrl).replace(/[-_]+/g, " "));
  if (slug.length > 0) {
    if (anchor === slug) return "exact_match";
    // A phrase containing the whole slug term is a partial match. Requiring the
    // slug to appear as a whole word stops "analytics" matching "analytic".
    const wordBoundary = new RegExp(`(^|\\s)${escapeRegExp(slug)}(\\s|$)`);
    if (wordBoundary.test(anchor)) return "partial_match";

    // A single-word slug also counts as partially matched when it is one token of
    // a longer anchor, e.g. slug "analytics" + anchor "marketing analytics tools".
    const slugWords = slug.split(" ").filter((w) => w.length > 2);
    if (slugWords.length > 0 && slugWords.every((w) => anchor.includes(w))) {
      return "partial_match";
    }
  }

  // Everything else that is neither brand nor bare URL nor a generic phrase is a
  // descriptive phrase, which is the definition of a partial match.
  return "partial_match";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether a category is over the healthy ceiling for its share.
 *
 * Used by the alert evaluator. `image_alt` and `unclassified` are excluded from
 * the default checks because neither has a meaningful target range.
 */
export function isOverOptimised(category: string, share: number, ceiling: number): boolean {
  if (category === "unclassified" || category === "image_alt") return false;
  return share > ceiling;
}
