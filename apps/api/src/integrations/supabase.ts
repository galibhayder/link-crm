import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

/**
 * THE most important boundary in this codebase.
 *
 * asUser() carries the caller's JWT, so Postgres Row Level Security applies to
 * every query built from it. This is the default and the safe path.
 *
 * admin() holds service_role and BYPASSES RLS ENTIRELY. It exists only for:
 *   - auth admin operations (invite, deactivate, role revocation)
 *   - scheduled jobs (/internal/jobs/*)
 *   - storage housekeeping, migrations
 *   - import commits and margin reporting, AFTER an explicit permission check
 *
 * It must never be handed a user-supplied id without an explicit permission
 * check first, because there is no second line of defence behind it.
 *
 * NOTE ON TYPING.
 *
 * The generated schema lives at packages/db/types/database.ts, but the client is
 * intentionally NOT parameterised with it yet. Parameterising it requires every
 * query in every module to satisfy the inferred row types, which is a migration
 * in its own right; doing it half-way produces a cascade of errors that then get
 * silenced with casts — worse than no types at all.
 *
 * The type below keeps `data` loose so property access compiles, matching how
 * the pre-Phase-3 modules behaved. The generated types remain in place, ready for
 * a deliberate module-by-module migration.
 */
export type TypedClient = SupabaseClient;

let adminClient: TypedClient | null = null;

/** Requests scoped to the caller. RLS enforced by Postgres. */
export function asUser(accessToken: string): TypedClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * RLS-bypassing client. Singleton, because creating one per request leaks
 * connection handles and defeats keep-alive.
 */
export function admin(): TypedClient {
  if (!adminClient) {
    adminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }
  return adminClient;
}

/** Test seam: reset the singleton between test cases. */
export function resetAdminClient(): void {
  adminClient = null;
}
