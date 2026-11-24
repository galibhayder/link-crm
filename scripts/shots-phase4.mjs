/**
 * Screenshots the Phase 4 pages.
 *
 * Assertions pass on JSON; only a screenshot shows whether the board actually
 * lays out as six columns and whether a card is readable at 390px.
 */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "phase4";
const BASE = "http://localhost:5173";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`  → ${OUT}/${name}.png`);
};

const login = async (email = "owner@demo.test") => {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', "password123");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {}),
    page.click('button[type="submit"]'),
  ]);
  await new Promise((r) => setTimeout(r, 2500));
};

console.log("logging in as owner");
await login();
await shot("01-dashboard-after-login");

console.log("placements board");
await page.goto(`${BASE}/placements`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2500));
await shot("02-board-light");

// How many columns actually rendered, and how many cards?
const boardInfo = await page.evaluate(() => {
  const sections = [...document.querySelectorAll('section[role="listitem"]')];
  return {
    columns: sections.length,
    labels: sections.map((s) => s.querySelector("h2")?.textContent ?? ""),
    cards: document.querySelectorAll("[data-placement-id]").length,
    hasOverflow: (() => {
      const el = document.querySelector('[role="list"]');
      return el ? el.scrollWidth > el.clientWidth : null;
    })(),
  };
});
console.log("  board:", JSON.stringify(boardInfo));

// Open a card drawer.
const card = await page.$("[data-placement-id] button");
if (card) {
  await card.click();
  await new Promise((r) => setTimeout(r, 1800));
  await shot("03-placement-drawer");
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 500));
}

// Create dialog.
const newBtn = await page.evaluateHandle(() =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New placement"),
);
if (newBtn.asElement()) {
  await newBtn.asElement().click();
  await new Promise((r) => setTimeout(r, 1200));
  await shot("04-create-placement");
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 600));
}

// Dark mode.
await page.evaluate(() => {
  document.documentElement.classList.add("dark");
});
await new Promise((r) => setTimeout(r, 700));
await shot("05-board-dark");
await page.evaluate(() => document.documentElement.classList.remove("dark"));

// Mobile.
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await new Promise((r) => setTimeout(r, 900));
await shot("06-board-mobile");

const mobileInfo = await page.evaluate(() => {
  const board = document.querySelector('[role="list"]');
  return {
    bodyScrollW: document.body.scrollWidth,
    viewportW: window.innerWidth,
    // A board scrolls horizontally by design; the PAGE must not.
    horizontalPageOverflow: document.body.scrollWidth > window.innerWidth + 1,
    boardScrolls: board ? board.scrollWidth > board.clientWidth : null,
  };
});
console.log("  mobile:", JSON.stringify(mobileInfo));

// Outreach page.
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await page.goto(`${BASE}/outreach`, { waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 2500));
await shot("07-outreach");

const outreachInfo = await page.evaluate(() => ({
  hasProviderNotice: /Sending is disabled/i.test(document.body.innerText),
  hasTable: Boolean(document.querySelector("table")),
  rowCount: document.querySelectorAll("tbody tr").length,
}));
console.log("  outreach:", JSON.stringify(outreachInfo));

// Templates dialog.
const tplBtn = await page.evaluateHandle(() =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Templates"),
);
if (tplBtn.asElement()) {
  await tplBtn.asElement().click();
  await new Promise((r) => setTimeout(r, 1500));
  await shot("08-outreach-templates");
}

await browser.close();
console.log("done");
