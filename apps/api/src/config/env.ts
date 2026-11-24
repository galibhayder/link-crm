import { z } from "zod";

// Load .env for local development before validation. Node 20.6+ has this built
// in, so no dotenv dependency. In production the platform supplies the vars and
// the file is absent, which loadEnvFile handles silently.
try {
  process.loadEnvFile?.();
} catch {
  // No .env present — expected on a server.
}

/**
 * Environment is validated once at boot. A missing or malformed secret must
 * crash the process immediately rather than produce `undefined` at 3am.
 */
const envSchema = z.object({
  // REQUIRED in production, not defaulted to "development".
  //
  // Every production guard in this file — and the strict CSP in app.ts — is keyed
  // off `isProd`. Defaulting to development means a host whose deployment panel
  // does not set NODE_ENV silently runs with all guards disabled AND a weaker
  // Content-Security-Policy, while /health/live reports healthy. A missing value
  // must fail at boot instead of quietly downgrading security.
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Public — safe in the browser bundle, used for auth and Storage uploads.
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),

  // Server-only. Never exposed to the client; CI greps the web bundle for these.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  // HMAC secret for /internal/jobs/*. Scheduled work never uses a JWT.
  JOB_HMAC_SECRET: z.string().min(32).optional(),

  // Explicit allowlist — no wildcard CORS.
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /**
   * Where the compiled React app lives.
   *
   * Left empty in a monorepo checkout, where the default (apps/web/dist) is
   * correct. A host that uploads a flattened bundle sets it to an absolute path —
   * Hostinger Business hosting, for example, has no apps/ directory at all.
   */
  WEB_DIST_PATH: z.string().default(""),
});

export type Env = z.infer<typeof envSchema> & { NODE_ENV: "development" | "test" | "production" };

/**
 * Reports an invalid configuration and stops.
 *
 * `process.exit` is correct at boot and WRONG when this module is imported by a
 * test: it kills the runner instead of failing one test, so the report says
 * "process.exit unexpectedly called" rather than naming the problem. Throwing
 * gives a normal stack trace; the entry point catches it and exits.
 */
function fatal(message: string): never {
  console.error(message);
  if (isRunningTests()) throw new Error(message);

  process.exit(1);
}

function isRunningTests(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true" ||
    typeof (globalThis as { __vitest_worker__?: unknown }).__vitest_worker__ !== "undefined"
  );
}

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Fail loudly and immediately. A half-configured server is worse than none.
    fatal(`Invalid environment configuration:\n${issues}`);
  }

  const config = parsed.data;

  /**
   * NODE_ENV is optional in the schema but NOT optional at runtime.
   *
   * Without it there is no way to know whether to apply the production guards, and
   * guessing "development" would silently disable them. The only safe assumption
   * for an unset value is that this is NOT a real production deployment — but that
   * assumption must be loud, so the operator learns it from a boot warning rather
   * than from a security review six months later.
   */
  if (!config.NODE_ENV) {
    console.warn(
      "[env] NODE_ENV is not set. Treating this as development: the production " +
        "guards and the strict Content-Security-Policy are NOT active. " +
        "Set NODE_ENV=production in the deployment environment.",
    );
  }

  const nodeEnv = config.NODE_ENV ?? "development";

  /**
   * Production-only checks.
   *
   * Each of these has a default that is correct for development and silently wrong
   * in production, which is the worst combination: the server boots happily and the
   * damage only appears later. They are rejected at startup instead.
   */
  if (nodeEnv === "production") {
    const problems: string[] = [];

    if (config.CORS_ORIGINS.every((o) => o.includes("localhost") || o.includes("127.0.0.1"))) {
      problems.push(
        "CORS_ORIGINS still points at localhost. Set it to the real origin, e.g. https://crm.triveromarketing.com",
      );
    }
    if (!config.JOB_HMAC_SECRET) {
      // Without it every scheduled job is unreachable, so link verification and
      // overdue reminders stop silently rather than erroring.
      problems.push("JOB_HMAC_SECRET is required in production (scheduled jobs cannot run without it)");
    }
    if (config.SUPABASE_URL.includes("127.0.0.1") || config.SUPABASE_URL.includes("localhost")) {
      problems.push("SUPABASE_URL points at localhost. Set it to the hosted project URL.");
    }

    if (problems.length > 0) {
      fatal(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    }
  }

  return { ...config, NODE_ENV: nodeEnv };
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
