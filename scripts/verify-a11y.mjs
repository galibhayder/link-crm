/**
 * Accessibility and keyboard verification.
 *
 * Phase 1 claims keyboard reachability, visible focus, and correct labelling.
 * These are easy to assert in prose and easy to break in practice, so they get
 * checked mechanically.
 */

import puppeteer from "puppeteer";

const BASE = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.SHOT_DIR ?? "./shots";

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const context = await browser.createBrowserContext();
const page = await context.newPage();
await page.setViewport({ width: 1440, height: 900 });

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

// ---------------------------------------------------------------- login page
console.log("\nlogin page accessibility");
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector("#email");

const labels = await page.evaluate(() => ({
  email: Boolean(document.querySelector('label[for="email"]')),
  password: Boolean(document.querySelector('label[for="password"]')),
}));
check("email input is labelled", labels.email);
check("password input is labelled", labels.password);

await page.focus("#email");
await page.keyboard.press("Tab");
const afterTab = await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName);
check("Tab moves from email to password", afterTab === "password", `focused: ${afterTab}`);

const focusStyle = await page.evaluate(() => {
  const el = document.querySelector("#email");
  el.focus();
  const s = getComputedStyle(el);
  return { outlineStyle: s.outlineStyle, boxShadow: s.boxShadow };
});
check(
  "focused input shows a focus indicator",
  focusStyle.outlineStyle !== "none" || focusStyle.boxShadow !== "none",
  JSON.stringify(focusStyle),
);

await page.click('button[type="submit"]');
await new Promise((r) => setTimeout(r, 400));
const alertText = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent?.trim() ?? null);
check("validation error announced via role=alert", alertText !== null, alertText ?? "");

// ------------------------------------------------------------------ app shell
console.log("\napp shell accessibility");
await page.type("#email", "owner@demo.test");
await page.type("#password", "password123");
await Promise.all([
  page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => null),
  page.click('button[type="submit"]'),
]);
await page.waitForFunction(() => !window.location.pathname.includes("/login"), { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));

const landmarks = await page.evaluate(() => ({
  header: Boolean(document.querySelector("header")),
  main: Boolean(document.querySelector("main")),
  asideLabel: document.querySelector("aside")?.getAttribute("aria-label") ?? null,
  navLabels: Array.from(document.querySelectorAll("nav[aria-label]")).map((n) => n.getAttribute("aria-label")),
  navCount: document.querySelectorAll("aside nav").length,
  h1Count: document.querySelectorAll("h1").length,
  activeNav: document.querySelector('aside nav a[aria-current="page"]')?.textContent?.trim() ?? null,
  unlabelledButtons: Array.from(document.querySelectorAll("button")).filter(
    (b) => ((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()).length === 0,
  ).length,
}));

check("header landmark present", landmarks.header);
check("main landmark present", landmarks.main);
check("sidebar has an aria-label", Boolean(landmarks.asideLabel), landmarks.asideLabel ?? "");
check(
  "every nav region has a distinct aria-label",
  landmarks.navLabels.length > 0 && new Set(landmarks.navLabels).size === landmarks.navLabels.length,
  landmarks.navLabels.join(", "),
);
check("exactly one h1 per page", landmarks.h1Count === 1, `found ${landmarks.h1Count}`);
check("current page marked with aria-current", landmarks.activeNav !== null, landmarks.activeNav ?? "");
check("every button has an accessible name", landmarks.unlabelledButtons === 0, `${landmarks.unlabelledButtons} unlabelled`);

const themeBtn = await page.$('button[aria-label^="Theme"]');
check("theme control has a descriptive label", Boolean(themeBtn));

// ------------------------------------------------------- collapsed rail a11y
console.log("\ncollapsed rail");
const collapseBtn = await page.$('button[aria-label="Collapse sidebar"]');
check("collapse control is labelled", Boolean(collapseBtn));

if (collapseBtn) {
  await collapseBtn.click();
  await new Promise((r) => setTimeout(r, 500));

  const rail = await page.evaluate(() => ({
    asideCount: document.querySelectorAll("aside").length,
    activeFound: Boolean(document.querySelector('aside nav a[aria-current="page"]')),
  }));
  check("only one sidebar in the DOM", rail.asideCount === 1, `${rail.asideCount} found`);
  check("active nav item still marked in the rail", rail.activeFound);

  const expandBtn = await page.$('button[aria-label="Expand sidebar"]');
  if (expandBtn) await expandBtn.click();
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * Focus indicator on nav links.
 *
 * Must be measured with REAL keyboard focus, not `element.focus()`: the styles
 * use `:focus-visible`, which the browser deliberately does not apply to
 * programmatic focus. Asserting with .focus() reports a false failure.
 */
const navFocus = await (async () => {
  await page.evaluate(() => document.querySelector("aside nav a")?.blur());
  const seen = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el.tagName !== "A" || !el.closest("aside")) return null;
      const s = getComputedStyle(el);
      return { text: (el.textContent ?? "").trim().slice(0, 20), outlineStyle: s.outlineStyle, width: s.outlineWidth };
    });
    if (info) seen.push(info);
  }
  return seen;
})();

check(
  "sidebar links reachable by keyboard",
  navFocus.length > 0,
  `${navFocus.length} links focused`,
);
check(
  "every focused nav link shows an outline",
  navFocus.length > 0 && navFocus.every((s) => s.outlineStyle !== "none"),
  navFocus.filter((s) => s.outlineStyle === "none").slice(0, 3).map((s) => s.text).join(", "),
);

await page.screenshot({ path: `${OUT}/14-a11y-shell.png` });

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
await browser.close();
if (failed > 0) process.exit(1);
