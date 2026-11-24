/**
 * PHASE 7 — ADMIN UI.
 *
 * The requirement is explicit: a customization change must persist after a refresh
 * AND after signing out and back in. This drives the real browser to prove it,
 * rather than trusting the API tests alone — a change that is stored but not
 * re-read on boot fails the user's actual experience.
 */
import puppeteer from "puppeteer";

const BASE = "http://localhost:5173";
const API = "http://127.0.0.1:3000";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d: String(d) });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const ownerToken = await fetch("http://127.0.0.1:54321/auth/v1/token?grant_type=password", {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@demo.test", password: "password123" }),
})
  .then((r) => r.json())
  .then((b) => b.access_token);

const reset = () =>
  fetch(`${API}/api/v1/admin/ui/config/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ section: "all" }),
  });

await reset();

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let context = await browser.createBrowserContext();
let page = await context.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleErrors = [];
const attach = (p) => {
  p.on("pageerror", (e) => consoleErrors.push(String(e.message)));
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
  await sleep(2200);
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
const navLabels = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("nav a")).map((a) => (a.textContent ?? "").trim()),
  );

// ===========================================================================
console.log("\n1. the Trivero brand appears in the sidebar");
// ===========================================================================
{
  await asUser("owner@demo.test");
  await page.waitForSelector("nav", { timeout: 20000 });

  const text = await bodyText();
  check("the sidebar shows Trivero Marketing", /Trivero Marketing/.test(text));

  const logo = await page.evaluate(() => {
    const img = document.querySelector("aside img");
    if (!img) return null;
    return { src: img.getAttribute("src")?.slice(0, 30), w: img.naturalWidth };
  });
  check("the sidebar renders the uploaded logo", Boolean(logo), logo ? logo.src : "no img");
  // A naturalWidth > 0 proves the image actually decoded, not just that an <img>
  // tag exists with a broken source.
  check("the logo image decoded successfully", (logo?.w ?? 0) > 0, `naturalWidth ${logo?.w}`);

  const title = await page.title();
  check("the document title uses the brand name", /Trivero Marketing/.test(title), title);
}

// ===========================================================================
console.log("\n2. only the owner sees Admin in the nav");
// ===========================================================================
{
  const labels = await navLabels();
  check("the owner sees the Admin item", labels.some((l) => /^Admin/.test(l)), labels.join(" | "));

  await asUser("am@demo.test");
  const amLabels = await navLabels();
  check("the account manager does NOT see Admin", !amLabels.some((l) => /^Admin/.test(l)));

  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2" });
  await sleep(1800);
  check(
    "the AM typing /admin is denied with an explanation",
    /don't have access|do not have access/i.test(await bodyText()),
  );
}

// ===========================================================================
console.log("\n3. the Admin page renders its sections");
// ===========================================================================
{
  await asUser("owner@demo.test");
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2" });
  await sleep(2600);

  const text = await bodyText();
  check("the Admin page renders", /Admin/.test(text));
  for (const tab of ["Navigation", "Modules", "Columns", "Dashboard", "Theme", "Branding", "Roles"]) {
    check(`the ${tab} tab is present`, new RegExp(tab, "i").test(text));
  }
  check("it explains that customization cannot widen access", /never what they are permitted to do/i.test(text));
}

// ===========================================================================
console.log("\n4. renaming a nav item persists after RELOAD");
// ===========================================================================
{
  // Rename "Placements" to "Campaign Links" through the API, then confirm the
  // sidebar shows it — this proves the client reads the config, not just stores it.
  await fetch(`${API}/api/v1/admin/ui/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ config: { navigation: { items: [{ to: "/placements", label: "Campaign Links" }] } } }),
  });

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2600);

  const afterReload = await navLabels();
  check("the renamed label appears after a reload", afterReload.some((l) => /Campaign Links/.test(l)), afterReload.join(" | "));
  check("the original label is gone", !afterReload.some((l) => /^Placements$/.test(l)));
}

// ===========================================================================
console.log("\n5. ...and after signing out and back in");
// ===========================================================================
{
  // A brand-new browser context is exactly what a fresh sign-in is: no query
  // cache, no in-memory state, a new session token.
  await asUser("owner@demo.test");
  await page.waitForSelector("nav", { timeout: 20000 });

  const afterLogin = await navLabels();
  check("the renamed label survives a full re-login", afterLogin.some((l) => /Campaign Links/.test(l)), afterLogin.join(" | "));
}

// ===========================================================================
console.log("\n6. hiding a module removes it from the nav");
// ===========================================================================
{
  await fetch(`${API}/api/v1/admin/ui/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ config: { modules: { "/outreach": false } } }),
  });

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2600);

  const labels = await navLabels();
  check("the disabled module is gone from the nav", !labels.some((l) => /^Outreach/.test(l)), labels.join(" | "));
}

// ===========================================================================
console.log("\n7. a theme colour is applied as a CSS variable");
// ===========================================================================
{
  await fetch(`${API}/api/v1/admin/ui/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ config: { theme: { accent: "#7C3AED" } } }),
  });

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2600);

  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-brand-600").trim(),
  );
  check("the accent overrides --color-brand-600", accent.toLowerCase() === "#7c3aed", accent);

  // And the ramp moves with it, or the UI would be half-recoloured.
  const shade = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-brand-700").trim(),
  );
  check("the derived shade is no longer the default indigo", shade !== "#4338ca" && shade.length > 0, shade);
}

// ===========================================================================
console.log("\n7b. a saved setting ACTUALLY CHANGES the screen");
//
// Regression. The first cut stored dashboard and column preferences and then
// never rendered them: the API round-tripped, the tests passed, and the Admin
// switches did nothing. Round-tripping is not the same as applying, so these
// checks assert the rendered result rather than the stored value.
// ===========================================================================
{
  // --- dashboard widget ------------------------------------------------
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2" });
  await sleep(2400);
  const before = await bodyText();
  check("the dashboard shows the metrics block by default", /Active clients/i.test(before));

  await fetch(`${API}/api/v1/admin/ui/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ config: { dashboard: { hidden: ["metrics"] } } }),
  });

  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2600);
  const after = await bodyText();
  check("hiding the metrics widget removes it from the dashboard", !/Active clients/i.test(after), "block gone");
  check("the other widgets survive", /Getting started|System/i.test(after));

  await reset();

  // --- table columns ---------------------------------------------------
  await fetch(`${API}/api/v1/admin/ui/config`, {
    method: "PUT",
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    body: JSON.stringify({ config: { tables: { "/invoices": { columns: ["invoice_number", "total"] } } } }),
  });

  await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle2" });
  await sleep(2600);

  const headers = await page.evaluate(() =>
    Array.from(document.querySelectorAll("thead th")).map((th) => (th.textContent ?? "").trim()),
  );

  check("the configured columns are rendered", headers.includes("Invoice") && headers.includes("Total"), headers.join(" | "));
  check("an unconfigured column is gone", !headers.includes("Client"), headers.join(" | "));
  check("the column order follows the config", headers.indexOf("Invoice") < headers.indexOf("Total"), headers.join(" | "));

  await reset();
}

// ===========================================================================
console.log("\n8. reset restores the defaults");
// ===========================================================================
{
  await reset();
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(2600);

  const labels = await navLabels();
  check("the original labels are back", labels.some((l) => /^Placements/.test(l)), labels.join(" | "));
  check("the disabled module is back", labels.some((l) => /^Outreach/.test(l)));

  const accent = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--color-brand-600").trim(),
  );
  check("the accent is back to the stylesheet default", accent === "" || accent.toLowerCase() === "#4f46e5", accent);
}

// ===========================================================================
console.log("\n9. responsive");
// ===========================================================================
{
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2" });
  await sleep(2400);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check("the Admin page does not scroll horizontally on a phone", overflow <= 2, `${overflow}px`);

  await page.setViewport({ width: 1440, height: 900 });
}

// ===========================================================================
console.log("\n10. no uncaught errors");
// ===========================================================================
{
  const real = consoleErrors.filter((e) => !/favicon|DevTools|ResizeObserver loop/i.test(e));
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
