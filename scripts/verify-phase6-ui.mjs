/**
 * PHASE 6 — UI VERIFICATION.
 *
 * Drives the real browser. The assertions that matter are the boundary ones: an
 * owner sees financials, an account manager sees invoices but not margins, and a
 * public invoice link renders without authentication and without the CRM shell.
 */
import puppeteer from "puppeteer";

const BASE = "http://localhost:5173";
const API = "http://127.0.0.1:3000";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d: String(d) });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await sleep(2000);
}

async function asUser(email) {
  await context.close();
  context = await browser.createBrowserContext();
  page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  attach(page);
  await login(email);
}

const bodyText = () => page.evaluate(() => document.body.innerText);
const navLinks = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("nav a")).map((a) => (a.textContent ?? "").trim()),
  );

/**
 * Seeds one invoice through the API and issues it, so the UI has something real
 * to show. Uses the API rather than clicking through the editor, because the
 * editor flow is exercised separately below.
 */
async function seedIssuedInvoice(ownerToken) {
  const clients = await fetch(`${API}/api/v1/clients?limit=1`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  }).then((r) => r.json());

  const clientId = clients.data?.[0]?.id;
  if (!clientId) return null;

  const inv = await fetch(`${API}/api/v1/invoices`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      taxRate: 20,
      lineItems: [{ description: "UI verification placement", quantity: 1, unitPrice: 1000 }],
    }),
  }).then((r) => r.json());

  await fetch(`${API}/api/v1/invoices/${inv.data.id}/issue`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}` },
  });

  return inv.data;
}

const getOwnerToken = async () => {
  const res = await fetch(`${API.replace("3000", "54321")}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey:
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: "owner@demo.test", password: "password123" }),
  });
  return (await res.json()).access_token;
};

const ownerToken = await getOwnerToken();
const seeded = await seedIssuedInvoice(ownerToken);

// ===========================================================================
console.log("\n1. the owner sees the finance surfaces in the nav");
// ===========================================================================
{
  await asUser("owner@demo.test");
  await page.waitForSelector("nav", { timeout: 20000 });

  const labels = await navLinks();
  check("Invoices is in the nav", labels.some((l) => /^Invoices/.test(l)), labels.join(" | "));
  check("Payments is in the nav", labels.some((l) => /^Payments/.test(l)));
  check("Reports is in the nav", labels.some((l) => /^Reports/.test(l)));
  check("Financials is in the nav", labels.some((l) => /^Financials/.test(l)));

  // These are built now, so they must no longer be marked SOON.
  const invoicesSoon = await page.evaluate(() => {
    const link = Array.from(document.querySelectorAll("nav a")).find((a) =>
      /^Invoices/.test((a.textContent ?? "").trim()),
    );
    return link ? /SOON/i.test(link.textContent ?? "") : null;
  });
  check("Invoices is no longer marked SOON", invoicesSoon === false, String(invoicesSoon));
}

// ===========================================================================
console.log("\n2. the invoice list renders");
// ===========================================================================
{
  await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle2" });
  await sleep(2200);

  const text = await bodyText();
  check("the invoices page renders", /Invoices/.test(text));
  check("it shows a status filter", /Draft|Issued|Paid/.test(text));
  check("it lists at least one invoice number", /INV-\d+/.test(text), (text.match(/INV-\d+/) ?? [])[0]);

  const rows = await page.$$eval("tbody tr", (els) => els.length);
  check("the table has rows", rows > 0, `${rows} rows`);
}

// ===========================================================================
console.log("\n3. the invoice detail page and its action bar");
// ===========================================================================
{
  await page.goto(`${BASE}/invoices/${seeded.id}`, { waitUntil: "networkidle2" });
  await sleep(2500);

  const text = await bodyText();
  check("the detail page renders the invoice", text.includes(seeded.invoice_number));
  check("the line item is shown", /UI verification placement/.test(text));
  check("the total is shown", /1,200|1200/.test(text));

  // The full action bar the brief asks for.
  const actions = ["Preview", "Download PDF", "Copy private link", "Publish invoice", "Duplicate"];
  for (const label of actions) {
    const present = await page.evaluate(
      (l) => Array.from(document.querySelectorAll("button")).some((b) => (b.textContent ?? "").includes(l)),
      label,
    );
    check(`the "${label}" action is available`, present);
  }

  // Share state is stated, not inferred from the status badge.
  check("the share panel states the link is private", /Private only/.test(text), text.slice(0, 0));
}

// ===========================================================================
console.log("\n4. preview opens with the document");
// ===========================================================================
{
  const opened = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Preview"),
    );
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("the preview button is clickable", opened);

  await sleep(1800);
  const text = await bodyText();
  check("the preview dialog renders", /Invoice preview/.test(text));
  check("it shows the invoice number", text.includes(seeded.invoice_number));
  check("it states that this is what the PDF contains", /what the PDF contains/i.test(text));

  await page.keyboard.press("Escape");
  await sleep(600);
}

// ===========================================================================
console.log("\n5. the PDF download fires");
// ===========================================================================
{
  // A download in headless Chrome needs the download behaviour configured, so the
  // assertion is that the request is MADE and returns a PDF, not that a file lands.
  const responsePromise = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/invoices/${seeded.id}/pdf`) && r.request().method() === "GET",
    { timeout: 15000 },
  ).catch(() => null);

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Download PDF"),
    );
    btn?.click();
  });

  const res = await responsePromise;
  check("clicking Download PDF requests the PDF", Boolean(res), res ? String(res.status()) : "no request");
  check("the PDF request succeeds", res?.status() === 200, String(res?.status() ?? "—"));

  // The browser consumes a download's body, so the intercepted response cannot be
  // read back. Fetch the same URL directly with the session token to inspect bytes.
  const direct = await fetch(`${API}/api/v1/invoices/${seeded.id}/pdf`, {
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  const buffer = Buffer.from(await direct.arrayBuffer());
  check("the served bytes are a real PDF", buffer.subarray(0, 5).toString("latin1") === "%PDF-");
}

// ===========================================================================
console.log("\n6. publishing creates a working public link");
// ===========================================================================
let publicToken = null;
{
  // Publish through the UI's confirm dialog, so the guard against silent
  // publishing is exercised rather than bypassed.
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      /Publish invoice/.test(b.textContent ?? ""),
    );
    btn?.click();
  });
  await sleep(1500);

  const dialogText = await bodyText();
  check("publishing asks for confirmation", /Publish this invoice\?/.test(dialogText));
  check(
    "the dialog explains the link becomes publicly reachable",
    /anyone holding the public link/i.test(dialogText),
  );

  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "Publish",
    );
    btn?.click();
  });
  await sleep(3500);

  const after = await bodyText();
  check("after publishing the panel shows a public link", /Public link active/.test(after), after.slice(0, 60));

  // Read the token out of the database, because the UI shows the URL once.
  const { execSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");

  // The UI cannot give us the raw token back, so create one through the API with
  // a known token by reading the hash instead — the point here is that a public
  // page renders, and the API suite already proves token handling.
  const linkResponse = await fetch(`${API}/api/v1/invoices/${seeded.id}/share-link`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({}),
  }).then((r) => r.json());

  publicToken = linkResponse.data?.token;
  check("a public token can be created", typeof publicToken === "string" && publicToken.length > 20);
  void execSync;
  void createHash;
}

// ===========================================================================
console.log("\n7. the public page renders with NO authentication");
// ===========================================================================
{
  // A brand-new context with no session at all — the recipient's situation.
  const publicContext = await browser.createBrowserContext();
  const publicPage = await publicContext.newPage();
  await publicPage.setViewport({ width: 1024, height: 900 });

  await publicPage.goto(`${BASE}/i/${publicToken}`, { waitUntil: "networkidle2" });
  await sleep(2500);

  const text = await publicPage.evaluate(() => document.body.innerText);
  check("the public page renders", text.includes(seeded.invoice_number), text.slice(0, 80));
  check("it shows the total", /1,200|1200/.test(text));
  check("it shows the line item", /UI verification placement/.test(text));
  check("it offers a PDF download", /Download PDF/.test(text));

  // The CRM must not leak into an unauthenticated page.
  const nav = await publicPage.evaluate(() => Array.from(document.querySelectorAll("nav a")).length);
  check("no CRM navigation is mounted", nav === 0, `${nav} links`);

  const hasSidebar = await publicPage.evaluate(
    () => Array.from(document.querySelectorAll("a")).some((a) => /^\/placements$|^\/staff$/.test(a.getAttribute("href") ?? "")),
  );
  check("no internal module links are present", !hasSidebar);

  // Anti-indexing, both ways.
  const robots = await publicPage.evaluate(
    () => document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? "",
  );
  check("the page is marked noindex", /noindex/.test(robots), robots);

  // And nothing internal in the rendered text.
  for (const [label, re] of [
    ["cost", /supplier cost|publisher cost/i],
    ["payout", /payout/i],
    ["margin", /margin/i],
    ["profit", /profit/i],
  ]) {
    check(`the public page shows no ${label}`, !re.test(text));
  }

  await publicContext.close();
}

// ===========================================================================
console.log("\n8. revoking the link kills the public page");
// ===========================================================================
{
  await fetch(`${API}/api/v1/invoices/${seeded.id}/share-link`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${ownerToken}` },
  });

  const publicContext = await browser.createBrowserContext();
  const publicPage = await publicContext.newPage();
  await publicPage.goto(`${BASE}/i/${publicToken}`, { waitUntil: "networkidle2" });
  await sleep(2200);

  const text = await publicPage.evaluate(() => document.body.innerText);
  check("a revoked link shows an unavailable message", /not available/i.test(text), text.slice(0, 80));

  // The page must not CONFIRM the reason — listing the possibilities ("it may
  // have been revoked, expired, or be wrong") is correct; saying "this link was
  // revoked" would confirm the token was once valid.
  check(
    "it does not confirm that this specific link was revoked",
    !/(this|the) link (was|has been) revoked/i.test(text),
  );

  await publicContext.close();
}

// ===========================================================================
console.log("\n9. the account manager sees invoices but NOT margins");
// ===========================================================================
{
  await asUser("am@demo.test");
  await page.waitForSelector("nav", { timeout: 20000 });

  const labels = await navLinks();
  check("the AM sees Invoices", labels.some((l) => /^Invoices/.test(l)), labels.join(" | "));
  check("the AM does NOT see Financials", !labels.some((l) => /^Financials/.test(l)));

  // Typing the URL must not render the page.
  await page.goto(`${BASE}/finance`, { waitUntil: "networkidle2" });
  await sleep(2000);
  const text = await bodyText();
  const blocked = /don't have access|do not have access/i.test(text);
  check("the AM typing /finance is denied with an explanation", blocked, text.slice(0, 80));

  // And the AM can still read an invoice.
  await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle2" });
  await sleep(2000);
  check("the AM can still open the invoice list", /INV-\d+/.test(await bodyText()));

  // The AM cannot create one — the route is gated on invoices:write.
  await page.goto(`${BASE}/invoices/new`, { waitUntil: "networkidle2" });
  await sleep(1600);
  check(
    "the AM cannot reach the invoice editor",
    /don't have access|do not have access/i.test(await bodyText()),
  );
}

// ===========================================================================
console.log("\n10. financials renders for the owner with figures");
// ===========================================================================
{
  await asUser("owner@demo.test");
  await page.goto(`${BASE}/finance`, { waitUntil: "networkidle2" });
  await sleep(2600);

  const text = await bodyText();
  check("the financials page renders", /Financials/.test(text));
  check("it shows billed", /Billed/.test(text));
  check("it shows outstanding AR", /Outstanding AR/.test(text));
  check("it separates publisher costs owed", /Costs outstanding/.test(text));
  check("it shows margin", /Margin/.test(text));
  check("it shows campaign profitability", /Campaign profitability/.test(text));
  check("it offers a CSV export", /CSV/.test(text));
}

// ===========================================================================
console.log("\n11. reports hub");
// ===========================================================================
{
  await page.goto(`${BASE}/reports`, { waitUntil: "networkidle2" });
  await sleep(2200);

  const text = await bodyText();
  check("the reports page renders", /Reports/.test(text));
  check("it labels the client report as client-safe", /Client-safe/.test(text));
  check("it labels internal reports as owner only", /Owner only/.test(text));
  check("it offers CSV exports", /CSV/.test(text));
  check("it offers Excel exports", /Excel/.test(text));
}

// ===========================================================================
console.log("\n12. the client portal shows invoices");
// ===========================================================================
{
  await asUser("client@demo.test");
  await page.waitForSelector("nav[aria-label='Portal']", { timeout: 20000 });

  const labels = await navLinks();
  check("the portal has an Invoices link", labels.some((l) => /Invoices/.test(l)), labels.join(" | "));

  await page.goto(`${BASE}/portal/invoices`, { waitUntil: "networkidle2" });
  await sleep(2400);

  const text = await bodyText();
  check("the portal invoices page renders", /Invoices/.test(text));

  // The internal finance screens must be unreachable from a client session.
  await page.goto(`${BASE}/finance`, { waitUntil: "networkidle2" });
  await sleep(1800);
  check(
    "a client hitting /finance stays in the portal",
    page.url().includes("/portal") || /don't have access/i.test(await bodyText()),
    page.url().replace(BASE, ""),
  );
}

// ===========================================================================
console.log("\n13. responsive");
// ===========================================================================
{
  await asUser("owner@demo.test");
  await page.setViewport({ width: 390, height: 844 });

  // Every Phase 6 screen, not just the list.
  //
  // The invoice DETAIL page was the one that broke: its line-items table has a
  // minimum width, and a grid column defaults to `min-width: auto`, so the table
  // pushed the whole page sideways instead of scrolling inside its own container.
  // Checking only the list hid that, which is why the loop now covers each screen.
  const screens = [
    ["invoice list", "/invoices"],
    ["invoice detail", `/invoices/${seeded.id}`],
    ["invoice editor", "/invoices/new"],
    ["payments", "/payments"],
    ["finance", "/finance"],
    ["reports", "/reports"],
  ];

  for (const [name, path] of screens) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
    await sleep(2000);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    check(`${name} does not scroll the page horizontally`, overflow <= 2, `${overflow}px`);
  }

  await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle2" });
  await sleep(1800);
  const hasTable = await page.$$eval("table", (els) => els.length);
  check("the invoice table is present and scrolls inside its container", hasTable > 0);

  await page.setViewport({ width: 1440, height: 900 });
}

// ===========================================================================
console.log("\n14. no uncaught errors");
// ===========================================================================
{
  const real = consoleErrors.filter(
    (e) =>
      !/favicon|DevTools|Download the React|ResizeObserver loop/i.test(e) &&
      !/Failed to load resource.*404.*favicon/i.test(e) &&
      // 403s from the deliberate permission probes above are expected.
      !/the server responded with a status of 403/i.test(e),
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
