/** Responsive audit of every Phase 6 screen at phone width. */
import puppeteer from "puppeteer";

const BASE = "http://localhost:5173";
const API = "http://127.0.0.1:3000";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const token = await fetch("http://127.0.0.1:54321/auth/v1/token?grant_type=password", {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "owner@demo.test", password: "password123" }),
})
  .then((r) => r.json())
  .then((b) => b.access_token);

const clients = await fetch(`${API}/api/v1/clients?limit=1`, {
  headers: { authorization: `Bearer ${token}` },
}).then((r) => r.json());

const inv = await fetch(`${API}/api/v1/invoices`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({
    clientId: clients.data[0].id,
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    taxRate: 20,
    lineItems: [
      { description: "Guest post on a publisher site with a long descriptive label", quantity: 1, unitPrice: 1200 },
      { description: "Anchortext audit", quantity: 2, unitPrice: 350 },
    ],
  }),
}).then((r) => r.json());

await fetch(`${API}/api/v1/invoices/${inv.data.id}/issue`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
});

const link = await fetch(`${API}/api/v1/invoices/${inv.data.id}/share-link`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({}),
}).then((r) => r.json());

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await browser.createBrowserContext();
const page = await ctx.newPage();
await page.setViewport({ width: 390, height: 844 });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
await page.waitForSelector('input[type="email"]', { timeout: 20000 });
await page.type('input[type="email"]', "owner@demo.test");
await page.type('input[type="password"]', "password123");
await page.click('button[type="submit"]');
for (let i = 0; i < 50; i++) {
  await sleep(300);
  if (!page.url().includes("/login")) break;
}
await sleep(2000);

const routes = [
  ["invoice list", "/invoices"],
  ["invoice detail", `/invoices/${inv.data.id}`],
  ["invoice editor", "/invoices/new"],
  ["payments", "/payments"],
  ["finance", "/finance"],
  ["reports", "/reports"],
];

let failures = 0;

for (const [name, path] of routes) {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle2" });
  await sleep(2200);

  const info = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    // A control that extends past the viewport is unreachable on a phone.
    offscreen: Array.from(document.querySelectorAll("button, a, input, select, textarea"))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > window.innerWidth + 2 || r.left < -2);
      })
      .slice(0, 3)
      .map((el) => `${el.tagName}:${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 24)}`),
  }));

  const ok = info.overflow <= 2;
  if (!ok) failures += 1;
  console.log(
    `${ok ? "  ok  " : "  FAIL"} ${name.padEnd(16)} overflow ${info.overflow}px` +
      (info.offscreen.length ? `  offscreen: ${info.offscreen.join(" | ")}` : ""),
  );
}

// The public page, at phone width, with no session.
const publicCtx = await browser.createBrowserContext();
const publicPage = await publicCtx.newPage();
await publicPage.setViewport({ width: 390, height: 844 });
await publicPage.goto(`${BASE}/i/${link.data.token}`, { waitUntil: "networkidle2" });
await sleep(2200);

const pubOverflow = await publicPage.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
const pubOk = pubOverflow <= 2;
if (!pubOk) failures += 1;
console.log(`${pubOk ? "  ok  " : "  FAIL"} ${"public invoice".padEnd(16)} overflow ${pubOverflow}px`);

await browser.close();
console.log(failures === 0 ? "\nresponsive audit clean" : `\n${failures} responsive issues`);
process.exit(failures === 0 ? 0 : 1);
