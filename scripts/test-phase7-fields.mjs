/**
 * PHASE 7 — CUSTOM FIELDS, SAVED VIEWS, NOTIFICATION PREFERENCES.
 *
 * These three share one property worth attacking: each is scoped to a user or an
 * organisation, and the interesting failure is one person reaching another's data.
 */
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

const login = async (email) => {
  const r = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const b = await r.json();
  if (!b.access_token) throw new Error(`login failed: ${email}`);
  return b.access_token;
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

const T = {
  owner: await login("owner@demo.test"),
  am: await login("am@demo.test"),
  writer: await login("writer@demo.test"),
};

const stamp = Date.now();

// ===========================================================================
console.log("\n1. custom fields — create and validate");
// ===========================================================================
let fieldId;
{
  const create = await api("/api/v1/admin/fields", T.owner, {
    method: "POST",
    body: JSON.stringify({
      entityType: "client",
      key: `test_field_${stamp}`,
      label: "Account tier",
      fieldType: "select",
      options: ["Gold", "Silver", "Bronze"],
    }),
  });
  check("the owner can create a field", create.status === 201, String(create.status));
  fieldId = create.body?.data?.id;
  check("it is returned with an id", Boolean(fieldId));
  check("it is active by default", create.body?.data?.is_active === true);

  // A select with no options cannot be filled in by anyone.
  const noOptions = await api("/api/v1/admin/fields", T.owner, {
    method: "POST",
    body: JSON.stringify({
      entityType: "client",
      key: `bad_select_${stamp}`,
      label: "Broken",
      fieldType: "select",
      options: [],
    }),
  });
  check("a select with no options is rejected", noOptions.status === 400, String(noOptions.status));

  // Options on a text field are meaningless; they must not be stored.
  const textWithOptions = await api("/api/v1/admin/fields", T.owner, {
    method: "POST",
    body: JSON.stringify({
      entityType: "client",
      key: `text_with_opts_${stamp}`,
      label: "Note",
      fieldType: "text",
      options: ["a", "b"],
    }),
  });
  check("options on a text field are accepted but discarded", textWithOptions.status === 201, String(textWithOptions.status));
  check(
    "the stored options are empty for a text field",
    (textWithOptions.body?.data?.options ?? []).length === 0,
    JSON.stringify(textWithOptions.body?.data?.options),
  );

  const badType = await api("/api/v1/admin/fields", T.owner, {
    method: "POST",
    body: JSON.stringify({ entityType: "client", key: `bad_${stamp}`, label: "X", fieldType: "sql" }),
  });
  check("an invalid field type is rejected", badType.status === 400, String(badType.status));

  const badKey = await api("/api/v1/admin/fields", T.owner, {
    method: "POST",
    body: JSON.stringify({ entityType: "client", key: "Has Spaces", label: "X", fieldType: "text" }),
  });
  check("a key with spaces is rejected", badKey.status === 400, String(badKey.status));

  const badEntity = await api("/api/v1/admin/fields", T.owner, {
    method: "POST",
    body: JSON.stringify({ entityType: "invoice", key: `k_${stamp}`, label: "X", fieldType: "text" }),
  });
  check("an unsupported entity type is rejected", badEntity.status === 400, String(badEntity.status));

  const dup = await api("/api/v1/admin/fields", T.owner, {
    method: "POST",
    body: JSON.stringify({
      entityType: "client",
      key: `test_field_${stamp}`,
      label: "Duplicate",
      fieldType: "text",
    }),
  });
  check("a duplicate key for the same entity is refused", dup.status === 409, String(dup.status));
}

// ===========================================================================
console.log("\n2. custom fields — permissions");
// ===========================================================================
{
  for (const [label, token] of [
    ["account_manager", T.am],
    ["content_writer", T.writer],
  ]) {
    const list = await api("/api/v1/admin/fields", token);
    check(`${label} cannot list field definitions`, list.status === 403, String(list.status));

    const create = await api("/api/v1/admin/fields", token, {
      method: "POST",
      body: JSON.stringify({ entityType: "client", key: `x_${stamp}`, label: "X", fieldType: "text" }),
    });
    check(`${label} cannot create a field`, create.status === 403, String(create.status));
  }
}

// ===========================================================================
console.log("\n3. custom fields — deactivate preserves data");
// ===========================================================================
{
  const { execSync } = await import("node:child_process");
  const db = (sql) =>
    execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
      input: sql,
      encoding: "utf8",
    })
      .split("\n")[0]
      .trim();

  const clientId = db(`select id from clients limit 1`);

  // Attach a value, so the "has values" rules engage.
  db(`insert into custom_field_values (organization_id, definition_id, entity_id, client_id, value_text)
      values ((select organization_id from custom_field_definitions where id='${fieldId}'),
              '${fieldId}', '${clientId}', '${clientId}', 'Gold')`);

  const valueCount = db(`select count(*) from custom_field_values where definition_id='${fieldId}'`);
  check("a value is attached", Number(valueCount) === 1, valueCount);

  // Key is immutable once values exist.
  const rename = await api(`/api/v1/admin/fields/${fieldId}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ key: `renamed_${stamp}` }),
  });
  check("the key cannot change while values exist", rename.status === 400, String(rename.status));

  // Type is immutable once values exist.
  const retype = await api(`/api/v1/admin/fields/${fieldId}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ fieldType: "number" }),
  });
  check("the field type cannot change while values exist", retype.status === 400, String(retype.status));

  // Label can change freely.
  const relabel = await api(`/api/v1/admin/fields/${fieldId}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ label: "Account tier (updated)" }),
  });
  check("the label can still be edited", relabel.status === 200, String(relabel.status));

  // Deleting would cascade and destroy the value.
  const del = await api(`/api/v1/admin/fields/${fieldId}`, T.owner, { method: "DELETE" });
  check("deleting a field with values is refused", del.status === 400, String(del.status));
  check(
    "the refusal explains that deactivating preserves data",
    /deactivate/i.test(del.body?.error?.message ?? ""),
    del.body?.error?.message,
  );

  // Deactivating is the safe alternative.
  const deactivate = await api(`/api/v1/admin/fields/${fieldId}`, T.owner, {
    method: "PATCH",
    body: JSON.stringify({ isActive: false }),
  });
  check("the field can be deactivated", deactivate.status === 200, String(deactivate.status));
  check("it reports inactive", deactivate.body?.data?.is_active === false);

  const stillThere = db(`select count(*) from custom_field_values where definition_id='${fieldId}'`);
  check("the value survives deactivation", Number(stillThere) === 1, stillThere);
}

// ===========================================================================
console.log("\n4. saved views — own rows only");
// ===========================================================================
let viewId;
{
  const create = await api("/api/v1/admin/views", T.owner, {
    method: "POST",
    body: JSON.stringify({
      module: "/invoices",
      name: `Overdue ${stamp}`,
      filters: { status: "overdue" },
      sort: { field: "due_date" },
      isDefault: true,
    }),
  });
  check("the owner can create a view", create.status === 201, String(create.status));
  viewId = create.body?.data?.id;
  check("it is marked default", create.body?.data?.is_default === true);

  const own = await api("/api/v1/admin/views?module=/invoices", T.owner);
  check("the owner sees their view", (own.body?.data ?? []).some((v) => v.id === viewId));

  // A second default for the same module replaces the first, rather than failing.
  const second = await api("/api/v1/admin/views", T.owner, {
    method: "POST",
    body: JSON.stringify({ module: "/invoices", name: `Another ${stamp}`, isDefault: true }),
  });
  check("a second default is accepted", second.status === 201, String(second.status));

  const defaults = (await api("/api/v1/admin/views?module=/invoices", T.owner)).body?.data ?? [];
  const defaultCount = defaults.filter((v) => v.is_default).length;
  check("exactly one default remains per module", defaultCount === 1, String(defaultCount));

  // The AM must not see the owner's private views.
  const amViews = await api("/api/v1/admin/views?module=/invoices", T.am);
  check(
    "another user does not see the owner's private views",
    !(amViews.body?.data ?? []).some((v) => v.id === viewId),
    `${(amViews.body?.data ?? []).length} visible`,
  );

  // Nor edit them.
  const steal = await api(`/api/v1/admin/views/${viewId}`, T.am, {
    method: "PATCH",
    body: JSON.stringify({ name: "Hijacked" }),
  });
  check("another user cannot edit the owner's view", steal.status === 404 || steal.status === 403, String(steal.status));

  const stealDelete = await api(`/api/v1/admin/views/${viewId}`, T.am, { method: "DELETE" });
  check("another user cannot delete the owner's view", stealDelete.status === 404 || stealDelete.status === 403, String(stealDelete.status));
}

// ===========================================================================
console.log("\n5. saved views — system views are owner-only");
// ===========================================================================
{
  const amSystem = await api("/api/v1/admin/views", T.am, {
    method: "POST",
    body: JSON.stringify({ module: "/placements", name: "Shared", isSystem: true }),
  });
  check("a non-owner cannot create a system view", amSystem.status === 403, String(amSystem.status));

  const ownerSystem = await api("/api/v1/admin/views", T.owner, {
    method: "POST",
    body: JSON.stringify({ module: "/placements", name: `Org view ${stamp}`, isSystem: true }),
  });
  check("the owner can create a system view", ownerSystem.status === 201, String(ownerSystem.status));
  check("a system view is shared", ownerSystem.body?.data?.is_shared === true);

  // The AM CAN see a system view — it is shared with the organisation.
  const amList = await api("/api/v1/admin/views?module=/placements", T.am);
  check(
    "an ordinary user can read a system view",
    (amList.body?.data ?? []).some((v) => v.is_system),
  );

  // But cannot delete it.
  const del = await api(`/api/v1/admin/views/${ownerSystem.body?.data?.id}`, T.am, { method: "DELETE" });
  check("an ordinary user cannot delete a system view", del.status === 403, String(del.status));
}

// ===========================================================================
console.log("\n6. notification preferences — own row only");
// ===========================================================================
{
  const initial = await api("/api/v1/notifications/preferences", T.owner);
  check("preferences read returns defaults", initial.status === 200, String(initial.status));
  check("no types are muted initially", (initial.body?.data?.mutedTypes ?? []).length === 0);
  check("the available types are listed", (initial.body?.data?.availableTypes ?? []).length === 3);

  const set = await api("/api/v1/notifications/preferences", T.owner, {
    method: "PUT",
    body: JSON.stringify({ mutedTypes: ["anchor_alert"], emailDigest: false }),
  });
  check("preferences can be saved", set.status === 200, String(set.status));
  check("the muted type is stored", (set.body?.data?.muted_types ?? []).includes("anchor_alert"));

  const reread = await api("/api/v1/notifications/preferences", T.owner);
  check("the preference persists", (reread.body?.data?.mutedTypes ?? []).includes("anchor_alert"));

  // A different user's preferences are independent.
  const amPrefs = await api("/api/v1/notifications/preferences", T.am);
  check("another user's preferences are unaffected", (amPrefs.body?.data?.mutedTypes ?? []).length === 0);

  // An unknown type is rejected — the UI cannot invent one that never fires.
  const bogus = await api("/api/v1/notifications/preferences", T.owner, {
    method: "PUT",
    body: JSON.stringify({ mutedTypes: ["not_a_real_type"], emailDigest: false }),
  });
  check("an unknown notification type is rejected", bogus.status === 400, String(bogus.status));

  // Restore.
  await api("/api/v1/notifications/preferences", T.owner, {
    method: "PUT",
    body: JSON.stringify({ mutedTypes: [], emailDigest: false }),
  });
}

// ===========================================================================
console.log("\n7. cleaning up the test field");
// ===========================================================================
{
  const { execSync } = await import("node:child_process");
  const db = (sql) =>
    execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A -v ON_ERROR_STOP=1`, {
      input: sql,
      encoding: "utf8",
    })
      .split("\n")[0]
      .trim();

  // Remove the value, then the definition — proving the delete path works once the
  // data is gone.
  db(`delete from custom_field_values where definition_id='${fieldId}'`);

  const del = await api(`/api/v1/admin/fields/${fieldId}`, T.owner, { method: "DELETE" });
  check("a field with no values can be deleted", del.status === 200, String(del.status));

  const gone = db(`select count(*) from custom_field_definitions where id='${fieldId}'`);
  check("it is gone from the database", gone === "0", gone);

  // Clean up the other test fields by key prefix.
  db(`delete from custom_field_definitions where key like '%${stamp}%'`);
  db(`delete from saved_views where name like '%${stamp}%'`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
