/**
 * Security probe: can one user commit ANOTHER user's import job?
 *
 * The commit path reads the stored preview through service_role and checks the
 * organisation — but not the creator. If an account_manager can commit a job
 * created by someone else in the same org, that is a weaker boundary than the
 * rest of the app, which scopes by role.
 */
const S = "http://127.0.0.1:54321";
const A =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const results = [];
const check = (n, ok, d = "") => {
  results.push(ok);
  console.log(`${ok ? "  ✓" : "  ✗"} ${n}${d ? ` — ${d}` : ""}`);
};

async function login(email) {
  const r = await fetch(`${S}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: A, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  return (await r.json()).access_token;
}

const api = (p, token, o = {}) =>
  fetch(`http://127.0.0.1:3000${p}`, {
    ...o,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(o.headers ?? {}) },
  }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) }));

const owner = await login("owner@demo.test");
const am = await login("am@demo.test");

const stamp = Date.now();

// Owner creates a preview.
const preview = await api("/api/v1/import/publishers/preview", owner, {
  method: "POST",
  body: JSON.stringify({
    entity: "publishers",
    rows: [{ domain: `cross-user-${stamp}.test`, name: "Cross User" }],
    duplicateStrategy: "skip",
  }),
});
const jobId = preview.body?.data?.jobId;
check("owner created a preview", Boolean(jobId), `${preview.status}`);

// The account_manager tries to commit it.
const commit = await api("/api/v1/import/publishers/commit", am, {
  method: "POST",
  body: JSON.stringify({ jobId }),
});
console.log(`  account_manager commit status: ${commit.status}`);

// A preview is a REVIEW step. If a colleague could commit a file someone else
// reviewed and rejected, the review would be meaningless — so this must be 403.
check("another user cannot commit my preview", commit.status === 403, `${commit.status}: ${commit.body?.error?.message ?? ""}`);

// A user in ANOTHER org must never commit it. Checked BEFORE the creator
// commits, so this observes the tenancy boundary rather than the
// already-applied conflict.
const rival = await login("owner@rival.test");
const rivalCommit = await api("/api/v1/import/publishers/commit", rival, {
  method: "POST",
  body: JSON.stringify({ jobId }),
});
check(
  "a user in another organization cannot commit the job",
  rivalCommit.status === 404,
  `${rivalCommit.status}: ${rivalCommit.body?.error?.message ?? ""}`,
);

// The creator still can.
const ownCommit = await api("/api/v1/import/publishers/commit", owner, {
  method: "POST",
  body: JSON.stringify({ jobId }),
});
check("the creator can still commit it", ownCommit.status === 200, `${ownCommit.status}`);

// And a junior role must not be able to commit at all.
const writer = await login("writer@demo.test");
const writerPreview = await api("/api/v1/import/publishers/preview", writer, {
  method: "POST",
  body: JSON.stringify({ entity: "publishers", rows: [{ domain: "x.test", name: "X" }] }),
});
check("content_writer cannot preview a publisher import", writerPreview.status === 403, `${writerPreview.status}`);

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
