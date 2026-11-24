/**
 * PHASE 5.1 — NOTIFICATION DELIVERY.
 *
 * The behaviours that matter operationally: a recurring unresolved alert notifies
 * once, acknowledging it lets it fire again, one user's read state does not affect
 * another's, and a client never receives an internal alert.
 */
import { execSync } from "node:child_process";

const API = process.env.API_URL ?? "http://127.0.0.1:3000";
const SUPABASE = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d: String(d) });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

const db1 = (sql) =>
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  })
    .split("\n")[0]
    .trim();

const dbAll = (sql) =>
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
    input: sql,
    encoding: "utf8",
  })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const login = async (email) => {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await r.json()).access_token;
};

const api = async (path, token, options = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
};

const owner = await login("owner@demo.test");
const am = await login("am@demo.test");
const writer = await login("writer@demo.test");
const client = await login("client@demo.test");

const orgId = db1(`select id from public.organizations where slug = 'demo-agency'`);
const ownerId = db1(`select id from public.profiles where email = 'owner@demo.test'`);
const amId = db1(`select id from public.profiles where email = 'am@demo.test'`);

// ===========================================================================
console.log("\n1. the API can list, count, read and mark");
// ===========================================================================
{
  // Seed a notification through the same RPC the jobs use.
  db1(`select public.emit_notification_rpc(
           '${orgId}', '${ownerId}', 'anchor_alert',
           '{"campaignName":"Test Campaign","category":"exact_match","kind":"above_max","share":0.42,"threshold":0.2,"message":"exact match anchors are 42.0%, above the 20.0% limit","link":"/anchors"}'::jsonb,
           'nottest:${Date.now()}')`);

  const list = await api("/api/v1/notifications", owner);
  check("GET /notifications returns 200", list.status === 200, String(list.status));
  check("the payload has a notifications array", Array.isArray(list.body?.data?.notifications));
  check("the payload has an unreadCount", typeof list.body?.data?.unreadCount === "number");

  const count = await api("/api/v1/notifications/unread-count", owner);
  check("GET /unread-count returns 200", count.status === 200, String(count.status));
  check("the count is a number", typeof count.body?.data?.unreadCount === "number", String(count.body?.data?.unreadCount));

  const target = (list.body?.data?.notifications ?? []).find((n) => !n.read_at);
  check("there is an unread notification to work with", Boolean(target));

  if (target) {
    const mark = await api(`/api/v1/notifications/${target.id}/read`, owner, { method: "PATCH" });
    // 204 No Content: the action is complete and there is nothing to return.
    check("PATCH /:id/read succeeds", mark.status === 204 || mark.status === 200, String(mark.status));

    const after = await api("/api/v1/notifications/unread-count", owner);
    const before = count.body?.data?.unreadCount ?? 0;
    check(
      "the unread count decreased by one",
      after.body?.data?.unreadCount === before - 1,
      `${before} → ${after.body?.data?.unreadCount}`,
    );

    const row = db1(`select read_at is not null from public.notifications where id = '${target.id}'`);
    check("read_at is set in the database", row === "t", row);

    // Idempotent: marking twice is not an error.
    const again = await api(`/api/v1/notifications/${target.id}/read`, owner, { method: "PATCH" });
    check(
      "marking an already-read notification succeeds",
      again.status === 204 || again.status === 200,
      String(again.status),
    );
  }

  const readAll = await api("/api/v1/notifications/read-all", owner, { method: "POST" });
  check("POST /read-all returns 200", readAll.status === 200, String(readAll.status));

  const zero = await api("/api/v1/notifications/unread-count", owner);
  check("after read-all the count is zero", zero.body?.data?.unreadCount === 0, String(zero.body?.data?.unreadCount));
}

// ===========================================================================
console.log("\n2. dedupe: one unresolved alert, one notification");
// ===========================================================================
{
  const key = `dedupe-test:${Date.now()}`;

  const insert = () =>
    db1(`select coalesce(public.emit_notification_rpc(
             '${orgId}', '${ownerId}', 'anchor_alert',
             '{"message":"dedupe probe","link":"/anchors"}'::jsonb, '${key}')::text, 'NULL')`);

  const first = insert();
  check("the first emit returns an id", first !== "NULL" && first.length > 10, first);

  const second = insert();
  check("a duplicate unread emit is suppressed (returns NULL)", second === "NULL", second);

  const third = insert();
  check("and stays suppressed on a third attempt", third === "NULL", third);

  const rows = db1(`select count(*) from public.notifications where dedupe_key = '${key}'`);
  check("exactly one row exists for the dedupe key", rows === "1", rows);

  // Acknowledging it frees the slot — the alert can recur.
  db1(`update public.notifications set read_at = now() where dedupe_key = '${key}'`);
  const fourth = insert();
  check("after marking read, the same alert can be raised again", fourth !== "NULL" && fourth.length > 10, fourth);

  const total = db1(`select count(*) from public.notifications where dedupe_key = '${key}'`);
  check("there are now two rows: the resolved one and the new one", total === "2", total);
}

// ===========================================================================
console.log("\n3. distinct conditions do not share a dedupe key");
// ===========================================================================
{
  const scope = db1(`select id from public.campaigns limit 1`);
  const base = Date.now();

  // Different categories -> different notifications, even while unresolved.
  db1(`select public.emit_notification_rpc('${orgId}', '${ownerId}', 'anchor_alert',
         '{"message":"exact"}'::jsonb, 'anchor_alert:${scope}:exact_match:above_max:${base}')`);
  db1(`select public.emit_notification_rpc('${orgId}', '${ownerId}', 'anchor_alert',
         '{"message":"partial"}'::jsonb, 'anchor_alert:${scope}:partial_match:above_max:${base}')`);

  const two = db1(`select count(*) from public.notifications where dedupe_key like 'anchor_alert:${scope}:%:${base}'`);
  check("two categories produce two notifications", two === "2", two);

  // Above-max and below-min are distinct conditions.
  db1(`select public.emit_notification_rpc('${orgId}', '${ownerId}', 'anchor_alert',
         '{"message":"too low"}'::jsonb, 'anchor_alert:${scope}:branded:below_min:${base}')`);
  const three = db1(`select count(*) from public.notifications where dedupe_key like 'anchor_alert:${scope}:%:${base}'`);
  check("above_max and below_min are separate notifications", three === "3", three);
}

// ===========================================================================
console.log("\n4. isolation between users");
// ===========================================================================
{
  const key = `isolation:${Date.now()}`;
  db1(`select public.emit_notification_rpc('${orgId}', '${amId}', 'anchor_alert',
         '{"message":"for the AM only"}'::jsonb, '${key}')`);

  const amList = await api("/api/v1/notifications", am);
  const amIds = (amList.body?.data?.notifications ?? []).map((n) => n.id);
  const amRow = dbAll(`select id from public.notifications where dedupe_key = '${key}'`)[0];

  check("the AM sees their notification", amIds.includes(amRow));

  const ownerList = await api("/api/v1/notifications", owner);
  const ownerIds = (ownerList.body?.data?.notifications ?? []).map((n) => n.id);
  check("the owner does NOT see the AM's notification", !ownerIds.includes(amRow));

  // The owner cannot mark someone else's notification read.
  const steal = await api(`/api/v1/notifications/${amRow}/read`, owner, { method: "PATCH" });
  const stillUnread = db1(`select read_at is null from public.notifications where id = '${amRow}'`);
  check(
    "another user cannot mark a notification read",
    steal.status === 404 || stillUnread === "t",
    `${steal.status}, still unread: ${stillUnread}`,
  );
}

// ===========================================================================
console.log("\n5. clients receive no internal notifications");
// ===========================================================================
{
  const clientId = db1(`select id from public.profiles where email = 'client@demo.test'`);

  const clientCount = db1(`select count(*) from public.notifications where user_id = '${clientId}'`);
  check("the client has no notifications from internal jobs", clientCount === "0", clientCount);

  // And the recipient rule excludes them by construction.
  const recipients = dbAll(`select role from public.profiles where organization_id = '${orgId}' and is_active and role in ('owner','account_manager')`);
  check("only owner and account_manager are recipients", recipients.length === 2 && recipients.every((r) => ["owner", "account_manager"].includes(r)), recipients.join(", "));

  // Even a seeded notification is unreachable: the surface rejects the token.
  const attempt = await api("/api/v1/notifications", client);
  check("a client cannot call the notifications API", attempt.status === 403, String(attempt.status));
}

// ===========================================================================
console.log("\n6. a notification payload carries no financial data");
// ===========================================================================
{
  const list = await api("/api/v1/notifications", am);
  const all = JSON.stringify(list.body?.data?.notifications ?? []);
  check("no cost in any payload", !/cost/i.test(all));
  check("no margin in any payload", !/margin/i.test(all));
  check("no supplier identity in any payload", !/supplier/i.test(all));
  check("no client rate in any payload", !/rate/i.test(all));
}

// ===========================================================================
console.log("\n7. the writer cannot mint notifications");
// ===========================================================================
{
  const wPerms = await api("/api/v1/me/permissions", writer);
  const held = new Set(wPerms.body?.data?.permissions ?? []);
  check("a writer has no notification-write permission", !held.has("notifications:write"));

  // The RPC is service_role only; a user session cannot execute it.
  const rpcAttempt = await fetch(`${SUPABASE}/rest/v1/rpc/emit_notification_rpc`, {
    method: "POST",
    headers: {
      apikey: ANON,
      authorization: `Bearer ${writer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      p_org: orgId,
      p_user: db1(`select id from public.profiles where email = 'writer@demo.test'`),
      p_type: "forged",
      p_payload: { message: "forged" },
      p_dedupe_key: `forged:${Date.now()}`,
    }),
  });
  check(
    "a user session cannot execute emit_notification_rpc",
    rpcAttempt.status === 401 || rpcAttempt.status === 403 || rpcAttempt.status === 404,
    String(rpcAttempt.status),
  );

  const forged = db1(`select count(*) from public.notifications where type = 'forged'`);
  check("no forged notification was created", forged === "0", forged);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
