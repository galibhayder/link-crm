/**
 * PHASE 7 — SECURITY AUDIT: CUSTOMIZATION MUST NEVER WIDEN ACCESS.
 *
 * The whole feature rests on one claim: an Admin can hide and rename, never
 * grant. This script attacks that claim against the running API.
 *
 * It is deliberately adversarial. A test that checks "a valid config is accepted"
 * proves the happy path; these checks try to turn customization into privilege
 * escalation and assert every attempt fails.
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
  prospector: await login("prospector@demo.test"),
  client: await login("client@demo.test"),
};

const putConfig = (config, token = T.owner) =>
  api("/api/v1/admin/ui/config", token, { method: "PUT", body: JSON.stringify({ config }) });

const resetConfig = () => api("/api/v1/admin/ui/config/reset", T.owner, { method: "POST", body: JSON.stringify({ section: "all" }) });

// Start from a known state.
await resetConfig();

// ===========================================================================
console.log("\n1. only the owner may write a config");
// ===========================================================================
{
  for (const [label, token] of [
    ["account_manager", T.am],
    ["content_writer", T.writer],
    ["prospector", T.prospector],
    ["client_user", T.client],
  ]) {
    const res = await putConfig({ branding: { appName: "Hijacked" } }, token);
    check(`${label} cannot write the UI config`, res.status === 403, String(res.status));
  }

  const owner = await putConfig({ branding: { appName: "Trivero Marketing" } });
  check("the owner CAN write the UI config", owner.status === 200, String(owner.status));
}

// ===========================================================================
console.log("\n2. the config cannot name things that do not exist");
// ===========================================================================
{
  const unknownModule = await putConfig({ modules: { "/totally-made-up": true } });
  check("an unknown module id is rejected", unknownModule.status === 400, String(unknownModule.status));

  const unknownRoute = await putConfig({ navigation: { items: [{ to: "/secret-admin" }] } });
  check("an invented nav route is rejected", unknownRoute.status === 400, String(unknownRoute.status));

  const unknownColumn = await putConfig({ tables: { "/invoices": { columns: ["password_hash"] } } });
  check("an unknown column is rejected", unknownColumn.status === 400, String(unknownColumn.status));

  const borrowedColumn = await putConfig({ tables: { "/invoices": { columns: ["dr"] } } });
  check("a column from another module is rejected", borrowedColumn.status === 400, String(borrowedColumn.status));

  const unknownWidget = await putConfig({ dashboard: { order: ["notAWidget"] } });
  check("an unknown dashboard widget is rejected", unknownWidget.status === 400, String(unknownWidget.status));

  const unknownKey = await putConfig({ grantEverything: true });
  check("an unknown top-level key is rejected (strict schema)", unknownKey.status === 400, String(unknownKey.status));

  const smuggledSql = await putConfig({ theme: { accent: "#112233", ddl: "drop table invoices" } });
  check("a smuggled SQL key is rejected", smuggledSql.status === 400, String(smuggledSql.status));

  const badColour = await putConfig({ theme: { accent: "javascript:alert(1)" } });
  check("a non-hex colour is rejected", badColour.status === 400, String(badColour.status));
}

// ===========================================================================
console.log("\n3. the config cannot widen access");
// ===========================================================================
{
  // Attempt: mark every module enabled. Because `true` means "not disabled" and
  // RBAC is applied first, this must change nothing — a writer still cannot reach
  // finance.
  const allOn = await putConfig({
    modules: Object.fromEntries(
      [
        "/",
        "/approvals",
        "/reports",
        "/finance",
        "/clients",
        "/agency-partners",
        "/campaigns",
        "/invoices",
        "/payments",
        "/publishers",
        "/prospects",
        "/placements",
        "/outreach",
        "/content",
        "/anchors",
        "/suppliers",
        "/staff",
        "/audit",
        "/settings",
        "/admin",
      ].map((m) => [m, true]),
    ),
  });
  check("marking every module enabled is accepted (it is a no-op, not a grant)", allOn.status === 200, String(allOn.status));

  // The decisive check: what does a WRITER actually see?
  const writerEffective = await api("/api/v1/admin/ui/effective", T.writer);
  check("a writer can read their effective nav", writerEffective.status === 200, String(writerEffective.status));

  const writerModules = writerEffective.body?.data?.modules ?? [];
  check("a writer still cannot see /finance", !writerModules.includes("/finance"), writerModules.join(","));
  check("a writer still cannot see /staff", !writerModules.includes("/staff"));
  check("a writer still cannot see /settings", !writerModules.includes("/settings"));
  check("a writer still cannot see /admin", !writerModules.includes("/admin"));
  check("a writer keeps the modules RBAC gives them", writerModules.includes("/content"), writerModules.join(","));

  // And the route itself is still refused, regardless of what the nav says.
  const writerFinance = await api("/api/v1/reports/financial", T.writer);
  check("a writer calling the finance API is still refused", writerFinance.status === 403, String(writerFinance.status));

  // Attempt: hide everything from the owner and see whether that leaks anything
  // to anyone. Hiding is safe, but it must actually work.
  const hideFromAll = await putConfig({
    roleVisibility: { content_writer: ["/content"], owner: ["/finance"] },
  });
  check("narrowing a role is accepted", hideFromAll.status === 200, String(hideFromAll.status));

  const ownerEffective = await api("/api/v1/admin/ui/effective", T.owner);
  check(
    "the owner's hidden module is gone from their nav",
    !(ownerEffective.body?.data?.modules ?? []).includes("/finance"),
  );
  // The API is unaffected by a nav preference — this is the important half.
  const ownerFinance = await api("/api/v1/reports/financial", T.owner);
  check(
    "but hiding a nav item does NOT revoke the API permission",
    ownerFinance.status === 200,
    String(ownerFinance.status),
  );
}

// ===========================================================================
console.log("\n4. the admin panel cannot lock itself out");
// ===========================================================================
{
  const disableAdmin = await putConfig({ modules: { "/admin": false } });
  check("disabling the Admin module is refused", disableAdmin.status === 400, String(disableAdmin.status));

  const hideAdmin = await putConfig({ roleVisibility: { owner: ["/admin"] } });
  check("hiding Admin from the owner is refused", hideAdmin.status === 400, String(hideAdmin.status));

  // THE THIRD SHAPE. The first version of the guard checked only the two above,
  // and `navigation.items[].hidden` slipped through: an admin could hide every nav
  // item, the API accepted it, and the owner was left with a blank sidebar and no
  // UI route back to the page that could undo it.
  const hideNavItem = await putConfig({ navigation: { items: [{ to: "/admin", hidden: true }] } });
  check(
    "hiding Admin from the navigation is refused",
    hideNavItem.status === 400,
    String(hideNavItem.status),
  );

  // Hiding EVERY item is the same lockout by a different route.
  const everyModule = [
    "/", "/approvals", "/reports", "/finance", "/clients", "/agency-partners", "/campaigns",
    "/invoices", "/payments", "/publishers", "/prospects", "/placements", "/outreach",
    "/content", "/anchors", "/suppliers", "/staff", "/audit", "/settings", "/admin",
  ];
  const hideAll = await putConfig({ navigation: { items: everyModule.map((to) => ({ to, hidden: true })) } });
  check("hiding every nav item is refused", hideAll.status === 400, String(hideAll.status));

  // Leaving only one or two modules is technically usable and practically a
  // lockout, so a floor applies.
  const nearlyEmpty = await putConfig({
    roleVisibility: {
      owner: ["/", "/reports", "/finance", "/clients", "/agency-partners", "/campaigns",
              "/invoices", "/payments", "/publishers", "/prospects", "/placements", "/outreach",
              "/content", "/anchors", "/suppliers", "/staff", "/audit", "/settings"],
    },
  });
  check("leaving fewer than three modules is refused", nearlyEmpty.status === 400, String(nearlyEmpty.status));

  // A reasonable narrowing is still allowed — the floor must not make the feature
  // unusable.
  const reasonable = await putConfig({ roleVisibility: { owner: ["/publishers", "/prospects"] } });
  check("a reasonable narrowing is still accepted", reasonable.status === 200, String(reasonable.status));

  const eff = await api("/api/v1/admin/ui/effective", T.owner);
  check("the admin module survives every attempt", (eff.body?.data?.modules ?? []).includes("/admin"));

  await resetConfig();
}

// ===========================================================================
console.log("\n5. a client cannot reach the admin surface at all");
// ===========================================================================
{
  const cfg = await api("/api/v1/admin/ui/config", T.client);
  check("a client cannot read the config", cfg.status === 403, String(cfg.status));

  const eff = await api("/api/v1/admin/ui/effective", T.client);
  check("a client cannot read the effective nav", eff.status === 403, String(eff.status));

  const reg = await api("/api/v1/admin/ui/registries", T.client);
  check("a client cannot read the registries", reg.status === 403, String(reg.status));

  const reset = await api("/api/v1/admin/ui/config/reset", T.client, { method: "POST", body: "{}" });
  check("a client cannot reset the config", reset.status === 403, String(reset.status));
}

// ===========================================================================
console.log("\n6. the config cannot execute SQL");
// ===========================================================================
{
  // There is no endpoint that accepts SQL. This asserts that no plausible shape
  // is quietly persisted either.
  const attempts = [
    { theme: { accent: "#112233" }, raw: "drop table invoices" },
    { modules: {}, sql: "select 1" },
    { tables: { "/invoices": { columns: ["invoice_number"], where: "1=1" } } },
    { navigation: { sections: [{ id: "clients", label: "x", query: "truncate" }] } },
  ];

  for (const body of attempts) {
    const res = await putConfig(body);
    check(`an SQL-shaped key is rejected: ${Object.keys(body).join(",")}`, res.status === 400, String(res.status));
  }

  // And the tables are all still there.
  const list = await api("/api/v1/invoices?limit=1", T.owner);
  check("the invoices table still exists after the attempts", list.status === 200, String(list.status));
}

// ===========================================================================
console.log("\n7. a bad stored config cannot break the app");
// ===========================================================================
{
  // Write a valid config, then corrupt the row directly in the database — the
  // path an older schema or a manual edit would take. The API must serve
  // defaults rather than propagate something invalid to the client.
  const { execSync } = await import("node:child_process");
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -v ON_ERROR_STOP=1`, {
    input: `update public.ui_settings set config = '{"modules": {"/evil": true}}'::jsonb
            where organization_id = (select id from organizations where slug = 'demo-agency');`,
    encoding: "utf8",
  });

  const eff = await api("/api/v1/admin/ui/effective", T.owner);
  check("a corrupted stored config still serves a response", eff.status === 200, String(eff.status));
  check("it reports the stored config as invalid", eff.body?.data?.valid === false, String(eff.body?.data?.valid));
  check(
    "and falls back to defaults rather than the bad document",
    !(eff.body?.data?.modules ?? []).includes("/evil"),
    (eff.body?.data?.modules ?? []).join(","),
  );

  const cfg = await api("/api/v1/admin/ui/config", T.owner);
  check("the admin editor is told the config is invalid", cfg.body?.data?.valid === false);
}

// Restore a clean state for the following suites.
await resetConfig();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
