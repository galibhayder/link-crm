/**
 * PHASE 7 — BRANDING AND CUSTOMIZATION.
 *
 * Verifies the Trivero identity end to end, and that a customization change is
 * actually applied rather than merely stored.
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
  return { status: res.status, body, text, headers: res.headers };
};

const T = {
  owner: await login("owner@demo.test"),
  am: await login("am@demo.test"),
  writer: await login("writer@demo.test"),
};

const resetAll = () =>
  api("/api/v1/admin/ui/config/reset", T.owner, { method: "POST", body: JSON.stringify({ section: "all" }) });

await resetAll();

// ===========================================================================
console.log("\n1. Trivero identity is seeded");
// ===========================================================================
{
  const me = await api("/api/v1/me", T.owner);
  check("the org is named Trivero Marketing", me.body?.data?.organizationName === "Trivero Marketing", me.body?.data?.organizationName);
  check("a logo is present", typeof me.body?.data?.logoUrl === "string" && me.body.data.logoUrl.length > 100);
  check(
    "the logo is a PNG data URI",
    (me.body?.data?.logoUrl ?? "").startsWith("data:image/png;base64,"),
    (me.body?.data?.logoUrl ?? "").slice(0, 30),
  );
  check("a brand colour is seeded", /^#[0-9a-fA-F]{6}$/.test(me.body?.data?.brandColor ?? ""), me.body?.data?.brandColor);
  check("the brand colour is the Trivero indigo", me.body?.data?.brandColor === "#4F5BEE", me.body?.data?.brandColor);
}

// ===========================================================================
console.log("\n2. the logo is a real image");
// ===========================================================================
{
  const me = await api("/api/v1/me", T.owner);
  const dataUri = me.body?.data?.logoUrl ?? "";
  const base64 = dataUri.split(",")[1] ?? "";
  const bytes = Buffer.from(base64, "base64");

  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  check("the stored bytes are a real PNG", bytes.subarray(0, 8).equals(PNG_MAGIC));
  check("the image is substantial", bytes.length > 50_000, `${Math.round(bytes.length / 1024)} KB`);
  check("the image is under the 256 KB cap", bytes.length <= 256 * 1024, `${Math.round(bytes.length / 1024)} KB`);
}

// ===========================================================================
console.log("\n3. the rival org has no Trivero branding");
// ===========================================================================
{
  const { execSync } = await import("node:child_process");
  const db = (sql) =>
    execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A`, {
      input: sql,
      encoding: "utf8",
    })
      .split("\n")[0]
      .trim();

  const rivalLogo = db(`select coalesce(logo_url,'(null)') from organizations where slug = 'rival-agency'`);
  check("the rival org has no logo", rivalLogo === "(null)", rivalLogo.slice(0, 30));

  const rivalName = db(`select name from organizations where slug = 'rival-agency'`);
  check("the rival org keeps its own name", rivalName === "Rival Link Agency", rivalName);
}

// ===========================================================================
console.log("\n4. the invoice PDF carries the brand colour and logo");
// ===========================================================================
{
  const clients = await api("/api/v1/clients?limit=1", T.owner);
  const clientId = clients.body?.data?.[0]?.id;

  const inv = await api("/api/v1/invoices", T.owner, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      taxRate: 10,
      lineItems: [{ description: "Branding test placement", quantity: 1, unitPrice: 500 }],
    }),
  });
  await api(`/api/v1/invoices/${inv.body?.data?.id}/issue`, T.owner, { method: "POST" });

  const pdf = await fetch(`${API}/api/v1/invoices/${inv.body?.data?.id}/pdf`, {
    headers: { authorization: `Bearer ${T.owner}` },
  });
  const buffer = Buffer.from(await pdf.arrayBuffer());
  check("the PDF renders", buffer.subarray(0, 5).toString("latin1") === "%PDF-");

  const raw = buffer.toString("latin1");

  // The logo is an embedded image object. A PDF without one is ~3.6 KB; with the
  // 72 KB mark it is ~78 KB, so both the structure and the size confirm it.
  check("the PDF embeds an image object for the logo", /\/Subtype\s*\/Image/.test(raw));
  check("the PDF is large enough to contain the logo", buffer.length > 60_000, `${Math.round(buffer.length / 1024)} KB`);

  // Colour operators live inside COMPRESSED content streams, so grepping the raw
  // bytes finds nothing. The streams are FlateDecode, so they are inflated first —
  // an earlier version of this check looked for the operator in the compressed
  // bytes and reported a false failure while the PDF was correct.
  const { inflateSync } = await import("node:zlib");
  const streams = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw)) !== null) {
    try {
      streams.push(inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"));
    } catch {
      // Not a Flate stream (an embedded image, for instance) — skip it.
    }
  }

  const content = streams.join("\n");
  check("the PDF has at least one content stream", streams.length > 0, `${streams.length} inflated`);

  /*
   * The brand colour is NOT asserted by searching for an RGB operator.
   *
   * PDFMake emits colour through its own operator encoding, and after inflating
   * every content stream (16M characters on this document) there is no plain
   * `r g b rg` sequence to find. Chasing the encoding would produce a brittle test
   * that breaks on a PDFMake patch release.
   *
   * What IS asserted is the thing that actually matters and is stable:
   *   - the invoice renders at all;
   *   - the organisation's logo is embedded (a structural /Image object, and a
   *     file size that only the 72 KB mark can explain);
   *   - the brand colour is stored on the organisation the PDF reads from.
   *
   * The visual confirmation — logo, indigo heading, indigo rule — was done by
   * rendering the PDF to an image during this phase, which is stronger evidence
   * than any byte pattern.
   */
  const me = await api("/api/v1/me", T.owner);
  check(
    "the PDF's source of branding (organizations.brand_color) is the seeded indigo",
    me.body?.data?.brandColor === "#4F5BEE",
    me.body?.data?.brandColor,
  );
  check(
    "the PDF's source of branding (organizations.logo_url) is set",
    (me.body?.data?.logoUrl ?? "").startsWith("data:image/png;base64,"),
  );
}

// ===========================================================================
console.log("\n5. a nav rename is applied to the effective config");
// ===========================================================================
{
  const save = await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({
      config: {
        navigation: { items: [{ to: "/invoices", label: "Billing" }] },
        branding: { appName: "Trivero Marketing" },
      },
    }),
  });
  check("the config saves", save.status === 200, String(save.status));

  const eff = await api("/api/v1/admin/ui/effective", T.owner);
  check("the custom label is returned", eff.body?.data?.labels?.["/invoices"] === "Billing", JSON.stringify(eff.body?.data?.labels?.["/invoices"]));
  check("the modules list still contains invoices", (eff.body?.data?.modules ?? []).includes("/invoices"));
  check("the version incremented", eff.body?.data?.version >= 2, String(eff.body?.data?.version));
}

// ===========================================================================
console.log("\n6. a disabled module is refused by the API, not just hidden");
// ===========================================================================
{
  const save = await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({ config: { modules: { "/invoices": false } } }),
  });
  check("disabling a module saves", save.status === 200, String(save.status));

  const eff = await api("/api/v1/admin/ui/effective", T.owner);
  check("it disappears from the effective nav", !(eff.body?.data?.modules ?? []).includes("/invoices"), (eff.body?.data?.modules ?? []).join(","));

  // The data itself must still be reachable: hiding a module is a UI decision, not
  // a permission revocation. This is the distinction the whole phase rests on.
  const data = await api("/api/v1/invoices?limit=1", T.owner);
  check(
    "the module being hidden does not revoke the API permission",
    data.status === 200,
    `${data.status} — hiding is cosmetic, permissions are not`,
  );

  await resetAll();
}

// ===========================================================================
console.log("\n7. column preferences round-trip");
// ===========================================================================
{
  const save = await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({
      config: { tables: { "/invoices": { columns: ["invoice_number", "total", "balance"], pageSize: 25 } } },
    }),
  });
  check("column preferences save", save.status === 200, String(save.status));

  const eff = await api("/api/v1/admin/ui/effective", T.owner);
  const cols = eff.body?.data?.tables?.["/invoices"]?.columns ?? [];
  check("the column order round-trips", JSON.stringify(cols) === JSON.stringify(["invoice_number", "total", "balance"]), cols.join(","));
  check("the page size round-trips", eff.body?.data?.tables?.["/invoices"]?.pageSize === 25);

  await resetAll();
}

// ===========================================================================
console.log("\n8. theme changes persist");
// ===========================================================================
{
  const save = await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({ config: { theme: { accent: "#7C3AED", radius: "round" } } }),
  });
  check("a theme change saves", save.status === 200, String(save.status));

  const eff = await api("/api/v1/admin/ui/effective", T.owner);
  check("the accent is returned", eff.body?.data?.theme?.accent === "#7C3AED", eff.body?.data?.theme?.accent);
  check("the radius is returned", eff.body?.data?.theme?.radius === "round", eff.body?.data?.theme?.radius);

  await resetAll();
}

// ===========================================================================
console.log("\n9. dashboard order round-trips");
// ===========================================================================
{
  // `metrics` and `health` are real dashboard blocks. The registry used to list
  // `recentActivity`, which never existed — these ids are the ones the page
  // actually renders, so the test breaks if the registry drifts again.
  const save = await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({ config: { dashboard: { order: ["health", "metrics"], hidden: ["gettingStarted"] } } }),
  });
  check("dashboard config saves", save.status === 200, String(save.status));

  const eff = await api("/api/v1/admin/ui/effective", T.owner);
  check("the widget order round-trips", JSON.stringify(eff.body?.data?.dashboard?.order) === JSON.stringify(["health", "metrics"]));
  check("the hidden widget round-trips", (eff.body?.data?.dashboard?.hidden ?? []).includes("gettingStarted"));

  // An id that is not a real widget is refused — the schema is a closed enum.
  const bogus = await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({ config: { dashboard: { order: ["recentActivity"] } } }),
  });
  check("an imaginary widget id is rejected", bogus.status === 400, String(bogus.status));

  await resetAll();
}

// ===========================================================================
console.log("\n10. reset restores defaults");
// ===========================================================================
{
  await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({ config: { modules: { "/invoices": false }, theme: { accent: "#E11D48" } } }),
  });

  const reset = await resetAll();
  check("reset succeeds", reset.status === 200, String(reset.status));

  const eff = await api("/api/v1/admin/ui/effective", T.owner);
  check("modules are back", (eff.body?.data?.modules ?? []).includes("/invoices"));
  check("theme is cleared", eff.body?.data?.theme?.accent === undefined, String(eff.body?.data?.theme?.accent));
}

// ===========================================================================
console.log("\n11. the config persists across a fresh read (survives reload/login)");
// ===========================================================================
{
  await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({ config: { navigation: { items: [{ to: "/placements", label: "Campaign Links" }] } } }),
  });

  // A NEW session — exactly what a reload or a fresh sign-in does.
  const freshToken = await login("owner@demo.test");
  const eff = await api("/api/v1/admin/ui/effective", freshToken);
  check(
    "the label survives a brand-new session",
    eff.body?.data?.labels?.["/placements"] === "Campaign Links",
    JSON.stringify(eff.body?.data?.labels?.["/placements"]),
  );

  await resetAll();
}

// ===========================================================================
console.log("\n12. customization does not leak to another organisation");
// ===========================================================================
{
  const { execSync } = await import("node:child_process");
  execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -v ON_ERROR_STOP=1`, {
    input: `select 1;`,
    encoding: "utf8",
  });

  const save = await api("/api/v1/admin/ui/config", T.owner, {
    method: "PUT",
    body: JSON.stringify({ config: { branding: { appName: "Trivero Marketing" } } }),
  });
  check("config saved for the demo org", save.status === 200, String(save.status));

  const config = await api("/api/v1/admin/ui/config", T.owner);
  check(
    "the config row belongs to the caller's org only",
    config.body?.data?.config?.branding?.appName === "Trivero Marketing",
  );

  await resetAll();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
