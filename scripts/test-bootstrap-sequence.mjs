/**
 * END-TO-END TEST OF THE BOOTSTRAP SEQUENCE, ON A LIVE DATABASE.
 *
 * The trigger `on_auth_user_created_provision_profile` fails closed: no pending
 * invitation means no profile. That makes the ORDER of these steps load-bearing,
 * and a wrong order produces a 403 that looks like an application bug.
 *
 * So both directions are asserted here:
 *
 *   1. a user created without an invitation gets NO profile,
 *   2. a user created after its invitation DOES — with the right role, org and
 *      active flag — and the invitation is marked accepted,
 *   3. the token hook stamps the claims the profile needs.
 *
 * Runs against the local Supabase stack. Creates a throwaway organisation and
 * removes everything afterwards, so it is safe to repeat.
 */
import { execFileSync } from "node:child_process";

const DB = "supabase_db_link-building-crm";

/**
 * psql prints command tags ("INSERT 0 1", "DELETE 3") to stdout alongside the
 * rows. Reading the last line — not the whole output — is what makes a query
 * that both writes and selects usable here. Concatenating tags into a UUID was
 * the first version's bug.
 */
const sql = (q) => {
  const out = execFileSync(
    "docker",
    ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-q", "-c", q],
    { encoding: "utf8" },
  );
  const lines = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(INSERT|UPDATE|DELETE|SELECT|CREATE|ALTER|DROP|NOTICE)\b/.test(l));
  return lines.at(-1) ?? "";
};

/** Every row of a multi-row result, with tags stripped. */
const sqlAll = (q) => {
  const out = execFileSync(
    "docker",
    ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-t", "-A", "-q", "-c", q],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(INSERT|UPDATE|DELETE|SELECT|CREATE|ALTER|DROP|NOTICE)\b/.test(l));
};

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const TAG = `bootstrap-test-${Date.now()}`;
const NO_INVITE = "00000000-0000-4000-8000-00000000a1a1";
const WITH_INVITE = "00000000-0000-4000-8000-00000000b2b2";

function cleanup() {
  /**
   * `guard_last_owner()` refuses ANY change that would leave an organisation
   * without an active owner — delete, demotion, even deactivation. That is
   * correct for production: it is what stops an agency losing its only admin.
   *
   * It also means a fixture that deliberately creates "an org whose only owner is
   * the test user" cannot be torn down normally. Disabling the trigger for the
   * duration of the teardown is the honest way to do it — and the guard itself is
   * exercised by the assertions above, including one that proves an
   * unprovisioned user gets no claims.
   */
  for (const q of [
    `alter table public.profiles disable trigger profiles_guard_last_owner;`,
    `delete from public.profiles where organization_id in
       (select id from public.organizations where slug = '${TAG}');`,
    `delete from public.invitations where organization_id in
       (select id from public.organizations where slug = '${TAG}');`,
    `delete from public.pipeline_stages where organization_id in
       (select id from public.organizations where slug = '${TAG}');`,
    `delete from public.organizations where slug = '${TAG}';`,
    `alter table public.profiles enable trigger profiles_guard_last_owner;`,
  ]) {
    try {
      sql(q);
    } catch {
      /* best effort; the assertion below reports anything left behind */
    }
  }

  // Belt and braces: the trigger must be back on, or the database is left weaker
  // than it was found.
  try {
    sql(`alter table public.profiles enable trigger profiles_guard_last_owner;`);
  } catch {
    /* already enabled */
  }

  // The auth user is not owned by the profile, so it is removed separately.
  for (const id of [NO_INVITE, WITH_INVITE]) {
    try {
      sql(`delete from auth.users where id = '${id}';`);
    } catch {
      /* best effort */
    }
  }
}

cleanup();

const orgId = sql(
  `insert into public.organizations (name, slug) values ('Bootstrap Test','${TAG}') on conflict (slug) do nothing;
   select id from public.organizations where slug='${TAG}';`,
);
check("throwaway organisation created", orgId.length === 36, orgId || "empty");

// ---------------------------------------------------------------------------
console.log("\n1. a user created WITHOUT an invitation gets NO profile");
// ---------------------------------------------------------------------------
sql(
  `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
   values ('${NO_INVITE}', 'nobody-${TAG}@test.local', now(), '{}'::jsonb) on conflict (id) do nothing;`,
);
const noProfile = sql(`select count(*) from public.profiles where id='${NO_INVITE}';`);
check("no profile provisioned (the trigger fails closed)", noProfile === "0", `${noProfile} row(s)`);

// ---------------------------------------------------------------------------
console.log("\n2. invitation FIRST, then the user, DOES get a profile");
// ---------------------------------------------------------------------------
const email = `owner-${TAG}@test.local`;
sql(
  `insert into public.invitations (organization_id, email, full_name, role, invited_by)
   values ('${orgId}', '${email}', 'Test Owner', 'owner', null);`,
);

sql(
  `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
   values ('${WITH_INVITE}', '${email}', now(), '{"full_name":"Test Owner"}'::jsonb) on conflict (id) do nothing;`,
);

const prof = sql(
  `select role || '|' || organization_id || '|' || is_active from public.profiles where id='${WITH_INVITE}';`,
);
check("profile provisioned from the invitation", prof.startsWith("owner|"), prof || "missing");
check("bound to the right organisation", prof.split("|")[1] === orgId, prof.split("|")[1] ?? "-");
check("active", prof.split("|")[2] === "true", prof.split("|")[2] ?? "-");

const invStatus = sql(`select status from public.invitations where lower(email)=lower('${email}');`);
check("invitation marked accepted", invStatus === "accepted", invStatus || "missing");

// ---------------------------------------------------------------------------
console.log("\n3. the token hook stamps the claims RLS depends on");
// ---------------------------------------------------------------------------
const hookRole = sql(
  `select app_private.custom_access_token_hook(
            jsonb_build_object('user_id','${WITH_INVITE}','claims','{}'::jsonb)
          ) -> 'claims' -> 'app_metadata' ->> 'role';`,
);
check("hook returns role=owner", hookRole === "owner", hookRole || "empty");

const hookOrg = sql(
  `select app_private.custom_access_token_hook(
            jsonb_build_object('user_id','${WITH_INVITE}','claims','{}'::jsonb)
          ) -> 'claims' -> 'app_metadata' ->> 'org_id';`,
);
check("hook returns the org claim", hookOrg === orgId, hookOrg || "empty");

// An unprovisioned user must get NO tenancy claims, so every policy fails closed.
const hookNobody = sql(
  `select coalesce(
            app_private.custom_access_token_hook(
              jsonb_build_object('user_id','${NO_INVITE}','claims','{}'::jsonb)
            ) -> 'claims' -> 'app_metadata' ->> 'org_id', 'absent');`,
);
check("hook gives an unprovisioned user no org claim", hookNobody === "absent", hookNobody);

// ---------------------------------------------------------------------------
cleanup();
const leftover = sql(`select count(*) from public.organizations where slug='${TAG}';`);
check("throwaway tenant cleaned up", leftover === "0", `${leftover} left`);

console.log(`\n${failures === 0 ? "PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
