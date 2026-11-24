import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * RLS test harness.
 *
 * Every assertion here runs against REAL Postgres with a REAL JWT for the role
 * under test. Nothing is mocked: a mocked RLS test proves only that the mock was
 * written to agree with the assumption being tested. That assumption is exactly
 * what fails in production.
 */

export const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
export const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
export const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export const PASSWORD = "password123";

export const SEED_USERS = {
  owner: "owner@demo.test",
  account_manager: "am@demo.test",
  prospector: "prospector@demo.test",
  outreach_specialist: "outreach@demo.test",
  content_writer: "writer@demo.test",
  client_user: "client@demo.test",
  publisher_user: "publisher@demo.test",
  rival_owner: "owner@rival.test",
} as const;

export type SeedRole = keyof typeof SEED_USERS;

export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const tokenCache = new Map<SeedRole, string>();

/** Signs in as a seeded role and returns a client carrying that JWT. */
export async function asRole(role: SeedRole): Promise<SupabaseClient> {
  const cached = tokenCache.get(role);
  if (cached) return clientWithToken(cached);

  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await client.auth.signInWithPassword({
    email: SEED_USERS[role],
    password: PASSWORD,
  });

  if (error || !data.session) {
    throw new Error(`Could not sign in as ${role} (${SEED_USERS[role]}): ${error?.message ?? "no session"}`);
  }

  tokenCache.set(role, data.session.access_token);
  return clientWithToken(data.session.access_token);
}

function clientWithToken(token: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Reads a role's app_metadata claims straight from the token, so a test can
 * assert the Custom Access Token Hook actually ran. Without that hook every
 * policy reads a null org_id and the whole model silently denies everything.
 */
export function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Malformed JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

export async function accessTokenFor(role: SeedRole): Promise<string> {
  const cached = tokenCache.get(role);
  if (cached) return cached;
  await asRole(role);
  return tokenCache.get(role)!;
}

export async function closeAll(): Promise<void> {
  tokenCache.clear();
}
