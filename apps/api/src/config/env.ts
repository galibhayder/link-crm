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
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // Fail loudly and immediately. A half-configured server is worse than none.
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }

  const config = parsed.data;

  /**
   * Production-only checks.
   *
   * Each of these has a default that is correct for development and silently wrong
   * in production, which is the worst combination: the server boots happily and the
   * damage only appears later. They are rejected at startup instead.
   */
  if (config.NODE_ENV === "production") {
    const fatal: string[] = [];

    if (config.CORS_ORIGINS.every((o) => o.includes("localhost") || o.includes("127.0.0.1"))) {
      fatal.push(
        "CORS_ORIGINS still points at localhost. Set it to the real origin, e.g. https://crm.triveromarketing.com",
      );
    }
    if (!config.JOB_HMAC_SECRET) {
      // Without it every scheduled job is unreachable, so link verification and
      // overdue reminders stop silently rather than erroring.
      fatal.push("JOB_HMAC_SECRET is required in production (scheduled jobs cannot run without it)");
    }
    if (config.SUPABASE_URL.includes("127.0.0.1") || config.SUPABASE_URL.includes("localhost")) {
      fatal.push("SUPABASE_URL points at localhost. Set it to the hosted project URL.");
    }

    if (fatal.length > 0) {
      console.error(`Refusing to start in production:\n${fatal.map((f) => `  - ${f}`).join("\n")}`);
      process.exit(1);
    }
  }

  return config;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";
