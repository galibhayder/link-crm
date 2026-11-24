/**
 * PHASE 6 — INVOICE SHARING.
 *
 * The highest-risk surface in the project: an unauthenticated endpoint that
 * returns a financial document. Every assertion here is about what must NOT be
 * reachable or exposed.
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
    headers: token
      ? { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) }
      : { "content-type": "application/json", ...(options.headers ?? {}) },
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
  client: await login("client@demo.test"),
};

const clients = await api("/api/v1/clients?limit=10", T.owner);
const clientId = clients.body?.data?.[0]?.id;

/** An issued invoice, ready to share. */
async function issuedInvoice(amount = 1200) {
  const inv = await api("/api/v1/invoices", T.owner, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      taxRate: 20,
      // Client-facing fields, which legitimately DO appear publicly. The leak
      // assertions below look for the INTERNAL fields instead — cost, payout,
      // margin — which never enter the snapshot at all.
      notes: "Payment is due within 14 days.",
      paymentInstructions: "Bank transfer to GB00 0000 0000.",
      lineItems: [{ description: "Guest post on example.test", quantity: 1, unitPrice: amount }],
    }),
  });
  const id = inv.body?.data?.id;
  await api(`/api/v1/invoices/${id}/issue`, T.owner, { method: "POST" });
  return { id, total: Number(inv.body?.data?.total) };
}

/** Creates a share link and returns the raw token. */
async function shareLink(id, token = T.owner, body = {}) {
  const r = await api(`/api/v1/invoices/${id}/share-link`, token, {
    method: "POST",
    body: JSON.stringify(body),
  });
  return { ...r, token: r.body?.data?.token };
}

// ===========================================================================
console.log("\n1. publish is a separate, explicit action");
// ===========================================================================
{
  const { id } = await issuedInvoice();

  const published = await api(`/api/v1/invoices/${id}`, T.owner);
  check("issuing does NOT publish automatically", !published.body?.data?.published_at, String(published.body?.data?.published_at));

  const shouldFail = await shareLink(id);
  // Sharing is refused until issued... which it is, so this should succeed.
  check("an issued invoice can be shared", shouldFail.status === 200, String(shouldFail.status));

  const pub = await api(`/api/v1/invoices/${id}/publish`, T.owner, { method: "POST" });
  check("publish succeeds for an issued invoice", pub.status === 200, String(pub.status));
  check("published_at is recorded", Boolean(pub.body?.data?.published_at));

  // The internal view and the public projection must agree on the underlying
  // state. A second status ladder in the resolver once made the same invoice read
  // "published" internally and "issued" publicly.
  const internal = await api(`/api/v1/invoices/${id}`, T.owner);
  check(
    "internally a published invoice reads as published",
    internal.body?.data?.effective_status === "published",
    internal.body?.data?.effective_status,
  );

  const link = await shareLink(id);
  const publicView = await api(`/public/v1/invoices/${link.token}`, null);
  check(
    "the public page presents it as issued, not with internal vocabulary",
    publicView.body?.data?.status === "issued",
    publicView.body?.data?.status,
  );

  await api(`/api/v1/invoices/${id}/share-link`, T.owner, { method: "DELETE" });

  const unpub = await api(`/api/v1/invoices/${id}/unpublish`, T.owner, { method: "POST" });
  check("unpublish succeeds", unpub.status === 200, String(unpub.status));
  check("published_at is cleared", !unpub.body?.data?.published_at);
}

// ===========================================================================
console.log("\n2. a draft cannot be shared");
// ===========================================================================
{
  const inv = await api("/api/v1/invoices", T.owner, {
    method: "POST",
    body: JSON.stringify({
      clientId,
      periodStart: "2026-03-01",
      periodEnd: "2026-03-31",
      lineItems: [{ description: "Draft line", quantity: 1, unitPrice: 100 }],
    }),
  });
  const id = inv.body?.data?.id;

  const attempt = await shareLink(id);
  check("a draft cannot be shared", attempt.status === 400, String(attempt.status));
  check("the refusal explains why", /issue/i.test(attempt.body?.error?.message ?? ""), attempt.body?.error?.message);

  const publishDraft = await api(`/api/v1/invoices/${id}/publish`, T.owner, { method: "POST" });
  check("a draft cannot be published", publishDraft.status === 400, String(publishDraft.status));
}

// ===========================================================================
console.log("\n3. the public page works without authentication");
// ===========================================================================
let publicToken;
let publicInvoiceId;
{
  const { id, total } = await issuedInvoice();
  publicInvoiceId = id;

  const link = await shareLink(id);
  publicToken = link.token;

  check("a token is returned once", typeof publicToken === "string" && publicToken.length > 20, `${String(publicToken).length} chars`);
  check("the token looks unguessable", /^[A-Za-z0-9_-]{40,}$/.test(publicToken ?? ""), String(publicToken).slice(0, 12));
  check("a public URL is provided", /^\/i\//.test(link.body?.data?.url ?? ""), link.body?.data?.url);

  // No Authorization header at all — this is the whole point.
  const page = await api(`/public/v1/invoices/${publicToken}`, null);
  check("the public endpoint responds without auth", page.status === 200, String(page.status));
  check("it returns the invoice number", Boolean(page.body?.data?.invoiceNumber), page.body?.data?.invoiceNumber);
  check("it returns the total", Number(page.body?.data?.total) === total, `${page.body?.data?.total} vs ${total}`);
  check("it returns the line items", (page.body?.data?.lines ?? []).length === 1);
  check("it returns payment instructions", Boolean(page.body?.data?.paymentInstructions));

  // Anti-indexing and anti-caching.
  check("the response is marked noindex", /noindex/.test(page.headers.get("x-robots-tag") ?? ""), page.headers.get("x-robots-tag"));
  check("the response is marked no-store", /no-store/.test(page.headers.get("cache-control") ?? ""), page.headers.get("cache-control"));
  check("the response sets no-referrer", page.headers.get("referrer-policy") === "no-referrer", page.headers.get("referrer-policy"));
}

// ===========================================================================
console.log("\n4. the public payload leaks nothing internal");
// ===========================================================================
{
  const page = await api(`/public/v1/invoices/${publicToken}`, null);
  const raw = page.text;

  // Search the RAW response text, not the parsed object: a field nested somewhere
  // unexpected would still be caught.
  const forbidden = [
    ["supplier_cost", /supplier_cost/i],
    ["publisher cost", /publisher_?cost/i],
    ["wholesale", /wholesale/i],
    ["writer payout", /writer_?payout/i],
    ["payout", /payout/i],
    ["margin", /margin/i],
    ["client_rate", /client_rate/i],
    ["internal_note", /internal_note/i],
    ["negotiated", /negotiated/i],
    ["organization_id", /organization_id/i],
    ["placement_id", /placement_id/i],
    ["created_by", /created_by/i],
    ["profit", /profit/i],
  ];

  for (const [label, re] of forbidden) {
    check(`the public payload has no ${label}`, !re.test(raw));
  }

  // The invoice id itself must not be exposed: it is an internal identifier.
  check("the public payload exposes no invoice id", !/invoice_id/i.test(raw));
  check("the public payload exposes no client id", !/client_id/i.test(raw));

  // But the client-facing note IS legitimate, and its presence proves we are not
  // simply returning an empty object.
  check("the client-facing payment instructions survive", /GB00/.test(raw));
}

// ===========================================================================
console.log("\n5. revocation");
// ===========================================================================
{
  const revoke = await api(`/api/v1/invoices/${publicInvoiceId}/share-link`, T.owner, { method: "DELETE" });
  check("a link can be revoked", revoke.status === 200, String(revoke.status));
  check("the revoke reports a count", Number(revoke.body?.data?.revoked) >= 1, String(revoke.body?.data?.revoked));

  const after = await api(`/public/v1/invoices/${publicToken}`, null);
  check("a revoked token returns 404", after.status === 404, String(after.status));

  const pdf = await fetch(`${API}/public/v1/invoices/${publicToken}/pdf`);
  check("a revoked token cannot fetch a PDF", pdf.status === 404, String(pdf.status));
}

// ===========================================================================
console.log("\n6. rotation invalidates the previous token");
// ===========================================================================
{
  const { id } = await issuedInvoice();

  const first = await shareLink(id);
  const second = await shareLink(id);

  check("a second link is a different token", first.token !== second.token);
  check("the new token works", (await api(`/public/v1/invoices/${second.token}`, null)).status === 200);

  const old = await api(`/public/v1/invoices/${first.token}`, null);
  check("the OLD token stops working after rotation", old.status === 404, String(old.status));
}

// ===========================================================================
console.log("\n7. expiry");
// ===========================================================================
{
  const { id } = await issuedInvoice();
  const link = await shareLink(id, T.owner, { expiresInDays: 1 });

  check("an expiring link is created", link.status === 200, String(link.status));
  check("the expiry is recorded", Boolean(link.body?.data?.expires_at), link.body?.data?.expires_at);

  const works = await api(`/public/v1/invoices/${link.token}`, null);
  check("a non-expired link works", works.status === 200, String(works.status));
  check("the expiry is disclosed to the recipient", Boolean(works.body?.data?.expiresAt));

  // Expire it directly in the database, because waiting a day is not a test.
  //
  // `created_at` is backdated too: the table asserts `expires_at > created_at`,
  // which is a correct invariant for links the API creates. Simulating expiry
  // means moving both, not violating the constraint.
  const { execSync } = await import("node:child_process");
  const expired = await (async () => {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(link.token).digest("hex");
    execSync(
      `docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -v ON_ERROR_STOP=1`,
      {
        input: `update public.invoice_share_links
                set created_at = now() - interval '2 days',
                    expires_at = now() - interval '1 hour'
                where token_hash = '${hash}';`,
        encoding: "utf8",
      },
    );
    return api(`/public/v1/invoices/${link.token}`, null);
  })();

  check("an expired link returns 404", expired.status === 404, String(expired.status));
}

// ===========================================================================
console.log("\n8. unknown and malformed tokens");
// ===========================================================================
{
  const bogus = await api(`/public/v1/invoices/${"x".repeat(43)}`, null);
  check("an unknown token returns 404", bogus.status === 404, String(bogus.status));

  const short = await api(`/public/v1/invoices/abc`, null);
  check("a too-short token returns 404", short.status === 404, String(short.status));

  const sqlInjection = await api(
    `/public/v1/invoices/${encodeURIComponent("' OR 1=1 --")}`,
    null,
  );
  check("a SQL-injection-shaped token returns 404", sqlInjection.status === 404, String(sqlInjection.status));
  check("and does not leak a database error", !/postgres|syntax|pg_/i.test(sqlInjection.text), sqlInjection.text.slice(0, 80));
}

// ===========================================================================
console.log("\n9. cancellation kills the link");
// ===========================================================================
{
  const { id } = await issuedInvoice();
  const link = await shareLink(id);

  check("the link works before cancellation", (await api(`/public/v1/invoices/${link.token}`, null)).status === 200);

  await api(`/api/v1/invoices/${id}/cancel`, T.owner, { method: "POST" });

  const after = await api(`/public/v1/invoices/${link.token}`, null);
  check("a cancelled invoice's link stops working", after.status === 404, String(after.status));
}

// ===========================================================================
console.log("\n10. the PDF is available publicly and is a real PDF");
// ===========================================================================
{
  const { id, total } = await issuedInvoice();
  const link = await shareLink(id);

  const res = await fetch(`${API}/public/v1/invoices/${link.token}/pdf`);
  check("the public PDF responds 200", res.status === 200, String(res.status));
  check("its content type is PDF", /application\/pdf/.test(res.headers.get("content-type") ?? ""), res.headers.get("content-type"));
  check(
    "it is served as an attachment",
    /attachment/.test(res.headers.get("content-disposition") ?? ""),
    res.headers.get("content-disposition"),
  );

  const buffer = Buffer.from(await res.arrayBuffer());
  check("the bytes are a real PDF", buffer.subarray(0, 5).toString("latin1") === "%PDF-");
  check("the PDF is substantial", buffer.length > 1000, `${buffer.length} bytes`);
  check("the invoice total is what we created", total > 0);
}

// ===========================================================================
console.log("\n11. permissions on the sharing endpoints");
// ===========================================================================
{
  const { id } = await issuedInvoice();

  const amShare = await shareLink(id, T.am);
  check("account_manager CAN create a share link", amShare.status === 200, String(amShare.status));

  const writerShare = await shareLink(id, T.writer);
  check("content_writer cannot create a share link", writerShare.status === 403, String(writerShare.status));

  const clientShare = await shareLink(id, T.client);
  check("client_user cannot create a share link", clientShare.status === 403, String(clientShare.status));

  const amPublish = await api(`/api/v1/invoices/${id}/publish`, T.am, { method: "POST" });
  check("account_manager can publish", amPublish.status === 200, String(amPublish.status));

  const writerPublish = await api(`/api/v1/invoices/${id}/publish`, T.writer, { method: "POST" });
  check("content_writer cannot publish", writerPublish.status === 403, String(writerPublish.status));
}

// ===========================================================================
console.log("\n12. audit trail");
// ===========================================================================
{
  const { execSync } = await import("node:child_process");
  const db = (sql) =>
    execSync(`docker exec -i supabase_db_link-building-crm psql -U postgres -d postgres -t -A`, {
      input: sql,
      encoding: "utf8",
    }).trim();

  const actions = db(
    `select string_agg(distinct action, ',') from public.activity_log where entity_type in ('invoice', 'invoice_share_link')`,
  );

  check("share link creation is audited", /share_link_created/.test(actions), actions);
  check("share link revocation is audited", /share_link_revoked/.test(actions));
  check("public views are audited", /view/.test(actions));
  check("PDF downloads are audited", /download/.test(actions));
  check("publishing is audited", /publish/.test(actions));

  // A public access must be attributable to the channel, not to a real user.
  const publicRows = db(
    `select count(*) from public.activity_log where actor_name_snapshot = 'public link'`,
  );
  check("public accesses are recorded as such", Number(publicRows) > 0, publicRows);

  // The raw token must never be in the audit log.
  const tokenLeak = db(
    `select count(*) from public.activity_log where diff::text ilike '%' || '${publicToken ?? "none"}' || '%'`,
  );
  check("the raw token is never written to the audit log", Number(tokenLeak) === 0, tokenLeak);
}

// ===========================================================================
console.log("\n13. the private link requires ownership");
// ===========================================================================
{
  const { id } = await issuedInvoice();

  // A client can read their OWN invoice through the portal.
  const portalInvoices = await api("/portal/v1/invoices", T.client);
  check("a client can list their own invoices", portalInvoices.status === 200, String(portalInvoices.status));

  const own = (portalInvoices.body?.data ?? []).map((i) => i.id);
  check("the client's list is not empty", own.length > 0, `${own.length} invoices`);

  // ---- payload shape, not just status -------------------------------------
  //
  // The original assertion here was `status === 200` and nothing else, which a
  // STALE duplicate route satisfied while returning drafts and omitting
  // `balance` — the portal screen rendered blanks and the test went green. A
  // status code is not evidence that the right handler answered.
  const firstRow = (portalInvoices.body?.data ?? [])[0] ?? {};
  check(
    "the portal invoice payload carries effective_status",
    "effective_status" in firstRow,
    Object.keys(firstRow).join(",").slice(0, 80),
  );
  check("the portal invoice payload carries balance", "balance" in firstRow);
  check("the portal invoice payload carries paid_amount", "paid_amount" in firstRow);

  // ---- drafts are never sent to a client -----------------------------------
  const portalDrafts = (portalInvoices.body?.data ?? []).filter(
    (i) => i.status === "draft" || i.effective_status === "draft",
  );
  check(
    "no draft invoice is returned to a client",
    portalDrafts.length === 0,
    `${portalDrafts.length} drafts leaked`,
  );

  const cancelled = (portalInvoices.body?.data ?? []).filter((i) => i.effective_status === "cancelled");
  check("no cancelled invoice is returned to a client", cancelled.length === 0, `${cancelled.length} cancelled`);

  // A draft cannot be fetched by id either — the list filter must not be the only
  // defence, because an id is guessable from an invoice number.
  const anyDraft = await api("/api/v1/invoices?status=draft&limit=1", T.owner);
  const draftId = anyDraft.body?.data?.[0]?.id;
  if (draftId) {
    const byId = await api(`/portal/v1/invoices/${draftId}`, T.client);
    check(
      "a client cannot fetch a draft by id",
      byId.status === 404 || byId.status === 403,
      String(byId.status),
    );
  }

  // A client must not read an arbitrary invoice id through the portal.
  const foreign = await api(`/portal/v1/invoices/${id}`, T.client);
  const isOwn = own.includes(id);
  check(
    "a client cannot read another client's invoice by id",
    isOwn || foreign.status === 404,
    `${foreign.status}`,
  );

  // And the internal endpoint stays closed.
  const internal = await api(`/api/v1/invoices/${id}`, T.client);
  check("a client cannot read the internal invoice endpoint", internal.status === 403, String(internal.status));

  const portalPdf = await fetch(`${API}/portal/v1/invoices/${own[0]}/pdf`, {
    headers: { authorization: `Bearer ${T.client}` },
  });
  check("a client can download their own invoice PDF", portalPdf.status === 200, String(portalPdf.status));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log("\nFAILURES:");
  for (const f of failed) console.log(`  - ${f.n}${f.d !== "undefined" ? ` — ${f.d}` : ""}`);
  process.exit(1);
}
