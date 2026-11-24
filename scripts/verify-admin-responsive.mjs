/**
 * Responsive + a11y check for the Phase 2 admin screens specifically.
 *
 * The generic responsive suite walks whole pages, but the staff table is a wide
 * element inside a narrow viewport — the case most likely to cause page-level
 * overflow. This checks it directly at every real breakpoint.
 */

import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const BASE = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.SHOT_DIR ?? "./shots";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const context = await browser.createBrowserContext();
const page = await context.newPage();

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.type("#email", "owner@demo.test");
await page.type("#password", "password123");
await page.click('button[type="submit"]');
await page.waitForFunction(() => !window.location.pathname.includes("/login"), { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1800));

const WIDTHS = [320, 390, 640, 768, 1024, 1280, 1440, 1920];

for (const path of ["/staff", "/audit", "/profile"]) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1400));

  console.log(`\n${path} — page-level overflow`);
  for (const width of WIDTHS) {
    await page.setViewport({ width, height: 900 });
    await new Promise((r) => setTimeout(r, 350));
    const over = await page.evaluate(() => {
      const doc = document.documentElement;
      // 1px tolerance for sub-pixel rounding.
      return doc.scrollWidth > window.innerWidth + 1;
    });
    check(`no horizontal scroll at ${width}px`, !over);
  }
}

console.log("\n/staff — table containment");
{
  await page.goto(`${BASE}/staff`, { waitUntil: "networkidle2" });
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 1200));

  const table = await page.evaluate(() => {
    const t = document.querySelector("table");
    if (!t) return null;
    // The table is allowed to be wider than the viewport, but its wrapper must
    // scroll rather than the whole page.
    const wrapper = t.parentElement;
    return {
      tableWidth: t.getBoundingClientRect().width,
      wrapperOverflowX: getComputedStyle(wrapper).overflowX,
      wrapperWidth: wrapper.getBoundingClientRect().width,
    };
  });

  check("table present", table !== null);
  check(
    "table scrolls inside its wrapper, not the page",
    table?.wrapperOverflowX === "auto" || table?.wrapperOverflowX === "scroll",
    `overflowX=${table?.wrapperOverflowX}`,
  );
  check(
    "wrapper is narrower than the table (so it actually scrolls)",
    table !== null && table.wrapperWidth <= table.tableWidth,
    `${table?.wrapperWidth} <= ${table?.tableWidth}`,
  );

  await page.screenshot({ path: `${OUT}/rv-staff-390.png`, fullPage: true });
}

console.log("\n/staff — accessibility");
{
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/staff`, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 1400));

  const a11y = await page.evaluate(() => {
    const table = document.querySelector("table");
    const headers = Array.from(document.querySelectorAll("th"));
    const buttons = Array.from(document.querySelectorAll("button"));
    return {
      hasTable: Boolean(table),
      headerCount: headers.length,
      headersScoped: headers.every((h) => h.getAttribute("scope") === "col"),
      unlabelledButtons: buttons.filter(
        (b) => ((b.getAttribute("aria-label") ?? b.textContent ?? "").trim()).length === 0,
      ).length,
      rowActionLabelled: buttons.some((b) =>
        (b.getAttribute("aria-label") ?? "").startsWith("Actions for"),
      ),
    };
  });

  check("table exposes column headers", a11y.hasTable && a11y.headerCount >= 4, `${a11y.headerCount} headers`);
  check("column headers are scoped for screen readers", a11y.headersScoped);
  check("every button has an accessible name", a11y.unlabelledButtons === 0, `${a11y.unlabelledButtons}`);
  check("row action buttons name their target", a11y.rowActionLabelled);

  const searchLabelled = await page.$('input[aria-label="Search staff"]');
  check("staff search input is labelled", Boolean(searchLabelled));

  const selectsLabelled = await page.evaluate(() => {
    const selects = Array.from(document.querySelectorAll("select"));
    return selects.length > 0 && selects.every((s) => Boolean(s.getAttribute("aria-label") || s.id));
  });
  check("filter selects are labelled", selectsLabelled);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
await browser.close();
if (failed > 0) process.exit(1);
