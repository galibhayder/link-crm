/**
 * PHASE 5.1 — UI VERIFICATION.
 *
 * The API suites prove the rules. This proves the screens exist, are reachable, and
 * — most importantly — that the two surfaces stay separate in the browser, which is
 * the constraint the review asked for. A client must never see an internal menu, and
 * typing an internal URL must not render an internal page.
 */
import puppeteer from "puppeteer";

const BASE = "http://localhost:5173";
const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A fresh context per user — the same reasoning as the Phase 4 suite: the Supabase
 * client caches its session in memory, so clearing storage in one tab is not the
 * same thing as a different person signing in.
 */
let context = await browser.createBrowserContext();
let page = await context.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleErrors = [];
const attach = (p) => {
  p.on("pageerror", (e) => consoleErrors.push(String(e.message)));
  p.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
};
attach(page);

async function login(email) {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    if (!page.url().includes("/login")) break;
  }
  await sleep(1800);
}

async function asUser(email) {
  await context.close();
  context = await browser.createBrowserContext();
  page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  attach(page);
  await login(email);
  return page;
}

const bodyText = () => page.evaluate(() => document.body.innerText);
const navLinks = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("nav a")).map((a) => ({
      text: (a.textContent ?? "").trim(),
      href: a.getAttribute("href") ?? "",
    })),
  );

// ===========================================================================
console.log("\n1. the client lands in the portal, not the CRM");
// ===========================================================================
{
  await asUser("client@demo.test");

  check("the client is redirected to /portal", page.url().includes("/portal"), page.url());

  await page.waitForSelector("nav[aria-label='Portal']", { timeout: 20000 });
  check("the portal navigation renders", true);

  const nav = await navLinks();
  const labels = nav.map((n) => n.text);

  check("portal nav has Overview", labels.some((l) => /Overview/.test(l)));
  check("portal nav has Campaigns", labels.some((l) => /Campaigns/.test(l)));
  check("portal nav has Content", labels.some((l) => /Content/.test(l)));

  // Internal-only modules must be absent. "Invoices" was on this list in Phase 5.1
  // because the portal had no invoicing; Phase 6 added a client-safe Invoices screen
  // (their own bills, via /portal/v1), so it is now a legitimate portal destination
  // and is asserted as PRESENT in verify-phase6-ui instead.
  const internal = ["Placements", "Outreach", "Anchors", "Approvals", "Staff", "Audit", "Suppliers", "Financials"];
  for (const item of internal) {
    check(`the portal has no "${item}" link`, !labels.some((l) => l === item || l.startsWith(`${item} `)));
  }

  const text = await bodyText();
  check("the portal says it is the client portal", /client portal/i.test(text));
  check("the overview heading is present", /Overview/.test(text));

  // Internal-only vocabulary must not appear anywhere on the page.
  const leaks = [
    ["writer payout", /writer payout/i],
    ["supplier cost", /supplier cost/i],
    ["negotiated cost", /negotiated cost/i],
    ["margin", /\bmargin\b/i],
    ["internal note", /internal note/i],
  ];
  for (const [label, re] of leaks) {
    check(`no ${label} on the portal overview`, !re.test(text));
  }
}

// ===========================================================================
console.log("\n2. a client typing an internal URL does not get the internal app");
// ===========================================================================
{
  const attempts = ["/", "/placements", "/approvals", "/content", "/anchors", "/staff"];
  for (const path of attempts) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
    await sleep(1200);
    const url = page.url();
    const text = await bodyText();

    // Either redirected back to the portal, or shown the client's portal view —
    // never an internal page.
    const inPortal = url.includes("/portal");
    const looksInternal = /Approvals|Outreach templates|Pipeline stage/i.test(text) && !inPortal;
    check(
      `client at ${path} does not reach an internal screen`,
      inPortal || !looksInternal,
      `${url.replace(BASE, "") || "/"}`,
    );
  }
}

// ===========================================================================
console.log("\n3. the client can review a draft without an edit affordance");
// ===========================================================================
{
  await page.goto(`${BASE}/portal/drafts`, { waitUntil: "networkidle2" });
  await sleep(2000);

  const text = await bodyText();
  check("the content page renders", /Content/.test(text));

  const cards = await page.$$('a[href^="/portal/drafts/"]');
  check("there is at least one draft to open", cards.length > 0, `${cards.length} drafts`);

  if (cards.length > 0) {
    await cards[0].click();
    await sleep(2200);

    const detail = await bodyText();
    check("the draft detail renders a title area", /Article|Status/i.test(detail));

    // No editing controls anywhere on the review screen.
    const editable = await page.evaluate(() => {
      const textareas = document.querySelectorAll("textarea");
      const contentEditable = document.querySelectorAll('[contenteditable="true"]');
      // The one allowed textarea is the approval note, which is not draft content.
      return { textareas: textareas.length, contentEditable: contentEditable.length };
    });
    check("draft content is not editable", editable.contentEditable === 0, `${editable.contentEditable} contenteditable`);
    check(
      "the only text field is the approval note, not the body",
      editable.textareas <= 1,
      `${editable.textareas} textarea(s)`,
    );

    const hasApprove = /Approve article|Approve/i.test(detail);
    const hasRevision = /Request changes/i.test(detail);
    check("an approve action is offered (or already decided)", hasApprove || /published|approved/i.test(detail));
    check("a revision action is offered (or already decided)", hasRevision || /published|approved/i.test(detail));
  }
}

// ===========================================================================
console.log("\n4. the Account Manager sees the CRM and the approval queue");
// ===========================================================================
{
  await asUser("am@demo.test");

  const url = page.url();
  check("the AM lands inside the CRM, not the portal", !url.includes("/portal"), url.replace(BASE, ""));

  await page.waitForSelector("nav", { timeout: 20000 });
  const nav = await navLinks();
  const labels = nav.map((n) => n.text);

  check("the AM sees Approvals in the menu", labels.some((l) => /Approvals/i.test(l)));
  check("the AM sees Placements", labels.some((l) => /Placements/i.test(l)));

  // account_manager legitimately holds `staff:read` (they need to see who is
  // assigned to what), but NOT `staff:manage`. Seeing the page is correct; being
  // able to invite or change roles is not. Assert the split, not the absence.
  const amPerms = await page.evaluate(async () => {
    const res = await fetch("/api/v1/me/permissions", {
      headers: {
        authorization: `Bearer ${
          JSON.parse(localStorage.getItem("linkforge-auth") ?? "{}")?.access_token ?? ""
        }`,
      },
    });
    return res.ok ? (await res.json()).data : null;
  });
  if (amPerms) {
    const held = new Set(amPerms.permissions ?? []);
    check("the AM can read staff", held.has("staff:read"));
    check("the AM cannot manage staff", !held.has("staff:manage"));
  } else {
    check("the AM permission set is readable", false, "permissions request failed");
  }

  await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle2" });
  await sleep(2200);

  const text = await bodyText();
  check("the approvals page renders", /Approvals/i.test(text));
  check("it has a placements tab", /Placements/i.test(text));
  check("it has a content tab", /Content/i.test(text));
  check("it has a prospects tab", /Prospects/i.test(text));
  check("it has a publishers tab", /Publishers/i.test(text));
  check(
    "it shows a count of what is waiting",
    /awaiting you/i.test(text),
  );

  // The bell is the visible delivery surface for anchor alerts.
  const bell = await page.$('button[aria-label*="Notification" i]');
  check("the notification bell is present in the header", Boolean(bell));

  if (bell) {
    await bell.click();
    await sleep(1500);
    const panel = await bodyText();
    check(
      "the bell opens a panel with either notifications or an empty state",
      /Notifications/i.test(panel),
    );
    await page.keyboard.press("Escape");
    await sleep(500);
  }
}

// ===========================================================================
console.log("\n5. the AM cannot reach the portal");
// ===========================================================================
{
  await page.goto(`${BASE}/portal`, { waitUntil: "networkidle2" });
  await sleep(1800);
  const text = await bodyText();
  const url = page.url();

  check(
    "an AM at /portal is sent elsewhere",
    !url.endsWith("/portal") || /not found|404|no access|dashboard/i.test(text),
    url.replace(BASE, ""),
  );
}

// ===========================================================================
console.log("\n6. the owner sees the full navigation surface");
// ===========================================================================
{
  await asUser("owner@demo.test");
  await page.waitForSelector("nav", { timeout: 20000 });

  const nav = await navLinks();
  const labels = nav.map((n) => n.text);

  check("the owner sees Approvals", labels.some((l) => /Approvals/i.test(l)));
  check("the owner sees Agency Partners", labels.some((l) => /Agency Partners/i.test(l)));

  // Modules without a full UI must be visibly marked, not silently missing — this is
  // what makes them trackable rather than forgotten.
  const text = await bodyText();
  const soonCount = await page.evaluate(() =>
    document.body.innerText.split("\n").filter((l) => /^SOON$/i.test(l.trim())).length,
  );
  check("unbuilt modules are marked SOON in the nav", soonCount > 0, `${soonCount} marked`);
  check("Agency Partners is present in the nav", /Agency Partners/i.test(text));
}

// ===========================================================================
console.log("\n7. no runtime errors during the walkthrough");
// ===========================================================================
{
  // Ignore benign noise: favicon 404s and React DevTools notices are not defects.
  const real = consoleErrors.filter(
    (e) =>
      !/favicon|DevTools|Download the React|ResizeObserver loop/i.test(e) &&
      !/Failed to load resource.*404.*favicon/i.test(e),
  );
  check("no uncaught page errors", real.length === 0, real.slice(0, 3).join(" | "));
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
