/**
 * Screenshots of the Phase 5.1 screens, for the report and for visual review.
 * Writes to SHOT_DIR (default ./shots/phase5-1).
 */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5173";
const OUT = process.env.SHOT_DIR ?? "./shots/phase5-1";
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
  await sleep(2200);
  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log(`  ${name}.png`);
}

// ---------------------------------------------------------------- client
console.log("client portal");
{
  const { ctx, page } = await session("client@demo.test");
  await shot(page, "01-portal-overview");

  await page.goto(`${BASE}/portal/campaigns`, { waitUntil: "networkidle2" });
  await sleep(1800);
  await shot(page, "02-portal-campaigns");

  await page.goto(`${BASE}/portal/drafts`, { waitUntil: "networkidle2" });
  await sleep(1800);
  await shot(page, "03-portal-content");

  const card = await page.$('a[href^="/portal/drafts/"]');
  if (card) {
    await card.click();
    await sleep(2200);
    await shot(page, "04-portal-draft-review");

    // The revision dialog is part of the review flow.
    const buttons = await page.$$("button");
    for (const b of buttons) {
      const label = await b.evaluate((el) => el.textContent ?? "");
      if (/Request changes/i.test(label)) {
        await b.click();
        await sleep(1200);
        await shot(page, "05-portal-revision-dialog");
        break;
      }
    }
  }

  // Mobile width — the portal is top-nav for a reason.
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/portal`, { waitUntil: "networkidle2" });
  await sleep(1600);
  await shot(page, "06-portal-mobile");

  await ctx.close();
}

// ---------------------------------------------------------------- AM
console.log("account manager");
{
  const { ctx, page } = await session("am@demo.test");
  await page.goto(`${BASE}/approvals`, { waitUntil: "networkidle2" });
  await sleep(2200);
  await shot(page, "07-approvals-placements");

  const tabs = await page.$$('[role="tab"]');
  for (const t of tabs) {
    const label = await t.evaluate((el) => el.textContent ?? "");
    if (/Content/i.test(label)) {
      await t.click();
      await sleep(1600);
      await shot(page, "08-approvals-content");
      break;
    }
  }

  const bell = await page.$('button[aria-label*="Notification" i]');
  if (bell) {
    await bell.click();
    await sleep(1400);
    await page.screenshot({ path: `${OUT}/09-notification-bell.png`, clip: { x: 900, y: 0, width: 540, height: 520 } });
    console.log("  09-notification-bell.png");
  }

  // Dark theme.
  await page.evaluate(() => {
    localStorage.setItem("linkforge-theme", "dark");
    document.documentElement.classList.add("dark");
  });
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "networkidle2" });
  await sleep(1800);
  await shot(page, "10-approvals-dark");

  await ctx.close();
}

await browser.close();
console.log(`\nwrote screenshots to ${OUT}`);
