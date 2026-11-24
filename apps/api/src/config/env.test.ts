// Proves config/env.ts THROWS under vitest instead of calling process.exit.
// Without the fix this file killed the runner with
// "process.exit unexpectedly called with 1" and no test name was reported.
import { afterEach, describe, expect, it, vi } from "vitest";

describe("env validation failure", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("throws a diagnosable error instead of exiting the process", async () => {
    // A production configuration with development defaults: exactly what the
    // guard exists to reject.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CORS_ORIGINS", "http://localhost:5173");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_ANON_KEY", "x".repeat(30));
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "y".repeat(30));
    vi.stubEnv("JOB_HMAC_SECRET", "z".repeat(32));

    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.resetModules();

    // The assertion that matters: importing throws, so the runner survives and
    // reports which test failed.
    await expect(import("./env.js")).rejects.toThrow(/Refusing to start in production/);

    // And it did NOT take the process down.
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it("a valid development configuration loads", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CORS_ORIGINS", "http://localhost:5173");
    vi.stubEnv("SUPABASE_URL", "http://127.0.0.1:54321");
    vi.stubEnv("SUPABASE_ANON_KEY", "x".repeat(30));
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "y".repeat(30));

    vi.resetModules();
    const mod = await import("./env.js");
    expect(mod.env.NODE_ENV).toBe("development");
    expect(mod.isProd).toBe(false);
  });
});
