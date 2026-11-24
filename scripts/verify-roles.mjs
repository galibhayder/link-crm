/**
 * Role-based navigation verification.
 *
 * Proves the menu is derived from the same permission matrix the API enforces,
 * by signing in as three different roles and inspecting what they can see.
 *
 * Each role gets its own isolated browser context, so a session from one role
 * cannot leak into the next. Sharing one page and clearing localStorage is not
 * enough — Supabase keeps an in-memory session that outlives the clear.
 */

import puppeteer from "puppeteer";

const BASE = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.SHOT_DIR ?? "./shots";

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

/** A fresh, isolated session for one role. */
async function sessionFor(email, shotPrefix) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector("#email", { timeout: 15000 });
  await page.type("#email", email);
  await page.type("#password", "password123");
  await page.click('button[type="submit"]');

  await page.waitForFunction(() => !window.location.pathname.includes("/login"), { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1500));

  const links = await page.evaluate(() =>
    Array.from(document.querySelectorAll("aside nav a")).map((a) => a.textContent?.trim() ?? ""),
  );

  if (shotPrefix) await page.screenshot({ path: `${OUT}/${shotPrefix}.png` });
  return { page, context, links };
}

// ---------------------------------------------------------------- content writer
console.log("\ncontent_writer — restricted role");
{
  const { page, context, links } = await sessionFor("writer@demo.test", "07-writer-nav");

  check("signed in", !page.url().includes("/login"), page.url());
  check("no Payments entry", !links.some((l) => l.startsWith("Payments")));
  check("no Invoices entry", !links.some((l) => l.startsWith("Invoices")));
  check("no Staff & Roles entry", !links.some((l) => l.startsWith("Staff")));
  check("no Settings entry", !links.some((l) => l.startsWith("Settings")));
  check("DOES see Content", links.some((l) => l.startsWith("Content")), links.join(", "));

  // The landing page must actually load for a restricted role. A 403 here is
  // what a too-strict `reports:read` gate on the dashboard endpoint produced.
  const dashText = await page.evaluate(() => document.body.innerText);
  check(
    "dashboard loads without a permission error",
    dashText.includes("Active campaigns") && !dashText.includes("don't have access"),
    dashText.includes("don't have access") ? "blocked by permission gate" : "",
  );
  check(
    "system health resolved (not stuck on 'Checking')",
    !dashText.includes("Checking system"),
  );

  console.log("\ncontent_writer — direct route is blocked");
  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1000));
  const blocked = await page.evaluate(() => document.body.innerText);
  check(
    "explains the denial instead of showing an empty page",
    blocked.includes("don't have access"),
    blocked.includes("don't have access") ? "" : blocked.slice(0, 60).replace(/\n/g, " "),
  );
  await page.screenshot({ path: `${OUT}/08-writer-blocked.png` });
  await context.close();
}

// ------------------------------------------------------------ account manager
console.log("\naccount_manager — tier separation");
{
  const { page, context, links } = await sessionFor("am@demo.test", "09-am-nav");
  check("signed in", !page.url().includes("/login"));
  check("no Payments entry (owner-only financials)", !links.some((l) => l.startsWith("Payments")));
  check("sees Invoices", links.some((l) => l.startsWith("Invoices")));
  check("sees Clients", links.some((l) => l.startsWith("Clients")));
  await context.close();
}

// -------------------------------------------------------------------- owner
console.log("\nowner — full navigation");
{
  const { page, context, links } = await sessionFor("owner@demo.test", "10-owner-nav");
  check("signed in", !page.url().includes("/login"));
  check("sees Payments", links.some((l) => l.startsWith("Payments")));
  check("sees Staff & Roles", links.some((l) => l.startsWith("Staff")));
  check("sees Settings", links.some((l) => l.startsWith("Settings")));
  check("nav populated", links.length >= 10, `${links.length} links`);
  await context.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
await browser.close();
if (failed > 0) process.exit(1);
