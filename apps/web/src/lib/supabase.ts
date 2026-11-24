import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";

/**
 * The browser Supabase client is used ONLY for authentication (and, later,
 * Storage uploads). All data access goes through Express, so authorization and
 * audit logging live in one place.
 *
 * It is initialised with the ANON key. The service-role key never appears in
 * this bundle — see lib/env.ts and the CI grep described in the README.
 */
let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_ANON_KEY) return null;
  if (!client) {
    client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: "linkforge-auth",
      },
    });
  }
  return client;
}

export const isAuthConfigured = Boolean(env.VITE_SUPABASE_URL && env.VITE_SUPABASE_ANON_KEY);
