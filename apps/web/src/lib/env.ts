/**
 * Frontend environment.
 *
 * ONLY Vite-prefixed variables reach this bundle, and Vite inlines them at build
 * time. That means anything declared here is public by definition — which is
 * precisely why the Supabase SERVICE ROLE key must never gain a VITE_ prefix.
 * The browser talks to Express; Express holds the service key.
 */
import { z } from "zod";

const envSchema = z.object({
  // Empty in development: the Vite proxy forwards /api to the local server, so
  // the browser stays on one origin. Set only for a split deployment.
  VITE_API_URL: z.string().default(""),
  VITE_SUPABASE_URL: z.string().url().optional(),
  VITE_SUPABASE_ANON_KEY: z.string().optional(),
  /**
   * Build-time default only.
   *
   * The Admin panel overrides this at runtime from `organizations.name`, so
   * renaming the business never requires a rebuild. This value is the fallback
   * used before the org config loads, and on a fresh install.
   */
  VITE_APP_NAME: z.string().default("Trivero Marketing"),
});

function readEnv() {
  const parsed = envSchema.safeParse({
    VITE_API_URL: import.meta.env.VITE_API_URL,
    VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
    VITE_APP_NAME: import.meta.env.VITE_APP_NAME,
  });

  if (!parsed.success) {
    // A malformed public config is a build/deploy problem, not a runtime one.
    // Failing loudly beats a blank screen with no explanation.
    console.error("Invalid frontend environment", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid frontend environment configuration");
  }

  return parsed.data;
}

export const env = readEnv();

/** Base URL for API calls. Empty means same-origin (dev proxy or single deploy). */
export const API_BASE = env.VITE_API_URL.replace(/\/$/, "");
export const APP_NAME = env.VITE_APP_NAME;

/**
 * Guard: this must never be true. CI greps the built bundle for service-role
 * material; this is the runtime equivalent for anyone reading the code.
 */
export const HAS_SERVICE_KEY_IN_BUNDLE = Boolean(
  (import.meta.env as Record<string, unknown>).VITE_SUPABASE_SERVICE_ROLE_KEY,
);
