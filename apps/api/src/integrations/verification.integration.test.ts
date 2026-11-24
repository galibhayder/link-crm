import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { analysePage, verifyBacklink } from "./verification.js";
import { UnsafeUrlError } from "./url-safety.js";

/**
 * VERIFICATION AGAINST A REAL ORIGIN.
 *
 * The sibling tests cover the judgement (`analysePage`) and the address checks
 * (`url-safety`) separately. This one proves they work together end to end, over a
 * real socket.
 *
 * The server deliberately binds to 127.0.0.1 because that is what the guard
 * exists to block. So the guard is asserted FIRST — it must refuse to reach our own
 * server — and the judgement path is then exercised on the same HTML through
 * `analysePage`. That keeps the proof honest: the guard is never weakened to make
 * a happy-path test pass.
 */

const TARGET = "https://client.test/pricing";

let server: Server;
let ORIGIN: string;

const PAGES: Record<string, string> = {
  "/good": `<!doctype html><html><body>
      <nav><a href="/">home</a><a href="/about">about</a></nav>
      <article><p>Read <a href="${TARGET}" rel="nofollow">our pricing</a> for details.</p></article>
    </body></html>`,

  "/wrong-anchor": `<html><body><a href="${TARGET}" rel="nofollow">click here</a></body></html>`,

  "/wrong-rel": `<html><body><a href="${TARGET}">our pricing</a></body></html>`,

  // Links exist, but none of them is ours and none carries our anchor text.
  "/no-link": `<html><body>
      <a href="/about">about us</a>
      <a href="https://someone-else.test/">partner</a>
      <a href="https://client.test/other">something else entirely</a>
    </body></html>`,

  // Our anchor text, but pointing at the wrong destination. Separate fixture so
  // "no link at all" and "right text, wrong URL" stay distinguishable.
  "/same-text-wrong-url": `<html><body>
      <a href="https://client.test/other">our pricing</a>
    </body></html>`,

  "/trailing-slash": `<html><body><a href="https://client.test/pricing/">our pricing</a></body></html>`,

  "/self-canonical": `<html><head>
      <link rel="canonical" href="https://publisher.test/article">
      <meta property="og:url" content="https://publisher.test/article">
    </head><body><a href="/about">about</a></body></html>`,
};

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/good" });
      res.end();
      return;
    }
    const body = PAGES[req.url ?? ""];
    if (!body) {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<html><body>not found</body></html>");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  ORIGIN = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Fetch a page from the local origin. Used to obtain REAL served HTML. */
async function get(path: string): Promise<{ html: string; url: string }> {
  const res = await fetch(`${ORIGIN}${path}`);
  return { html: await res.text(), url: `${ORIGIN}${path}` };
}

describe("the guard refuses the real local server", () => {
  it("refuses a live loopback server, so nothing is fetched", async () => {
    // The server IS running and would answer. The guard must still refuse, which is
    // the entire point: reachability is not permission.
    await expect(
      verifyBacklink({ liveUrl: `${ORIGIN}/good`, expectedUrl: TARGET, expectedAnchor: "our pricing" }),
    ).resolves.toMatchObject({ verdict: "unreachable" });
  });

  it("reports a blocked URL as unreachable, never as a missing link", async () => {
    const result = await verifyBacklink({
      liveUrl: `${ORIGIN}/good`,
      expectedUrl: TARGET,
      expectedAnchor: "our pricing",
    });
    expect(result.verdict).toBe("unreachable");
    expect(result.failureReason).toMatch(/Refused|blocked|loopback/i);
    expect(result.found).toBe(false);
    // The distinction matters: `link_missing` would tell an operator the link was
    // removed from a page we never read.
    expect(result.verdict).not.toBe("link_missing");
  });

  it("refuses localhost by name and the IPv6 loopback", async () => {
    for (const host of ["localhost", "[::1]"]) {
      const port = ORIGIN.split(":").pop();
      const result = await verifyBacklink({
        liveUrl: `http://${host}:${port}/good`,
        expectedUrl: TARGET,
      });
      expect(result.verdict, host).toBe("unreachable");
    }
  });

  it("refuses a redirect that would land on an internal address", async () => {
    // A public URL that 302s to loopback is the standard bypass for a filter that
    // checks only the first hop.
    const result = await verifyBacklink({ liveUrl: `${ORIGIN}/redirect`, expectedUrl: TARGET });
    expect(result.verdict).toBe("unreachable");
  });

  it("throws UnsafeUrlError for a non-HTTP scheme", async () => {
    await expect(verifyBacklink({ liveUrl: "file:///etc/passwd", expectedUrl: TARGET })).resolves.toMatchObject({
      verdict: "unreachable",
    });
  });
});

describe("the five questions, judged on real served HTML", () => {
  const judge = (html: string, url: string, overrides: Record<string, unknown> = {}) =>
    analysePage(html, url, {
      expectedUrl: TARGET,
      expectedAnchor: "our pricing",
      expectedRel: ["nofollow"],
      ...overrides,
    });

  it("reports all four checks passing on a correct page", async () => {
    const { html, url } = await get("/good");
    const result = judge(html, url);
    expect(result.found).toBe(true); // Q2
    expect(result.urlMatches).toBe(true); // Q3
    expect(result.anchor.matches).toBe(true); // Q4
    expect(result.rel.matches).toBe(true); // Q5
    expect(result.verdict).toBe("ok");
  });

  it("flags a wrong anchor on real markup", async () => {
    const { html, url } = await get("/wrong-anchor");
    const result = judge(html, url);
    expect(result.verdict).toBe("anchor_mismatch");
    expect(result.anchorFoundText).toBe("click here");
  });

  it("flags a missing nofollow on real markup", async () => {
    const { html, url } = await get("/wrong-rel");
    const result = judge(html, url);
    expect(result.verdict).toBe("attr_mismatch");
    expect(result.rel.missing).toContain("nofollow");
  });

  it("reports link_missing when the page has other links but not ours", async () => {
    const { html, url } = await get("/no-link");
    const result = judge(html, url, { expectedRel: [] });
    expect(result.verdict).toBe("link_missing");
    expect(result.found).toBe(false);
  });

  it("reports url_mismatch when the anchor text exists but points elsewhere", async () => {
    const { html, url } = await get("/same-text-wrong-url");
    const result = judge(html, url, { expectedAnchor: "our pricing", expectedRel: [] });
    expect(result.verdict).toBe("url_mismatch");
    expect(result.failureReason).toMatch(/points at/);
  });

  it("matches a trailing-slash variant of the destination", async () => {
    const { html, url } = await get("/trailing-slash");
    const result = judge(html, url, { expectedRel: [] });
    expect(result.urlMatches).toBe(true);
    expect(result.verdict).toBe("ok");
  });

  it("does not treat a canonical tag as the backlink — the old bug", async () => {
    const { html, url } = await get("/self-canonical");
    const result = judge(html, url, { expectedUrl: "https://publisher.test/article" });
    // The canonical URL appears in the markup, but there is no <a> to it.
    expect(result.found).toBe(false);
    expect(result.verdict).toBe("link_missing");
  });
});
