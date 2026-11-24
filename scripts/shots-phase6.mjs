/**
 * Screenshots of the Phase 6 screens. Writes to SHOT_DIR (default ./shots/phase6).
 */
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const BASE = "http://localhost:5173";
const API = "http://127.0.0.1:3000";
const OUT = process.env.SHOT_DIR ?? "./shots/phase6";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const ownerToken = await fetch("http://127.0.0.1:54321/auth/v1/token?grant_type=password", {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@demo.test", password: "password123" }),
})
  .then((r) => r.json())
  .then((b) => b.access_token);

// Seed a rich invoice so the screenshots show something worth looking at.
const clients = await fetch(`${API}/api/v1/clients?limit=1`, {
  headers: { authorization: `Bearer ${ownerToken}` },
}).then((r) => r.json());

const invoice = await fetch(`${API}/api/v1/invoices`, {
  method: "POST",
  headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
  body: JSON.stringify({
    clientId: clients.data[0].id,
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    taxRate: 20,
    discountAmount: 150,
    paymentInstructions: "Bank transfer to GB00 0000 0000 0000, quoting the invoice number.",
    notes: "Payment due within 14 days of the issue date.",
    lineItems: [
      { description: "Guest post — analytics platform comparison", quantity: 1, unitPrice: 1200 },
      { description: "Niche edit — SaaS tools roundup", quantity: 2, unitPrice: 350 },
      { description: "Anchor text audit and rebalancing", quantity: 1, unitPrice: 250 },
    ],
  }),
}).then((r) => r.json());

await fetch(`${API}/api/v1/invoices/${invoice.data.id}/issue`, {
  method: "POST",
  headers: { authorization: `Bearer ${ownerToken}` },
});

const link = await fetch(`${API}/api/v1/invoices/${invoice.data.id}/share-link`, {
  method: "POST",
  headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
  body: JSON.stringify({}),
}).then((r) => r.json());

await fetch(`${API}/api/v1/invoices/${invoice.data.id}/publish`, {
  method: "POST",
  headers: { authorization: `Bearer ${ownerToken}` },
});

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

// ---------------------------------------------------------------- owner
console.log("owner");
{
  const { ctx, page } = await session("owner@demo.test");
  await shot(page, "01-dashboard-with-finance-nav");

  await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle2" });
  await sleep(2200);
  await shot(page, "02-invoice-list");

  await page.goto(`${BASE}/invoices/${invoice.data.id}`, { waitUntil: "networkidle2" });
  await sleep(2500);
  await shot(page, "03-invoice-detail");

  // Preview dialog.
  await page.evaluate(() => {
    Array.from(document.querySelectorAll("button"))
      .find((b) => (b.textContent ?? "").includes("Preview"))
      ?.click();
  });
  await sleep(2000);
  await page.screenshot({ path: `${OUT}/04-invoice-preview.png` });
  console.log("  04-invoice-preview.png");
  await page.keyboard.press("Escape");
  await sleep(600);

  await page.goto(`${BASE}/finance`, { waitUntil: "networkidle2" });
  await sleep(2600);
  await shot(page, "05-financials");

  await page.goto(`${BASE}/reports`, { waitUntil: "networkidle2" });
  await sleep(2200);
  await shot(page, "06-reports");

  await page.goto(`${BASE}/payments`, { waitUntil: "networkidle2" });
  await sleep(2000);
  await shot(page, "07-payments");

  // Dark theme.
  await page.evaluate(() => localStorage.setItem("linkforge-theme", "dark"));
  await page.goto(`${BASE}/invoices/${invoice.data.id}`, { waitUntil: "networkidle2" });
  await sleep(2200);
  await shot(page, "08-invoice-detail-dark");

  // Mobile.
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/invoices`, { waitUntil: "networkidle2" });
  await sleep(1800);
  await shot(page, "09-invoice-list-mobile");

  await ctx.close();
}

// ---------------------------------------------------------------- public
console.log("public invoice");
{
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1024, height: 900 });
  await page.goto(`${BASE}/i/${link.data.token}`, { waitUntil: "networkidle2" });
  await sleep(2500);
  await shot(page, "10-public-invoice");
  await ctx.close();
}

// ---------------------------------------------------------------- client
console.log("client portal");
{
  const { ctx, page } = await session("client@demo.test");
  await page.goto(`${BASE}/portal/invoices`, { waitUntil: "networkidle2" });
  await sleep(2400);
  await shot(page, "11-portal-invoices");
  await ctx.close();
}

await browser.close();
console.log(`\nwrote screenshots to ${OUT}`);
