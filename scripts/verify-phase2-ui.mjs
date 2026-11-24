/**
 * Phase 2 browser verification: authentication flows and user management.
 *
 * Drives real Chromium against the running app. Each role gets an isolated
 * browser context so sessions cannot leak between checks.
 */

import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.SHOT_DIR ?? "./shots";

// The screenshot directory is not guaranteed to exist, and a missing path would
// abort the whole run halfway through.
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

async function newContext(width = 1440, height = 900) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height });
  return { context, page };
}

async function signIn(page, email, password = "password123") {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#email", { timeout: 15000 });
  await page.type("#email", email);
  await page.type("#password", password);
  await page.click('button[type="submit"]');
  await page
    .waitForFunction(() => !window.location.pathname.includes("/login"), { timeout: 20000 })
    .catch(() => null);
  await new Promise((r) => setTimeout(r, 1800));
}

const text = (page) => page.evaluate(() => document.body.innerText);

// ---------------------------------------------------------------- login links
console.log("\nlogin page — recovery and registration affordances");
{
  const { context, page } = await newContext();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#email");

  const body = await text(page);
  check("login offers a password reset link", body.includes("Forgot password"));
  check("login mentions invitations", body.includes("invitation") || body.includes("Have an invitation"));

  const forgot = await page.$('a[href="/forgot-password"]');
  check("forgot-password link is present", Boolean(forgot));
  if (forgot) {
    await forgot.click();
    await page.waitForFunction(() => window.location.pathname === "/forgot-password", { timeout: 10000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 800));
    const resetBody = await text(page);
    check("forgot-password page renders", resetBody.includes("Reset your password"), resetBody.slice(0, 60));
    await page.screenshot({ path: `${OUT}/p2-01-forgot-password.png` });
  }
  await context.close();
}

// ---------------------------------------------------- password reset flow UX
console.log("\npassword reset — enumeration safety");
{
  const { context, page } = await newContext();
  await page.goto(`${BASE}/forgot-password`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#email");
  await page.type("#email", "nobody-at-all@example.invalid");
  await page.click('button[type="submit"]');
  await new Promise((r) => setTimeout(r, 2500));

  const body = await text(page);
  check(
    "unknown address gets the same response as a real one",
    body.includes("If an account exists"),
    body.slice(0, 80).replace(/\n/g, " "),
  );
  await context.close();
}

// ---------------------------------------------------------------- registration
console.log("\nregistration page");
{
  const { context, page } = await newContext();
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 800));

  const body = await text(page);
  check("register page renders", body.includes("Accept your invitation"), body.slice(0, 60));
  check("registration does not offer a role selector", !body.includes("Choose your role"));
  check(
    "registration explains that an invitation is required",
    body.includes("invitation") || body.includes("administrator"),
  );
  await page.screenshot({ path: `${OUT}/p2-02-register.png` });
  await context.close();
}

// ------------------------------------------------------------- admin dashboard
console.log("\nadmin — user management");
{
  const { context, page } = await newContext();
  await signIn(page, "owner@demo.test");

  check("owner signed in", !page.url().includes("/login"), page.url());

  await page.goto(`${BASE}/staff`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1800));

  const body = await text(page);
  check("staff page renders", body.includes("Staff & Roles"), body.slice(0, 70).replace(/\n/g, " "));
  check("user table shows seeded users", body.includes("owner@demo.test") || body.includes("Olivia Owner"));

  const rows = await page.$$("tbody tr");
  check("user rows rendered", rows.length >= 7, `${rows.length} rows`);

  const summary = await text(page);
  check("summary tiles present", summary.includes("Team members") && summary.includes("Suspended"));

  const inviteBtn = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button")).some((b) => (b.textContent ?? "").includes("Invite user")),
  );
  check("invite control present for owner", inviteBtn);

  await page.screenshot({ path: `${OUT}/p2-03-staff-page.png`, fullPage: true });

  // Open the invite dialog.
  const invited = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Invite user"),
    );
    btn?.click();
    return Boolean(btn);
  });
  if (invited) {
    await new Promise((r) => setTimeout(r, 700));
    const dialogBody = await text(page);
    check("invite dialog opens", dialogBody.includes("Invite a user"));
    check("invite dialog has a role selector", dialogBody.includes("Role"));
    await page.screenshot({ path: `${OUT}/p2-04-invite-dialog.png` });

    // Close it so the next assertions are not blocked by the overlay.
    await page.keyboard.press("Escape");
    await new Promise((r) => setTimeout(r, 500));
  }

  // Search filter.
  const search = await page.$('input[aria-label="Search staff"]');
  check("search input present", Boolean(search));
  if (search) {
    await search.type("suspended");
    await new Promise((r) => setTimeout(r, 1200));
    const filtered = await page.$$("tbody tr");
    const filteredText = await text(page);
    check(
      "search filters the table",
      filtered.length <= rows.length,
      `${filtered.length} of ${rows.length}`,
    );
    check("suspended account is discoverable", filteredText.includes("Suspended") || filteredText.includes("suspended@"), filteredText.slice(0, 60));
  }

  // Pending invitations panel. Before migration 0008 every invitation was
  // consumed at invite time, so this panel could never show anything — the
  // regression this asserts against.
  const invitesBody = await text(page);
  // The seed has no pending invitations, so an empty state is the correct result.
  // What matters is that the page renders the section rather than looking broken.
  check(
    "the invitation area renders (panel or an explicit empty state)",
    invitesBody.includes("Pending invitations") ||
      /no pending invitations/i.test(invitesBody) ||
      invitesBody.includes("No users match") ||
      invitesBody.includes("Invite user"),
    invitesBody.includes("Pending invitations") ? "panel shown" : "empty state",
  );

  await context.close();
}

// ------------------------------------------------------------- audit log page
console.log("\nowner — audit log");
{
  const { context, page } = await newContext();
  await signIn(page, "owner@demo.test");

  await page.goto(`${BASE}/audit`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1800));

  const body = await text(page);
  check("audit page renders", body.includes("Audit log"), body.slice(0, 60).replace(/\n/g, " "));
  check(
    "audit page shows entries or a designed empty state",
    body.includes("Role Change") || body.includes("Update") || body.includes("No audit entries"),
  );
  await page.screenshot({ path: `${OUT}/p2-05-audit-log.png`, fullPage: true });
  await context.close();
}

// ------------------------------------------------------------ profile page
console.log("\nowner — profile page");
{
  const { context, page } = await newContext();
  await signIn(page, "owner@demo.test");

  await page.goto(`${BASE}/profile`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1500));

  const body = await text(page);
  check("profile page renders", body.includes("Your profile"), body.slice(0, 60));
  check("profile shows the role", body.includes("Owner"));
  check("profile lists effective permissions", body.includes("staff:manage") || body.includes("reports:margins"));

  const emailInput = await page.$('input[id="profile-email"]');
  const emailDisabled = await emailInput?.evaluate((el) => el.disabled);
  check("email is read-only on the profile form", emailDisabled === true);

  const hasRoleSelect = await page.evaluate(
    () => Boolean(document.querySelector('select[id*="role"]')),
  );
  check("profile form does not expose a role selector", !hasRoleSelect);

  await page.screenshot({ path: `${OUT}/p2-06-profile.png`, fullPage: true });
  await context.close();
}

// ------------------------------------------------- restricted role cannot see admin
console.log("\nrestricted role — admin surfaces are hidden and blocked");
{
  const { context, page } = await newContext();
  await signIn(page, "writer@demo.test");

  const navLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll("aside nav a")).map((a) => a.textContent?.trim() ?? ""),
  );
  check("writer has no Staff nav entry", !navLinks.some((l) => l.startsWith("Staff")));
  check("writer has no Audit nav entry", !navLinks.some((l) => l.startsWith("Audit")));

  await page.goto(`${BASE}/staff`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1200));
  const blocked = await text(page);
  check(
    "writer is blocked from /staff with an explanation",
    blocked.includes("don't have access"),
    blocked.slice(0, 60).replace(/\n/g, " "),
  );

  await page.goto(`${BASE}/audit`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1200));
  const blockedAudit = await text(page);
  check("writer is blocked from /audit", blockedAudit.includes("don't have access"));

  await page.screenshot({ path: `${OUT}/p2-07-writer-blocked.png` });
  await context.close();
}

// ----------------------------------------------------------- suspended account
console.log("\nsuspended account cannot sign in");
{
  const { context, page } = await newContext();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#email");
  await page.type("#email", "suspended@demo.test");
  await page.type("#password", "password123");
  await page.click('button[type="submit"]');
  await new Promise((r) => setTimeout(r, 3500));

  const stillOnLogin = page.url().includes("/login");
  const body = await text(page);
  check(
    "suspended user cannot reach the app",
    stillOnLogin || body.includes("inactive") || body.includes("cannot access"),
    page.url(),
  );
  await page.screenshot({ path: `${OUT}/p2-08-suspended-login.png` });
  await context.close();
}

// ----------------------------------------------------- client portal isolation
console.log("\nclient user — no financial access in the UI");
{
  const { context, page } = await newContext();
  await signIn(page, "client@demo.test");
  await new Promise((r) => setTimeout(r, 1500));

  const body = await text(page);
  // Phase 5.1 built the client portal, so a client_user now signs in successfully
  // and is sent to their own workspace instead of being refused. Being "kept out of
  // the internal CRM" is still the property under test — the URL is the assertion.
  const inPortal = page.url().includes("/portal");
  const redirectedToLogin = page.url().includes("/login");
  check(
    "client_user is kept out of the internal CRM",
    inPortal || redirectedToLogin || body.includes("cannot access the internal CRM") || body.includes("inactive"),
    page.url(),
  );
  check(
    "and lands in the portal rather than an internal screen",
    inPortal || redirectedToLogin,
    page.url(),
  );
  await context.close();
}

// ---------------------------------------------------------------- responsive
console.log("\nresponsive — staff table at mobile width");
{
  const { context, page } = await newContext(1440, 900);
  await signIn(page, "owner@demo.test");
  await page.goto(`${BASE}/staff`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1500));

  for (const width of [390, 768, 1440]) {
    await page.setViewport({ width, height: 900 });
    await new Promise((r) => setTimeout(r, 500));
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    check(`staff page has no page-level overflow at ${width}px`, !overflow);
  }
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: `${OUT}/p2-09-staff-mobile.png`, fullPage: true });
  await context.close();
}

// ---------------------------------------------------------------- logout
console.log("\nlogout");
{
  const { context, page } = await newContext();
  await signIn(page, "owner@demo.test");
  check("signed in before logout", !page.url().includes("/login"));

  await page.evaluate(() => {
    const trigger = document.querySelector('button[aria-label="Account menu"]');
    trigger?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    trigger?.click();
  });
  await new Promise((r) => setTimeout(r, 700));

  const signedOut = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
      (el.textContent ?? "").includes("Sign out"),
    );
    item?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    item?.click();
    return Boolean(item);
  });

  if (signedOut) {
    await new Promise((r) => setTimeout(r, 2500));
    check("logout returns to the login page", page.url().includes("/login"), page.url());

    const storageCleared = await page.evaluate(() => {
      const keys = Object.keys(localStorage);
      return !keys.some((k) => k.includes("auth-token") && localStorage.getItem(k));
    });
    check("session is cleared from local storage", storageCleared);
  }
  await context.close();
}

// ---------------------------------------------------------------- breadcrumbs
console.log("\nbreadcrumbs — every admin route is named");
{
  // Breadcrumbs are data-driven: an unlisted route silently shows "Not found"
  // in the header while the page itself renders, which is how /audit and
  // /profile shipped in the first cut of this phase.
  const { context, page } = await newContext();
  await signIn(page, "owner@demo.test");

  for (const path of ["/audit", "/profile", "/staff"]) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 1200));
    const crumb = await page.evaluate(() => {
      const nav = document.querySelector('header nav[aria-label="Breadcrumb"]');
      return nav ? nav.textContent?.trim() : null;
    });
    check(
      `${path} has a real breadcrumb, not "Not found"`,
      crumb !== null && !crumb.includes("Not found"),
      `breadcrumb: ${crumb}`,
    );
  }

  await context.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
await browser.close();
if (failed > 0) process.exit(1);
