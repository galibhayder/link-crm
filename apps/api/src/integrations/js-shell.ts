/**
 * JAVASCRIPT SHELL DETECTION.
 *
 * The verifier fetches a page's server HTML and looks for an anchor. That is correct
 * for a server-rendered article and wrong for a client-rendered one: a React, Vue or
 * Next app returns a nearly empty document and builds the article — including the
 * backlink — in the browser. Reporting `link_missing` there is a false negative that
 * sends someone to complain about a link which is actually fine.
 *
 * RENDERING PROPERLY IS NOT AN OPTION HERE
 *
 * A headless browser would answer the question exactly. Chromium is ~300 MB, needs a
 * sandbox and shared libraries the shared-hosting target does not have, and would put
 * a browser in the same process that serves the API. That is a large amount of runtime
 * for one check, so this module takes the honest middle path: recognise the shell,
 * say so, and ask a human to look.
 *
 * WHY THIS IS SAFE
 *
 * Purely a readability decision over bytes already fetched. It does not fetch, follow
 * redirects, or resolve anything — the SSRF guard and the DNS-address pinning in
 * `url-safety.ts` are completely untouched, and `analysePage` still runs only on HTML
 * that passed through them.
 */

/** Markers that a document is a client-rendered application shell. */
const FRAMEWORK_MARKERS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /<div[^>]+id=["']root["'][^>]*>\s*<\/div>/i, label: 'empty <div id="root"> (React/Vue mount point)' },
  { pattern: /<div[^>]+id=["']app["'][^>]*>\s*<\/div>/i, label: 'empty <div id="app"> (Vue/Angular mount point)' },
  { pattern: /<div[^>]+id=["']__next["'][^>]*>\s*<\/div>/i, label: 'empty <div id="__next"> (Next.js mount point)' },
  { pattern: /__NEXT_DATA__/, label: "Next.js __NEXT_DATA__ payload" },
  { pattern: /window\.__NUXT__/, label: "Nuxt window.__NUXT__ payload" },
  { pattern: /window\.__INITIAL_STATE__/, label: 'client state hydration payload' },
  { pattern: /<script[^>]+src=["'][^"']*\/_next\/static\//i, label: "Next.js static bundle" },
  { pattern: /<script[^>]+type=["']module["'][^>]*src=/i, label: "an ES-module bundle" },
];

/**
 * Text a browser would show only after JS runs.
 *
 * Deliberately specific phrases — matching a bare "javascript" would fire on any
 * article *about* JavaScript, which is exactly the false positive that would make
 * this check useless for tech publishers.
 */
const NOSCRIPT_HINTS = [
  /you need to enable javascript/i,
  /please enable javascript/i,
  /javascript is (required|disabled|not enabled)/i,
  /requires javascript to (run|work|view)/i,
  /this (site|page|app) requires javascript/i,
];

export interface ShellVerdict {
  /** True when the document looks like it needs JS to render its content. */
  isShell: boolean;
  /** Human-readable evidence, for the check's failure_reason. */
  reason: string | null;
  /** Which signals fired, for the JSON detail blob. */
  signals: string[];
  /** Approximate visible text length after tags are stripped. */
  textLength: number;
}

/** Strip tags, comments and scripts, then measure the remaining visible text. */
function visibleTextLength(html: string): number {
  const withoutIgnored = html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = withoutIgnored.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length;
}

/**
 * Is this document a shell that needs JavaScript before its content exists?
 *
 * The threshold matters. A real article page has hundreds of words — this repo's own
 * tests use pages of ~100 characters and those must NOT be treated as shells, or a
 * short legitimate page would become "needs review" instead of "link missing".
 *
 * So two conditions must agree:
 *   - little visible text (under 400 chars), AND
 *   - a positive framework signal.
 *
 * Text length alone is never enough: a short static page with no framework markers is
 * a short static page, and reporting it as "cannot judge" would be a different false
 * negative.
 */
export function detectJsShell(html: string): ShellVerdict {
  const textLength = visibleTextLength(html);

  if (html.trim().length === 0) {
    return { isShell: false, reason: null, signals: [], textLength };
  }

  const signals: string[] = [];

  for (const marker of FRAMEWORK_MARKERS) {
    if (marker.pattern.test(html)) signals.push(marker.label);
  }

  for (const hint of NOSCRIPT_HINTS) {
    if (hint.test(html)) signals.push("page tells the visitor JavaScript is required");
  }

  // A shell must be both thin on text and positively identified as client-rendered.
  const looksThin = textLength < 400;
  const hasSignal = signals.length > 0;

  if (!looksThin || !hasSignal) {
    return { isShell: false, reason: null, signals, textLength };
  }

  const reason =
    `Page looks client-rendered (${signals[0]}) with only ${textLength} characters of ` +
    `server HTML. The link may be present after JavaScript runs, so it cannot be ` +
    `verified from the server response.`;

  return { isShell: true, reason, signals: [...new Set(signals)], textLength };
}
