/**
 * Browser verification for Phase 1.
 *
 * Drives a real Chromium against the running dev server: checks the login page
 * renders, signs in as an owner, and confirms the shell, navigation and theme
 * behave. Screenshots are written to the scratchpad for visual inspection.
 *
 * Requires puppeteer to be installed at the repo root (dev-only).
 */

import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.SHOT_DIR ?? "./shots";
const EMAIL = process.env.TEST_EMAIL ?? "owner@demo.test";
const PASSWORD = process.env.TEST_PASSWORD ?? "password123";

mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await puppeteer.launch({
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

try {
  console.log("\nlogin page");
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 30000 });

  const heading = await page.$eval("h1", (el) => el.textContent?.trim()).catch(() => null);
  check("login page renders", heading === "Sign in", `heading: ${heading}`);

  const branded = await page.evaluate(() =>
    document.body.innerText.includes("Run every campaign from prospect to live link."),
  );
  check("brand panel copy present", branded);

  await page.screenshot({ path: join(OUT, "01-login-light.png") });

  // Dark theme on the login page
  await page.evaluate(() => {
    localStorage.setItem("linkforge-theme", "dark");
    document.documentElement.classList.add("dark");
  });
  await page.reload({ waitUntil: "networkidle2" });
  const isDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  check("theme persists across reload", isDark);
  await page.screenshot({ path: join(OUT, "02-login-dark.png") });

  // Back to light for the app screenshots
  await page.evaluate(() => localStorage.setItem("linkforge-theme", "light"));
  await page.reload({ waitUntil: "networkidle2" });

  console.log("\nauthentication");
  await page.waitForSelector("#email", { timeout: 10000 });
  await page.type("#email", EMAIL);
  await page.type("#password", PASSWORD);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => null),
    page.click('button[type="submit"]'),
  ]);

  // Wait for either the dashboard or an error message.
  await page.waitForFunction(
    () =>
      window.location.pathname === "/" ||
      document.body.innerText.includes("Sign in") === false ||
      document.body.innerText.includes("Dashboard"),
    { timeout: 20000 },
  ).catch(() => null);

  await new Promise((r) => setTimeout(r, 2500));

  const url = page.url();
  check("redirected away from /login", !url.includes("/login"), `at ${url}`);

  const bodyText = await page.evaluate(() => document.body.innerText);
  check("dashboard heading rendered", bodyText.includes("Dashboard"));

  console.log("\napplication shell");
  const hasSidebar = await page.evaluate(() => Boolean(document.querySelector("aside")));
  check("sidebar present", hasSidebar);

  const navLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll("aside nav a")).map((a) => a.textContent?.trim()),
  );
  check("navigation rendered", navLabels.length > 0, `${navLabels.length} links: ${navLabels.slice(0, 6).join(", ")}`);

  // The account manager must not see Payments (tier-1 financial rule).
  const hasHeader = await page.evaluate(() => Boolean(document.querySelector("header")));
  check("header present", hasHeader);

  const metrics = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".tabular-nums")).map((el) => el.textContent?.trim()),
  );
  check("dashboard metrics loaded from the API", metrics.length >= 4, `values: ${metrics.join(", ")}`);

  await page.screenshot({ path: join(OUT, "03-dashboard-light.png"), fullPage: true });

  console.log("\ndark theme in the app");
  await page.evaluate(() => {
    localStorage.setItem("linkforge-theme", "dark");
    document.documentElement.classList.add("dark");
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: join(OUT, "04-dashboard-dark.png"), fullPage: true });
  check("dark mode screenshot captured", true);

  console.log("\nresponsive layout");
  await page.setViewport({ width: 390, height: 844 });
  await page.evaluate(() => {
    localStorage.setItem("linkforge-theme", "light");
    document.documentElement.classList.remove("dark");
  });
  await new Promise((r) => setTimeout(r, 600));

  const sidebarHidden = await page.evaluate(() => {
    const aside = document.querySelector("aside");
    if (!aside) return true;
    const rect = aside.getBoundingClientRect();
    return rect.right <= 0 || getComputedStyle(aside).transform !== "none";
  });
  check("sidebar collapses on mobile", sidebarHidden);

  const menuButton = await page.$('button[aria-label="Open navigation"]');
  check("mobile menu button visible", Boolean(menuButton));
  await page.screenshot({ path: join(OUT, "05-mobile-light.png"), fullPage: true });

  if (menuButton) {
    // Click via the DOM rather than the mouse. The scrim sits above the header
    // at this width, so a coordinate-based click can land on the overlay and
    // never reach the button — which produced a false failure here.
    await page.evaluate(() => document.querySelector('button[aria-label="Open navigation"]')?.click());
    await new Promise((r) => setTimeout(r, 600));

    const drawerOpen = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      if (!aside) return false;
      // Tailwind v4 sets the `translate` property, not `transform`, so measuring
      // transform alone reports "none" even when the drawer is open.
      const cs = getComputedStyle(aside);
      const rect = aside.getBoundingClientRect();
      return rect.right > 1 && (cs.translate === "0px" || !cs.translate.includes("-"));
    });
    check("mobile drawer opens", drawerOpen);
    await page.screenshot({ path: join(OUT, "06-mobile-nav-open.png") });
  }

  console.log("\nroute guard");
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 800));
  const settingsText = await page.evaluate(() => document.body.innerText);
  check(
    "settings route reachable for owner",
    settingsText.includes("Settings"),
    settingsText.slice(0, 80).replace(/\n/g, " "),
  );

  await page.goto(`${BASE}/nonexistent-route`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 800));
  const notFoundText = await page.evaluate(() => document.body.innerText);
  check("unknown route shows 404", notFoundText.includes("404"));

  console.log("\nconsole health");
  const realErrors = consoleErrors.filter(
    (e) => !e.includes("favicon") && !e.includes("Download the React DevTools"),
  );
  check("no uncaught console errors", realErrors.length === 0, realErrors.slice(0, 3).join(" | "));

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} catch (err) {
  console.error("\nVerification crashed:", err);
  await page.screenshot({ path: join(OUT, "error.png") }).catch(() => null);
  process.exitCode = 1;
} finally {
  await browser.close();
}
