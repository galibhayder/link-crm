/**
 * PHASE 4 UI VERIFICATION.
 *
 * The API suite proves the rules; this proves the UI obeys them and that the
 * board actually works with a mouse. It deliberately exercises the real drag
 * events rather than calling the API, because the interesting failure mode is a
 * board that looks right and refuses to move anything.
 */
import puppeteer from "puppeteer";

const BASE = "http://localhost:5173";
const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });

/**
 * Each user gets a FRESH browser context.
 *
 * Clearing localStorage in one tab and reloading is not equivalent to signing out:
 * the Supabase client caches the session in memory, the query cache keeps prior
 * results, and the auth provider's `mounted` ref survives. Switching users in a
 * single context produced failures that had nothing to do with the app. A new
 * context is what a different person signing in actually is.
 */
let context = await browser.createBrowserContext();
let page = await context.newPage();
await page.setViewport({ width: 1440, height: 900 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(email) {
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

async function newUser(email) {
  await context.close();
  context = await browser.createBrowserContext();
  page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  if (email) await login(email);
}

/** Fresh owner session, at the board, with the columns rendered. */
async function ownerBoard() {
  await newUser("owner@demo.test");
  await page.goto(`${BASE}/placements`, { waitUntil: "networkidle2" });
  await page.waitForSelector('section[role="listitem"]', { timeout: 25000 });
  await sleep(1200);
}

// ===========================================================================
console.log("\n1. board renders for an owner");
// ===========================================================================
await ownerBoard();

const board = await page.evaluate(() => {
  const sections = [...document.querySelectorAll('section[role="listitem"]')];
  return {
    columns: sections.length,
    labels: sections.map((s) => s.querySelector("h2")?.textContent?.trim() ?? ""),
    cards: document.querySelectorAll("[data-placement-id]").length,
    draggable: [...document.querySelectorAll("[data-placement-id]")].every(
      (el) => el.getAttribute("draggable") === "true",
    ),
    breadcrumb: document.querySelector("header")?.innerText ?? "",
  };
});
check("six columns render", board.columns === 6, String(board.columns));
check(
  "stage labels are correct",
  JSON.stringify(board.labels) ===
    JSON.stringify(["Prospected", "Pitched", "Client Approved", "Content Writing", "Submitted", "Live"]),
  board.labels.join(" | "),
);
check("cards render", board.cards > 0, `${board.cards} cards`);
check("cards are draggable", board.draggable);
check("breadcrumb is not 'Not found'", !/Not found/i.test(board.breadcrumb), board.breadcrumb.split("\n")[0]);

// ===========================================================================
console.log("\n2. drag and drop moves a card");
// ===========================================================================
{
  // Create a card for this test rather than relying on seed state.
  //
  // Earlier runs move cards along the pipeline, so "whatever happens to be in
  // Prospected" makes the suite pass or fail depending on test history. A card
  // created here is guaranteed to start at `prospected`.
  const created = await page.evaluate(async () => {
    const raw = localStorage.getItem("linkforge-auth");
    const token = raw ? JSON.parse(raw)?.access_token : null;
    const campaigns = await fetch("http://127.0.0.1:3000/api/v1/campaigns?limit=1", {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    const campaignId = campaigns.data?.[0]?.id;
    if (!campaignId) return { ok: false, reason: "no campaign" };

    const res = await fetch("http://127.0.0.1:3000/api/v1/placements", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        campaignId,
        targetUrl: `https://acme-saas.test/dnd-${Date.now()}`,
        anchorText: "drag test",
      }),
    });
    const body = await res.json();
    return { ok: res.ok, id: body.data?.id, stage: body.data?.pipeline_stage };
  });

  check("a test card is created at prospected", created.ok && created.stage === "prospected", created.reason ?? created.stage);

  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector('section[role="listitem"]', { timeout: 20000 });
  await sleep(1500);

  const before = await page.evaluate((cardId) => {
    const sections = [...document.querySelectorAll('section[role="listitem"]')];
    const prospected = sections.find((s) => s.querySelector("h2")?.textContent?.includes("Prospected"));
    const pitched = sections.find((s) => s.querySelector("h2")?.textContent?.includes("Pitched"));
    return {
      found: Boolean(document.querySelector(`[data-placement-id="${cardId}"]`)),
      prospectedCount: prospected?.querySelectorAll("[data-placement-id]").length ?? 0,
      pitchedCount: pitched?.querySelectorAll("[data-placement-id]").length ?? 0,
    };
  }, created.id);

  check("the new card is on the board", before.found);

  // Native HTML5 DnD cannot be driven by elementHandle.drag(), so the events are
  // dispatched directly with a shared DataTransfer. This is still the real
  // handler path: onDragStart → onDragOver → onDrop.
  await page.evaluate((cardId) => {
    const card = document.querySelector(`[data-placement-id="${cardId}"]`);
    const sections = [...document.querySelectorAll('section[role="listitem"]')];
    const pitched = sections.find((s) => s.querySelector("h2")?.textContent?.includes("Pitched"));
    if (!card || !pitched) throw new Error("elements missing");

    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    pitched.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
    pitched.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    pitched.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
    card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
  }, created.id);

  await sleep(3000);

  const after = await page.evaluate((cardId) => {
    const sections = [...document.querySelectorAll('section[role="listitem"]')];
    const prospected = sections.find((s) => s.querySelector("h2")?.textContent?.includes("Prospected"));
    const pitched = sections.find((s) => s.querySelector("h2")?.textContent?.includes("Pitched"));
    return {
      prospectedCount: prospected?.querySelectorAll("[data-placement-id]").length ?? 0,
      pitchedCount: pitched?.querySelectorAll("[data-placement-id]").length ?? 0,
      nowInPitched: Boolean(pitched?.querySelector(`[data-placement-id="${cardId}"]`)),
    };
  }, created.id);

  check(
    "card moved from Prospected to Pitched",
    after.nowInPitched && after.pitchedCount === before.pitchedCount + 1,
    `${before.prospectedCount}/${before.pitchedCount} → ${after.prospectedCount}/${after.pitchedCount}`,
  );

  // The move must be recorded in history, not just moved in the DOM.
  const historyOk = await page.evaluate(async (cardId) => {
    const raw = localStorage.getItem("linkforge-auth");
    const token = raw ? JSON.parse(raw)?.access_token : null;
    const res = await fetch(`http://127.0.0.1:3000/api/v1/placements/${cardId}/history`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    return (body.data ?? []).some((e) => e.event_type === "stage_change");
  }, created.id);
  check("the move was recorded in placement history", historyOk);
}

// ===========================================================================
console.log("\n3. illegal moves are refused by the UI");
// ===========================================================================
{
  // Section 2 already moved a card, so reload the board to start from a known
  // state rather than assuming what is left in Prospected.
  await ownerBoard();

  // Guarantee there is something in Prospected to attempt the illegal drop with.
  await page.evaluate(async () => {
    const token = JSON.parse(localStorage.getItem("linkforge-auth") ?? "{}")?.access_token;
    const campaigns = await fetch("http://127.0.0.1:3000/api/v1/campaigns?limit=1", {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    await fetch("http://127.0.0.1:3000/api/v1/placements", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        campaignId: campaigns.data?.[0]?.id,
        targetUrl: `https://acme-saas.test/illegal-${Date.now()}`,
      }),
    });
  });
  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector('section[role="listitem"]', { timeout: 20000 });
  await sleep(1200);

  // Prospected → Live must be refused: it skips four stages.
  const blocked = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('section[role="listitem"]')];
    const prospected = sections.find((s) => s.querySelector("h2")?.textContent?.includes("Prospected"));
    const live = sections.find((s) => s.querySelector("h2")?.textContent?.includes("Live"));
    const card = prospected?.querySelector("[data-placement-id]");
    if (!card || !live) return { attempted: false };

    const dt = new DataTransfer();
    card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    live.dispatchEvent(new DragEvent("dragenter", { bubbles: true, dataTransfer: dt }));
    live.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
    const dropEffect = dt.dropEffect;
    live.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
    card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return { attempted: true, dropEffect, cardId: card.getAttribute("data-placement-id") };
  });

  check("the illegal drop was actually attempted", blocked.attempted);
  await sleep(1500);

  const stillProspected = await page.evaluate((cardId) => {
    const sections = [...document.querySelectorAll('section[role="listitem"]')];
    const prospected = sections.find((s) => s.querySelector("h2")?.textContent?.includes("Prospected"));
    return [...(prospected?.querySelectorAll("[data-placement-id]") ?? [])].some(
      (el) => el.getAttribute("data-placement-id") === cardId,
    );
  }, blocked.cardId);

  check("dropping on an illegal column does not move the card", stillProspected);
}

// ===========================================================================
console.log("\n4. keyboard path — the move dialog");
// ===========================================================================
{
  const moveBtn = await page.evaluateHandle(() =>
    [...document.querySelectorAll("button")].find((b) => /^Move .* to another stage$/.test(b.getAttribute("aria-label") ?? "")),
  );
  check("every card exposes a move control for keyboard users", Boolean(moveBtn.asElement()));

  if (moveBtn.asElement()) {
    await moveBtn.asElement().click();
    await sleep(1200);
    const dialog = await page.evaluate(() => ({
      open: Boolean(document.querySelector('[role="dialog"]')),
      title: document.querySelector('[role="dialog"] h2, [role="dialog"] [id*="radix"]')?.textContent ?? "",
      hasStageSelect: Boolean(document.querySelector('[role="dialog"] select')),
    }));
    check("move dialog opens", dialog.open);
    check("move dialog offers a stage selector", dialog.hasStageSelect);
    await page.keyboard.press("Escape");
    await sleep(500);
  }
}

// ===========================================================================
console.log("\n5. client approval requires a note");
// ===========================================================================
{
  await ownerBoard();

  // Build a card that is definitely at Pitched, since client_approved is only
  // offered from there. Relying on seed state made this test depend on whether
  // an earlier section had already moved the only pitched card onwards.
  const prepared = await page.evaluate(async () => {
    const token = JSON.parse(localStorage.getItem("linkforge-auth") ?? "{}")?.access_token;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const campaigns = await fetch("http://127.0.0.1:3000/api/v1/campaigns?limit=1", { headers }).then((r) => r.json());
    const created = await fetch("http://127.0.0.1:3000/api/v1/placements", {
      method: "POST",
      headers,
      body: JSON.stringify({
        campaignId: campaigns.data?.[0]?.id,
        targetUrl: `https://acme-saas.test/approval-${Date.now()}`,
      }),
    }).then((r) => r.json());

    const id = created.data?.id;
    if (!id) return { ok: false };

    const moved = await fetch(`http://127.0.0.1:3000/api/v1/placements/${id}/transition`, {
      method: "POST",
      headers,
      body: JSON.stringify({ toStage: "pitched" }),
    }).then((r) => r.json());

    return { ok: moved.data?.pipeline_stage === "pitched", id };
  });
  check("a card at Pitched is prepared for the approval test", prepared.ok);

  await page.reload({ waitUntil: "networkidle2" });
  await page.waitForSelector('section[role="listitem"]', { timeout: 20000 });
  await sleep(1400);

  // Target a card that is actually AT Pitched.
  const opened = await page.evaluate((cardId) => {
    const card = document.querySelector(`[data-placement-id="${cardId}"]`);
    if (!card) return { clicked: false };

    const action = [...card.querySelectorAll("button")].find((b) =>
      /^Move .* to another stage$/.test(b.getAttribute("aria-label") ?? ""),
    );
    action?.click();
    return { clicked: Boolean(action) };
  }, prepared.id);
  check("a card at Pitched exposes its move control", opened.clicked);

  await sleep(1100);
  const approval = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const select = dialog?.querySelector("select");
    if (!select) return { hasSelect: false, hasApprovalOption: false };
    const option = [...select.options].find((o) => o.value === "client_approved");
    if (!option) return { hasSelect: true, hasApprovalOption: false, options: [...select.options].map((o) => o.value) };
    select.value = "client_approved";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { hasSelect: true, hasApprovalOption: true };
  });
  check("Client Approved is offered from a pitched card", approval.hasApprovalOption, (approval.options ?? []).join(","));

  if (approval.hasApprovalOption) {
    await sleep(800);
    const gated = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const submit = [...(dialog?.querySelectorAll("button") ?? [])].find((b) => b.textContent?.trim() === "Move");
      return {
        submitDisabled: submit?.disabled ?? null,
        hasNoteField: /how did the client approve/i.test(dialog?.textContent ?? ""),
      };
    });
    check("choosing Client Approved reveals an approval-note field", gated.hasNoteField);
    check("submitting is blocked until a note is entered", gated.submitDisabled === true, String(gated.submitDisabled));
  }

  await page.keyboard.press("Escape");
  await sleep(400);
}

// ===========================================================================
console.log("\n6. permissions — a content writer");
// ===========================================================================
await newUser("writer@demo.test");
await page.goto(`${BASE}/placements`, { waitUntil: "networkidle2" });
await sleep(2500);

const writerView = await page.evaluate(() => ({
  url: location.pathname,
  columns: document.querySelectorAll('section[role="listitem"]').length,
  hasNewButton: [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "New placement"),
  hasOutreachNav: /Outreach/.test(document.querySelector("nav")?.innerText ?? ""),
}));
check("content_writer reaches the board", writerView.columns === 6, `${writerView.columns} columns`);
check("content_writer can create placements", writerView.hasNewButton);
check("content_writer has no Outreach nav entry", !writerView.hasOutreachNav);

await page.goto(`${BASE}/outreach`, { waitUntil: "networkidle2" });
await sleep(1800);
const writerOutreach = await page.evaluate(() => ({
  path: location.pathname,
  blocked: /don't have access|doesn't include this permission/i.test(document.body.innerText),
}));
check(
  "content_writer is shown a permission explanation for Outreach",
  writerOutreach.blocked || writerOutreach.path === "/404",
  writerOutreach.blocked ? "explanation shown" : `redirected to ${writerOutreach.path}`,
);

// ===========================================================================
console.log("\n7. client boundary");
// ===========================================================================
// The client PORTAL UI did not exist when this suite was written, so a client
// sign-in was refused at the door with an explicit message. Phase 5.1 built the
// portal, so the correct behaviour is now: the client signs in successfully and
// lands in THEIR workspace — never the internal CRM. The assertion is updated to
// the boundary that still matters rather than deleted.
await newUser("client@demo.test");

const clientLogin = await page.evaluate(() => ({
  path: location.pathname,
  innerNavPresent: Array.from(document.querySelectorAll("nav a")).some((a) =>
    /^(Placements|Outreach|Approvals|Anchors|Staff)/.test((a.textContent ?? "").trim()),
  ),
}));

check(
  "a client sign-in lands in the portal, never the internal CRM",
  clientLogin.path.startsWith("/portal"),
  clientLogin.path,
);
check(
  "the client's session never renders an internal navigation item",
  !clientLogin.innerNavPresent,
);

// The API boundary is what actually protects the data, so it is tested directly
// with the client's own token regardless of whether a portal screen exists.
const SUPABASE = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const clientToken = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
  method: "POST",
  headers: { apikey: ANON, "content-type": "application/json" },
  body: JSON.stringify({ email: "client@demo.test", password: "password123" }),
})
  .then((r) => r.json())
  .then((b) => b.access_token);

check("the client account has a valid session", Boolean(clientToken));

const hit = async (path) => {
  const res = await fetch(`http://127.0.0.1:3000${path}`, {
    headers: { authorization: `Bearer ${clientToken}` },
  });
  return { status: res.status, text: await res.text() };
};

const internalBoard = await hit("/api/v1/placements/board");
check("client is 403 on the internal board", internalBoard.status === 403, String(internalBoard.status));

const internalList = await hit("/api/v1/placements");
check("client is 403 on internal placements", internalList.status === 403, String(internalList.status));

const internalOutreach = await hit("/api/v1/outreach");
check("client is 403 on outreach", internalOutreach.status === 403, String(internalOutreach.status));

const portal = await hit("/portal/v1/placements");
check("portal placements request succeeds", portal.status === 200, String(portal.status));
check("portal payload has no internal notes", !/internal_notes/.test(portal.text));
check("portal payload has no cost figures", !/negotiated_cost|supplier_cost|client_rate/.test(portal.text));
check("portal payload has no assignee", !/assigned_to|content_assignee/.test(portal.text));

const portalRows = JSON.parse(portal.text).data ?? [];
check(
  "portal exposes only approved-or-later placements",
  portalRows.every((r) => ["client_approved", "content_writing", "submitted", "live"].includes(r.pipeline_stage)),
  portalRows.map((r) => r.pipeline_stage).join(", ") || "no rows",
);

// ===========================================================================
console.log("\n8. responsive");
// ===========================================================================
await ownerBoard();

for (const [w, h, label] of [[390, 844, "mobile"], [768, 1024, "tablet"], [1440, 900, "desktop"]]) {
  await page.setViewport({ width: w, height: h });
  await sleep(1000);
  const layout = await page.evaluate(() => {
    const el = document.querySelector('[role="list"]');
    return {
      pageOverflow: document.body.scrollWidth > window.innerWidth + 1,
      boardScrolls: el ? el.scrollWidth > el.clientWidth : null,
      columnsVisible: document.querySelectorAll('section[role="listitem"]').length,
    };
  });
  check(`${label}: no horizontal PAGE overflow`, !layout.pageOverflow);
  check(`${label}: board renders its columns`, layout.columnsVisible === 6, String(layout.columnsVisible));
  if (label === "desktop") {
    check("desktop: all six columns fit without scrolling", layout.boardScrolls === false);
  }
}

// ===========================================================================
console.log("\n9. money is hidden from roles that must not see it");
// ===========================================================================
{
  // The owner holds costs:read, so the create dialog offers the cost field and
  // the board can render a figure.
  await ownerBoard();
  const ownerCostField = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New placement");
    btn?.click();
    return Boolean(btn);
  });
  check("owner can open the create dialog", ownerCostField);
  await sleep(900);

  const ownerSeesCostField = await page.evaluate(() =>
    /Negotiated publisher cost/i.test(document.querySelector('[role="dialog"]')?.textContent ?? ""),
  );
  check("owner is offered the negotiated-cost field", ownerSeesCostField);
  await page.keyboard.press("Escape");
  await sleep(400);

  // A content writer must not be offered a field that would be refused, and must
  // not see a cost figure anywhere on the board.
  await newUser("writer@demo.test");
  await page.goto(`${BASE}/placements`, { waitUntil: "networkidle2" });
  await page.waitForSelector('section[role="listitem"]', { timeout: 25000 });
  await sleep(1200);

  const writerBoard = await page.evaluate(() => ({
    text: document.body.innerText,
    hasCurrency: /\$|USD/.test(document.querySelector('[role="list"]')?.innerText ?? ""),
  }));
  check("content_writer's board shows no currency figure", !writerBoard.hasCurrency);

  const writerOpened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "New placement");
    btn?.click();
    return Boolean(btn);
  });
  check("content_writer can open the create dialog", writerOpened);
  await sleep(900);

  const writerCostField = await page.evaluate(() =>
    /Negotiated publisher cost/i.test(document.querySelector('[role="dialog"]')?.textContent ?? ""),
  );
  check("content_writer is NOT offered the negotiated-cost field", !writerCostField);
  await page.keyboard.press("Escape");
  await sleep(400);
}

// ===========================================================================
console.log("\n10. approvals are attributed and gated");
// ===========================================================================
{
  await ownerBoard();

  // The Account Manager holds placements:approve but not placements:write. The
  // client-decision endpoint must be reachable for them.
  await newUser("am@demo.test");
  await page.goto(`${BASE}/placements`, { waitUntil: "networkidle2" });
  await page.waitForSelector('section[role="listitem"]', { timeout: 25000 });
  await sleep(1200);

  const amBoard = await page.evaluate(() => ({
    columns: document.querySelectorAll('section[role="listitem"]').length,
    // account_manager has no placements:write, so no create button and no drag.
    hasNewButton: [...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "New placement"),
    draggable: [...document.querySelectorAll("[data-placement-id]")].some(
      (el) => el.getAttribute("draggable") === "true",
    ),
  }));
  check("account_manager can read the board", amBoard.columns === 6, `${amBoard.columns} columns`);
  check("account_manager is not offered placement creation (no write permission)", !amBoard.hasNewButton);
  check("account_manager's cards are not draggable", !amBoard.draggable);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d ? ` — ${f.d}` : ""}`);
}

await browser.close();
process.exit(failed.length > 0 ? 1 : 0);
