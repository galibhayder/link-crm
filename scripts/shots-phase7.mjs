/** Screenshots of the Phase 7 screens. Writes to SHOT_DIR (default ./shots/phase7). */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5173";
const OUT = process.env.SHOT_DIR ?? "./shots/phase7";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(email, width = 1440, height = 900) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    if (!page.url().includes("/login")) break;
  }
  await sleep(2400);
  return { ctx, page };
}

async function shot(page, name, fullPage = true) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log(`  ${name}.png`);
}

console.log("admin");
const { ctx, page } = await session("owner@demo.test");

await shot(page, "01-dashboard-branded");

await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2" });
await sleep(2400);
await shot(page, "02-admin-navigation");

// Each tab.
for (const [tab, name] of [
  ["Modules", "03-admin-modules"],
  ["Columns", "04-admin-columns"],
  ["Dashboard", "05-admin-dashboard"],
  ["Theme", "06-admin-theme"],
  ["Branding", "07-admin-branding"],
  ["Roles", "08-admin-roles"],
]) {
  await page.evaluate((label) => {
    const btn = Array.from(document.querySelectorAll('[role="tab"]')).find((b) =>
      (b.textContent ?? "").includes(label),
    );
    btn?.click();
  }, tab);
  await sleep(1200);
  await shot(page, name);
}

// Mobile.
await page.setViewport({ width: 390, height: 844 });
await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2" });
await sleep(2000);
await shot(page, "09-admin-mobile");

await ctx.close();
await browser.close();
console.log(`\nwrote screenshots to ${OUT}`);
