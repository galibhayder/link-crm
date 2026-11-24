import { describe, expect, it } from "vitest";
import { detectJsShell } from "./js-shell.js";
import { analysePage } from "./verification.js";

/**
 * JAVASCRIPT SHELL DETECTION.
 *
 * The defect this fixes: a client-rendered page returns a nearly empty document, so
 * no anchor is found and the verifier reported `link_missing` — sending someone to
 * complain about a link that was never absent. `needs_manual_review` says what
 * actually happened instead.
 *
 * The risk of the fix is the opposite error: treating a genuinely short static page
 * as unjudgeable, which would replace one false negative with another. Both
 * directions are tested.
 */

const TARGET = "https://client.test/pricing";
const PAGE = "https://publisher.test/article";

/** A typical React/Vue SPA shell: a mount point and a bundle, no article. */
const SPA_SHELL = `<!doctype html><html><head>
  <title>Article — Publisher</title>
  <script type="module" src="/assets/index-a1b2c3.js"></script>
</head><body>
  <div id="root"></div>
</body></html>`;

const NEXT_SHELL = `<!doctype html><html><head><title>Post</title></head><body>
  <div id="__next"></div>
  <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>
  <script src="/_next/static/chunks/main-abc.js"></script>
</body></html>`;

const NOSCRIPT_SHELL = `<!DOCTYPE html><html><body>
  <div id="app"></div>
  <noscript>You need to enable JavaScript to run this app.</noscript>
</body></html>`;

/** A real server-rendered article. Long text, no mount point. */
const REAL_ARTICLE = `<!doctype html><html><body>
  <article>
    <h1>Choosing an analytics platform in 2026</h1>
    <p>Analytics tooling has changed a great deal over the past few years, and the
    choices available to a mid-market company are now broader than they were. This
    article walks through the trade-offs between the major platforms, the pricing
    models you are likely to encounter, and the operational burden each carries.</p>
    <p>For most teams the deciding factor is not the feature list but the cost of
    ownership: how much work is required to keep the pipeline healthy, and who is
    responsible when it breaks. We look at three common configurations.</p>
    <p>Read <a href="${TARGET}">our pricing</a> for the detail.</p>
    <p>Beyond the immediate comparison there is the question of what happens in year
    two, when the initial implementation has settled and the team has changed.</p>
  </article>
</body></html>`;

/** A legitimately short static page — must NOT be treated as a shell. */
const SHORT_STATIC = `<!doctype html><html><body>
  <p>This domain is for sale. Contact us.</p>
</body></html>`;

describe("detectJsShell", () => {
  it("recognises a React/Vue mount point with no content", () => {
    const result = detectJsShell(SPA_SHELL);
    expect(result.isShell).toBe(true);
    expect(result.reason).toMatch(/client-rendered/i);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("recognises a Next.js shell", () => {
    expect(detectJsShell(NEXT_SHELL).isShell).toBe(true);
  });

  it("recognises a noscript banner as a shell signal", () => {
    const result = detectJsShell(NOSCRIPT_SHELL);
    expect(result.isShell).toBe(true);
    expect(result.signals.some((s) => /javascript/i.test(s))).toBe(true);
  });

  it("does NOT treat a full server-rendered article as a shell", () => {
    const result = detectJsShell(REAL_ARTICLE);
    expect(result.isShell).toBe(false);
    expect(result.textLength).toBeGreaterThan(400);
  });

  it("does NOT treat a short static page as a shell", () => {
    // The false positive that would matter most: a short page with no framework
    // markers is simply a short page. Calling it "cannot judge" would hide a real
    // missing link behind a review prompt.
    const result = detectJsShell(SHORT_STATIC);
    expect(result.isShell).toBe(false);
    expect(result.textLength).toBeLessThan(400);
  });

  it("does not fire on an article that merely discusses JavaScript", () => {
    // Matching the bare word "javascript" would flag every tech publisher.
    const html = `<html><body><article>
      <h1>Why JavaScript bundlers matter</h1>
      <p>${"JavaScript is a language. ".repeat(40)}</p>
    </article></body></html>`;
    expect(detectJsShell(html).isShell).toBe(false);
  });

  it("ignores a long page that happens to contain a mount point", () => {
    // Some server-rendered sites embed a React widget in an otherwise complete
    // page. Plenty of text means the page was judgeable.
    const html = `${REAL_ARTICLE.replace("</body>", '<div id="root"></div></body>')}`;
    expect(detectJsShell(html).isShell).toBe(false);
  });

  it("returns a zero-length verdict for an empty document without claiming it is a shell", () => {
    const result = detectJsShell("");
    expect(result.isShell).toBe(false);
    expect(result.textLength).toBe(0);
  });
});

describe("analysePage — shell handling end to end", () => {
  it("reports needs_manual_review for a shell with no observable link", () => {
    const result = analysePage(SPA_SHELL, PAGE, { expectedUrl: TARGET, expectedRel: [] });
    expect(result.verdict).toBe("needs_manual_review");
    expect(result.found).toBe(false);
    expect(result.failureReason).toMatch(/client-rendered|after JavaScript/i);
    expect(result.detail.kind).toBe("js_shell");
  });

  it("still reports ok when the link IS in the server HTML of a shell-like page", () => {
    // If the anchor is present, the page was judgeable — the shell check must not
    // override a positive finding.
    const html = SPA_SHELL.replace("<div id=\"root\"></div>", `<div id="root"><a href="${TARGET}">our pricing</a></div>`);
    const result = analysePage(html, PAGE, { expectedUrl: TARGET, expectedRel: [] });
    expect(result.verdict).toBe("ok");
    expect(result.found).toBe(true);
  });

  it("still reports link_missing for a real page that genuinely lacks the link", () => {
    const html = REAL_ARTICLE.replace(`<a href="${TARGET}">our pricing</a>`, "a mention with no link");
    const result = analysePage(html, PAGE, { expectedUrl: TARGET, expectedRel: [] });
    expect(result.verdict).toBe("link_missing");
  });

  it("never reports link_missing for a shell", () => {
    for (const shell of [SPA_SHELL, NEXT_SHELL, NOSCRIPT_SHELL]) {
      const result = analysePage(shell, PAGE, { expectedUrl: TARGET, expectedRel: [] });
      expect(result.verdict).not.toBe("link_missing");
    }
  });
});
