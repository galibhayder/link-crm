/**
 * ATTACK: does the Phase 4 `negotiated_cost` column leak wholesale cost to roles
 * that must never see it?
 *
 * Phase 3 deliberately split money into three tables so that RLS could isolate
 * it: placement_pricing (tier 1), placement_costs (tier 2, no policy at all for
 * account_manager), margin views (tier 3). Phase 4 added `negotiated_cost` as a
 * COLUMN on placements, which every internal role can read.
 */
const S = "http://127.0.0.1:54321";
const API = "http://127.0.0.1:3000";
const A =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const login = async (email) => {
  const r = await fetch(`${S}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: A, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await r.json()).access_token;
};

const api = async (path, token, opts = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
};

const owner = await login("owner@demo.test");
const am = await login("am@demo.test");
const writer = await login("writer@demo.test");

// Owner creates a placement and records a wholesale cost of 850.
const camps = await api("/api/v1/campaigns?limit=1", owner);
const created = await api("/api/v1/placements", owner, {
  method: "POST",
  body: JSON.stringify({
    campaignId: camps.body.data[0].id,
    targetUrl: `https://leak-probe.test/${Date.now()}`,
    negotiatedCost: 850.0,
    internalNotes: "Wholesale: 850, client charged 1500.",
  }),
});
const id = created.body?.data?.id;
console.log("owner created placement with negotiatedCost=850:", created.status, id);

const cost = await api(`/api/v1/costs/placements/${id}`, owner, { method: "PUT",
  body: JSON.stringify({ supplierCost: 850, currency: "USD" }) });
console.log("owner recorded tier-2 cost:", cost.status);

console.log("\n--- can account_manager see the wholesale cost? ---");
const amList = await api("/api/v1/placements?limit=200", am);
const amRow = (amList.body?.data ?? []).find((p) => p.id === id);
console.log("  list status:", amList.status);
console.log("  negotiated_cost in list:", amRow?.negotiated_cost);
console.log("  internal_notes in list:", amRow?.internal_notes ? "PRESENT" : "absent");

const amOne = await api(`/api/v1/placements/${id}`, am);
console.log("  detail status:", amOne.status);
console.log("  negotiated_cost in detail:", amOne.body?.data?.negotiated_cost);
console.log("  internal_notes in detail:", amOne.body?.data?.internal_notes ? "PRESENT" : "absent");

const amBoard = await api("/api/v1/placements/board", am);
const onBoard = (amBoard.body?.data?.stages ?? []).flatMap((s) => s.placements).find((p) => p.id === id);
console.log("  negotiated_cost on board:", onBoard?.negotiated_cost);

const amCost = await api(`/api/v1/costs/placements/${id}`, am);
console.log("  /costs endpoint status (must be 403 or empty):", amCost.status);

console.log("\n--- can content_writer see the wholesale cost? ---");
const wr = await api(`/api/v1/placements/${id}`, writer);
console.log("  detail status:", wr.status);
console.log("  negotiated_cost:", wr.body?.data?.negotiated_cost);
console.log("  internal_notes:", wr.body?.data?.internal_notes ? "PRESENT" : "absent");

console.log("\n--- can content_writer write the wholesale cost? ---");
const wrPatch = await api(`/api/v1/placements/${id}`, writer, {
  method: "PATCH",
  body: JSON.stringify({ negotiatedCost: 1 }),
});
console.log("  PATCH negotiatedCost status:", wrPatch.status, "→", wrPatch.body?.data?.negotiated_cost ?? wrPatch.body?.error?.code);
