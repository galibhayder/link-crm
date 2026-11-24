/**
 * Responsive verification across real breakpoints.
 *
 * The existing suites check 390px and 1440px only. Layout defects cluster at the
 * awkward middle widths (tablet, small laptop, collapsed rail), so this checks
 * for horizontal overflow and unusable content at each.
 */

import puppeteer from "puppeteer";

const BASE = process.env.APP_URL ?? "http://localhost:5173";
const OUT = process.env.SHOT_DIR ?? "./shots";

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
await page.waitForSelector("#email");
await page.type("#email", "owner@demo.test");
await page.type("#password", "password123");
await page.click('button[type="submit"]');
await page.waitForFunction(() => !window.location.pathname.includes("/login"), { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));

// Widths that matter: mobile, large phone, tablet portrait, tablet landscape,
// small laptop, desktop, wide.
const WIDTHS = [
  { w: 320, h: 800, name: "320 (small phone)" },
  { w: 390, h: 844, name: "390 (phone)" },
  { w: 640, h: 900, name: "640 (large phone)" },
  { w: 768, h: 1024, name: "768 (tablet portrait)" },
  { w: 1024, h: 768, name: "1024 (tablet landscape)" },
  { w: 1280, h: 800, name: "1280 (laptop)" },
  { w: 1440, h: 900, name: "1440 (desktop)" },
  { w: 1920, h: 1080, name: "1920 (wide)" },
];

console.log("\nhorizontal overflow");
for (const { w, h, name } of WIDTHS) {
  await page.setViewport({ width: w, height: h });
  await new Promise((r) => setTimeout(r, 350));

  const overflow = await page.evaluate(() => {
    const docWidth = document.documentElement.scrollWidth;
    const winWidth = window.innerWidth;
    // A 1px tolerance absorbs sub-pixel rounding.
    return { docWidth, winWidth, overflows: docWidth > winWidth + 1 };
  });

  check(
    `no horizontal scroll at ${name}`,
    !overflow.overflows,
    overflow.overflows ? `${overflow.docWidth}px content in ${overflow.winWidth}px viewport` : "",
  );
}

console.log("\nsidebar behaviour");
{
  // The rail collapses at lg (1024px). Below that it must be off-canvas.
  const cases = [
    { w: 390, expectOffCanvas: true },
    { w: 768, expectOffCanvas: true },
    { w: 1440, expectOffCanvas: false },
  ];

  for (const { w, expectOffCanvas } of cases) {
    await page.setViewport({ width: w, height: 900 });
    await new Promise((r) => setTimeout(r, 350));

    const state = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      if (!aside) return { present: false };
      const rect = aside.getBoundingClientRect();
      const style = getComputedStyle(aside);
      return {
        present: true,
        right: rect.right,
        width: rect.width,
        translated: style.transform !== "none",
      };
    });

    const offCanvas = !state.present || state.right <= 1 || state.translated;
    check(
      `sidebar ${expectOffCanvas ? "hidden" : "visible"} at ${w}px`,
      expectOffCanvas ? offCanvas : !offCanvas,
      `right=${state.right} width=${state.width} translated=${state.translated}`,
    );
  }
}

console.log("\nmobile navigation usability");
{
  await page.setViewport({ width: 390, height: 844 });
  await new Promise((r) => setTimeout(r, 400));

  const menu = await page.$('button[aria-label="Open navigation"]');
  check("menu button present on mobile", Boolean(menu));

  if (menu) {
    await menu.click();
    await new Promise((r) => setTimeout(r, 500));

    const drawer = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      if (!aside) return { open: false, labelsVisible: false };
      const rect = aside.getBoundingClientRect();
      const labels = Array.from(aside.querySelectorAll("nav a span")).filter(
        (s) => (s.textContent ?? "").trim().length > 0,
      );
      return { open: rect.right > 0, labelsVisible: labels.length > 0, labelCount: labels.length };
    });

    check("drawer opens over content", drawer.open);
    check("labels visible in drawer (not icon-only)", drawer.labelsVisible, `${drawer.labelCount} labels`);

    // Tapping a link must close the drawer, otherwise it covers the new page.
    const firstLink = await page.$("aside nav a");
    if (firstLink) {
      await firstLink.click();
      await new Promise((r) => setTimeout(r, 700));
      const closed = await page.evaluate(() => {
        const aside = document.querySelector("aside");
        if (!aside) return true;
        const rect = aside.getBoundingClientRect();
        return rect.right <= 1 || getComputedStyle(aside).transform !== "none";
      });
      check("drawer closes after navigating", closed);
    }
    await page.screenshot({ path: `${OUT}/11-mobile-after-nav.png` });
  }
}

console.log("\ncollapsed rail");
{
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise((r) => setTimeout(r, 400));

  const collapse = await page.$('button[aria-label="Collapse sidebar"]');
  check("collapse control present on desktop", Boolean(collapse));

  if (collapse) {
    await collapse.click();
    await new Promise((r) => setTimeout(r, 500));

    const rail = await page.evaluate(() => {
      const aside = document.querySelector("aside");
      return aside ? { width: aside.getBoundingClientRect().width } : null;
    });
    check("sidebar collapses to icon rail", rail && rail.width < 100, `width=${rail?.width}`);

    const main = await page.evaluate(() => {
      const el = document.querySelector("main");
      return el ? el.getBoundingClientRect().left : 0;
    });
    check("content reflows to fill the space", main < 120, `main left=${main}`);

    await page.screenshot({ path: `${OUT}/12-collapsed-rail.png` });

    // Restore for any later assertions.
    const expand = await page.$('button[aria-label="Expand sidebar"]');
    if (expand) await expand.click();
  }
}

console.log("\nlogin page responsiveness");
{
  const ctx2 = await browser.createBrowserContext();
  const p2 = await ctx2.newPage();
  for (const w of [320, 390, 768, 1024, 1440]) {
    await p2.setViewport({ width: w, height: 800 });
    await p2.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
    await new Promise((r) => setTimeout(r, 250));
    const over = await p2.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    check(`login page no overflow at ${w}px`, !over);
  }
  await p2.setViewport({ width: 390, height: 844 });
  await p2.screenshot({ path: `${OUT}/13-login-mobile.png` });
  await ctx2.close();
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
await browser.close();
if (failed > 0) process.exit(1);
