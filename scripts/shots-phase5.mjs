import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "phase5";
const BASE = "http://localhost:5173";
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => {
  await page.screenshot({ path: `${OUT}/${n}.png` });
  console.log(`  → ${n}.png`);
};

async function login(email = "owner@demo.test") {
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2" });
  await page.waitForSelector('input[type="email"]', { timeout: 20000 });
  await page.type('input[type="email"]', email);
  await page.type('input[type="password"]', "password123");
  await page.click('button[type="submit"]');
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    if (!page.url().includes("/login")) break;
  }
  await sleep(1500);
}

console.log("login");
await login();

console.log("content page");
await page.goto(`${BASE}/content`, { waitUntil: "networkidle2" });
await page.waitForSelector("text/Content", { timeout: 20000 }).catch(() => {});
await sleep(2500);
await shot("01-content");

const contentInfo = await page.evaluate(() => ({
  briefs: document.querySelectorAll("button[class*='rounded-lg']").length,
  hasHeading: /Content/.test(document.body.innerText),
  body: document.body.innerText.slice(0, 240),
}));
console.log("  content:", JSON.stringify(contentInfo));

// Open a brief to show the editor.
const opened = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")].filter((b) =>
    /Analytics|Choosing|attribution|Brief/i.test(b.textContent ?? ""),
  );
  buttons[0]?.click();
  return buttons.length;
});
await sleep(2000);
await shot("02-content-editor");
console.log("  brief buttons:", opened);

console.log("anchors page");
await page.goto(`${BASE}/anchors`, { waitUntil: "networkidle2" });
await sleep(3000);
await shot("03-anchors");

const anchorInfo = await page.evaluate(() => ({
  svgCount: document.querySelectorAll("svg[role='img']").length,
  hasDonut: Boolean(document.querySelector("svg circle")),
  text: document.body.innerText.slice(0, 300),
}));
console.log("  anchors:", JSON.stringify(anchorInfo));

// Alert dialog.
const alertBtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "New alert");
  b?.click();
  return Boolean(b);
});
await sleep(1200);
await shot("04-anchors-alert");
console.log("  alert dialog opened:", alertBtn);
await page.keyboard.press("Escape");
await sleep(600);

// Dark mode.
await page.evaluate(() => document.documentElement.classList.add("dark"));
await sleep(800);
await shot("05-anchors-dark");
await page.evaluate(() => document.documentElement.classList.remove("dark"));

// Mobile.
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await sleep(1000);
await shot("06-anchors-mobile");

const mobile = await page.evaluate(() => ({
  pageOverflow: document.body.scrollWidth > window.innerWidth + 1,
  width: window.innerWidth,
}));
console.log("  mobile:", JSON.stringify(mobile));

await page.setViewport({ width: 1440, height: 900 });
await page.goto(`${BASE}/content`, { waitUntil: "networkidle2" });
await sleep(2000);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await sleep(900);
await shot("07-content-mobile");
const cm = await page.evaluate(() => ({ pageOverflow: document.body.scrollWidth > window.innerWidth + 1 }));
console.log("  content mobile:", JSON.stringify(cm));

await browser.close();
console.log("done");
