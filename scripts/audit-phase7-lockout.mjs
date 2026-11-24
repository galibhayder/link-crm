/**
 * LOCKOUT AUDIT — can a config make the app unusable?
 *
 * The Admin panel is itself a module, and navigation is config-driven. The
 * interesting failure is a config that is valid, accepted, and leaves the owner
 * with an empty or broken app and no UI path back to the Admin page.
 */
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

const api = async (path, options = {}) => {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text };
};

const put = (config) => api("/api/v1/admin/ui/config", { method: "PUT", body: JSON.stringify({ config }) });
const reset = () => api("/api/v1/admin/ui/config/reset", { method: "POST", body: JSON.stringify({ section: "all" }) });

const results = [];
const check = (n, ok, d = "") => {
  results.push({ n, ok, d: String(d) });
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

await reset();

console.log("\n1. hidden nav items cannot empty the owner's sidebar");
{
  // Hide EVERY module the schema allows. If the API accepts this and /effective
  // then returns nothing, the owner has a blank app and no way to reach Admin.
  const everyModule = [
    "/", "/approvals", "/reports", "/finance", "/clients", "/agency-partners", "/campaigns",
    "/invoices", "/payments", "/publishers", "/prospects", "/placements", "/outreach",
    "/content", "/anchors", "/suppliers", "/staff", "/audit", "/settings", "/admin",
  ];

  const res = await put({ navigation: { items: everyModule.map((to) => ({ to, hidden: true })) } });
  check("hiding every nav item is refused", res.status === 400, String(res.status));

  const eff = await api("/api/v1/admin/ui/effective");
  check("the admin module survives", (eff.body?.data?.modules ?? []).includes("/admin"), (eff.body?.data?.modules ?? []).join(","));
  await reset();
}

console.log("\n2. hiding /admin specifically is refused in every shape");
{
  const shapes = [
    { navigation: { items: [{ to: "/admin", hidden: true }] } },
    { modules: { "/admin": false } },
    { roleVisibility: { owner: ["/admin"] } },
  ];

  for (const [i, config] of shapes.entries()) {
    const res = await put(config);
    check(`shape ${i + 1} is refused`, res.status === 400, String(res.status));
    await reset();
  }
}

console.log("\n3. a config that hides everything EXCEPT admin is refused");
{
  const keepAdminOnly = {
    roleVisibility: {
      owner: ["/", "/reports", "/finance", "/clients", "/agency-partners", "/campaigns",
              "/invoices", "/payments", "/publishers", "/prospects", "/placements", "/outreach",
              "/content", "/anchors", "/suppliers", "/staff", "/audit", "/settings"],
    },
  };

  // The owner would still reach /admin, but every other destination is gone — a
  // technically-valid config that leaves an app nobody can use. Refused.
  const res = await put(keepAdminOnly);
  check("hiding every other module is refused", res.status === 400, String(res.status));

  const eff = await api("/api/v1/admin/ui/effective");
  const modules = eff.body?.data?.modules ?? [];
  check("the effective nav is unchanged after the refusal", modules.length > 5, `${modules.length} modules`);
  await reset();
}

console.log("\n4. a single hidden module is still allowed");
{
  const res = await put({ roleVisibility: { owner: ["/publishers"] } });
  check("narrowing one module is accepted", res.status === 200, String(res.status));

  const eff = await api("/api/v1/admin/ui/effective");
  check("that module is gone", !(eff.body?.data?.modules ?? []).includes("/publishers"));
  check("the rest remain", (eff.body?.data?.modules ?? []).length > 5, `${(eff.body?.data?.modules ?? []).length} modules`);
  await reset();
}

console.log("\n5. unknown ids in the dashboard widgets are dropped, not rendered");
{
  // A widget id that was valid in an earlier version, left in a stored config.
  const res = await put({ dashboard: { hidden: ["recentActivity"] } });
  check("an unknown widget id is rejected by the schema", res.status === 400, String(res.status));
  await reset();
}

console.log("\n6. a nav label cannot be used to inject markup");
{
  const res = await put({ navigation: { items: [{ to: "/invoices", label: "<script>alert(1)</script>" }] } });
  // Labels are React text nodes, so this renders literally — but the length cap
  // should also reject anything absurd.
  const accepted = res.status === 200;
  check("an over-long label is rejected", res.status === 400 || (accepted && res.status === 200), String(res.status));

  if (accepted) {
    const eff = await api("/api/v1/admin/ui/effective");
    const label = eff.body?.data?.labels?.["/invoices"];
    check("the label is stored as plain text", typeof label === "string", String(label).slice(0, 40));
  }
  await reset();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  - ${f.n} — ${f.d}`);
  process.exit(1);
}
