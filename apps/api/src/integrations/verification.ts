/**
 * BACKLINK VERIFICATION SERVICE.
 *
 * Answers the five questions the brief asks, and records each one:
 *
 *   1. Does the live URL respond?
 *   2. Does the backlink exist?
 *   3. Is the destination URL correct?
 *   4. Does the anchor text match?
 *   5. Do the link attributes match what was expected?
 *
 * The previous implementation could answer (1) and, unreliably, (2). It tested
 * `html.includes(pageUrl)` — which is true of the page's own canonical tag — so a
 * removed link still reported as found. It never looked at the destination, the
 * anchor or the rel.
 *
 * Everything here is conservative on purpose: a fetch failure is `unreachable`,
 * NOT `link_missing`. Conflating "I could not reach the page" with "the link is
 * gone" is how a monitoring system cries wolf until nobody reads it.
 */

import { fetchSafely, UnsafeUrlError } from "./url-safety.js";
import { classifyAnchor, displayGroupOf } from "@crm/shared";
import { detectJsShell } from "./js-shell.js";
import {
  checkAnchor,
  checkRel,
  extractLinks,
  findDestination,
  parseRel,
  type AnchorCheck,
  type RelCheck,
} from "./link-extraction.js";

export type VerificationVerdict =
  | "ok"
  | "link_missing"
  | "url_mismatch"
  | "anchor_mismatch"
  | "attr_mismatch"
  | "unreachable"
  /**
   * The page loaded but could not be judged — it is a JavaScript shell, so the link
   * may exist after rendering. Neither "ok" (we did not find it) nor "link_missing"
   * (we did not prove it absent).
   */
  | "needs_manual_review";

export interface VerificationInput {
  /** The publisher article page that should contain the link. */
  liveUrl: string;
  /** The client page the link should point at. */
  expectedUrl: string;
  /** The anchor text that was agreed. */
  expectedAnchor?: string | null;
  /** The rel tokens that were agreed, e.g. ["nofollow"] or [] for a followed link. */
  expectedRel?: string[] | null;
  /** The anchor type on the placement, to compare against what was found. */
  expectedAnchorType?: string | null;
}

export interface VerificationOutcome {
  verdict: VerificationVerdict;
  httpStatus: number | null;
  finalUrl: string | null;
  elapsedMs: number;

  found: boolean;
  foundUrl: string | null;

  urlMatches: boolean;
  anchor: AnchorCheck;
  anchorFoundText: string | null;
  rel: RelCheck;

  /** Human-readable explanation, suitable for an audit row or a UI badge. */
  failureReason: string | null;
  /** Data retained on the check row for later investigation. */
  detail: Record<string, unknown>;
}

/**
 * Analyse already-fetched HTML and answer the five questions.
 *
 * Separated from `verifyBacklink` so the judgement about a page can be tested
 * without a network, and so a future HTML source (an archived copy, a proxy
 * response) can be analysed by the same rules. `verifyBacklink` is this plus the
 * guarded fetch.
 */
export function analysePage(
  html: string,
  pageUrl: string,
  input: Omit<VerificationInput, "liveUrl">,
  httpStatus: number | null = 200,
): VerificationOutcome {
  const started = Date.now();
  const emptyAnchor = checkAnchor("", input.expectedAnchor ?? "");
  const emptyRel = checkRel([], input.expectedRel ?? []);

  const links = extractLinks(html, pageUrl);
  const destination = findDestination(links, input.expectedUrl, input.expectedAnchor);

  if (!destination.found) {
    // Before concluding the link is gone, check whether the page could be judged at
    // all.
    //
    // A client-rendered page returns a shell and builds its content in the browser.
    // No anchor in that HTML is not evidence of a missing link — it is evidence that
    // the server response does not contain the article. Reporting `link_missing`
    // would send someone to complain about a link that is fine; `needs_manual_review`
    // says what actually happened.
    //
    // Only reached when no link was found: if the anchor IS present in the server
    // HTML, the page was judgeable and the normal verdict stands.
    const shell = detectJsShell(html);
    if (shell.isShell) {
      return {
        verdict: "needs_manual_review",
        httpStatus,
        finalUrl: pageUrl,
        elapsedMs: Date.now() - started,
        found: false,
        foundUrl: null,
        urlMatches: false,
        anchor: emptyAnchor,
        anchorFoundText: null,
        rel: emptyRel,
        failureReason: shell.reason,
        detail: {
          kind: "js_shell",
          anchorCount: links.length,
          textLength: shell.textLength,
          signals: shell.signals,
        },
      };
    }

    const reason =
      destination.sameTextDifferentUrl.length > 0
        ? `Anchor text is present but points at ${destination.sameTextDifferentUrl[0]} instead of ${input.expectedUrl}`
        : `No link to ${input.expectedUrl} found among ${links.length} anchors`;

    return {
      verdict: destination.sameTextDifferentUrl.length > 0 ? "url_mismatch" : "link_missing",
      httpStatus,
      finalUrl: pageUrl,
      elapsedMs: Date.now() - started,
      found: false,
      foundUrl: destination.sameTextDifferentUrl[0] ?? null,
      urlMatches: false,
      anchor: emptyAnchor,
      anchorFoundText: null,
      rel: emptyRel,
      failureReason: reason,
      detail: {
        kind: "not_found",
        anchorCount: links.length,
        sameTextDifferentUrl: destination.sameTextDifferentUrl,
      },
    };
  }

  const link = destination.link!;
  const anchorCheck = checkAnchor(link.text, input.expectedAnchor ?? "");
  const relCheck = checkRel(link.rel, input.expectedRel ?? []);

  // Compare the anchor we FOUND against the category the placement claims.
  //
  // This is the fifth question in a form the brief does not ask explicitly but
  // that operators care about: a placement recorded as `exact_match` whose live
  // anchor is actually "click here" is mislabelled, and the anchor report built on
  // that label is wrong. Previously `expectedAnchorType` was passed by both callers
  // and read by neither, so this could not be detected at all.
  //
  // It is reported as a separate field rather than folded into `verdict`: a
  // mislabelled category is a recordkeeping problem, not a broken link, and it must
  // not mask a genuine anchor or attribute mismatch.
  const classified = classifyAnchor(link.text, input.expectedUrl, {});
  const categoryMatches =
    !input.expectedAnchorType || !classified
      ? null
      : displayGroupOf(classified) === displayGroupOf(input.expectedAnchorType);

  // Precedence matters: a wrong anchor is more serious than a wrong rel, because
  // it changes what the client is optimising for. Reporting the first failure in
  // that order tells the reader the thing to fix first.
  let verdict: VerificationVerdict = "ok";
  let failureReason: string | null = null;

  if (!anchorCheck.matches) {
    verdict = "anchor_mismatch";
    failureReason =
      anchorCheck.mode === "contains"
        ? `Anchor contains the expected text but is longer: found "${link.text}", expected "${anchorCheck.expected}"`
        : `Anchor text differs: found "${link.text}", expected "${anchorCheck.expected}"`;
  } else if (!relCheck.matches) {
    verdict = "attr_mismatch";
    failureReason =
      relCheck.missing.length > 0
        ? `Missing rel attribute(s): ${relCheck.missing.join(", ")}`
        : `Unexpected rel attribute(s): ${relCheck.unexpected.join(", ")}`;
  }

  return {
    verdict,
    httpStatus,
    finalUrl: pageUrl,
    elapsedMs: Date.now() - started,
    found: true,
    foundUrl: link.href,
    // findDestination only returns links that normalise to the same host+path, so
    // a match here IS a destination match.
    urlMatches: true,
    anchor: anchorCheck,
    anchorFoundText: link.text,
    rel: relCheck,
    failureReason,
    detail: {
      kind: "found",
      rawHref: link.rawHref,
      rel: link.rel,
      anchorCount: links.length,
      // Informational: the category observed, and whether it agrees with the
      // placement's recorded one. `null` when the placement has no category.
      classifiedAnchorType: classified,
      anchorCategoryMatches: categoryMatches,
    },
  };
}

export async function verifyBacklink(input: VerificationInput): Promise<VerificationOutcome> {
  const started = Date.now();

  const emptyAnchor = checkAnchor("", input.expectedAnchor ?? "");
  const emptyRel = checkRel([], input.expectedRel ?? []);

  const unreachable = (reason: string, extra: Record<string, unknown> = {}): VerificationOutcome => ({
    verdict: "unreachable",
    httpStatus: null,
    finalUrl: null,
    elapsedMs: Date.now() - started,
    found: false,
    foundUrl: null,
    urlMatches: false,
    anchor: { ...emptyAnchor, matches: false },
    anchorFoundText: null,
    rel: { ...emptyRel, matches: false },
    failureReason: reason,
    detail: { kind: "unreachable", reason, ...extra },
  });

  // The live URL is user-supplied; the guard may reject it outright. That is a
  // blocked request, not an unreachable site, and the distinction matters to
  // whoever set the URL.
  let page: Awaited<ReturnType<typeof fetchSafely>>;
  try {
    page = await fetchSafely(input.liveUrl);
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      return unreachable(`Refused to fetch: ${err.reason}`, { kind: "blocked" });
    }
    return unreachable((err as Error).message);
  }

  const elapsedMs = Date.now() - started;

  // A non-2xx page is not one we can judge. Report it as unreachable rather than
  // claiming the link is gone: a 403 from Cloudflare says nothing about the link.
  if (page.status < 200 || page.status >= 300) {
    return {
      ...unreachable(`Page returned HTTP ${page.status}`, { httpStatus: page.status }),
      httpStatus: page.status,
      finalUrl: page.finalUrl,
      elapsedMs,
    };
  }

  if (page.html.length === 0) {
    return {
      ...unreachable("Page returned no HTML (wrong content type or empty body)"),
      httpStatus: page.status,
      finalUrl: page.finalUrl,
      elapsedMs,
    };
  }

  // The judgement about the page is `analysePage`'s job; this function only owns
  // the fetch, the guard and the pages we refuse to judge.
  const outcome = analysePage(page.html, page.finalUrl, input, page.status);

  return {
    ...outcome,
    elapsedMs: Date.now() - started,
    detail: { ...outcome.detail, hops: page.hops, elapsedMs: Date.now() - started },
  };
}

/**
 * Re-classify a stored rel string, for callers that hold a placement row rather
 * than a typed value.
 */
export function expectedRelFromPlacement(
  linkType: string | null | undefined,
  relAttribute: string | null | undefined,
): string[] {
  if (relAttribute) return parseRel(relAttribute);
  switch (linkType) {
    case "nofollow":
      return ["nofollow"];
    case "ugc":
      return ["ugc"];
    case "sponsored":
      return ["sponsored"];
    case "dofollow":
      return [];
    default:
      return [];
  }
}
