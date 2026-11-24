import { describe, expect, it } from "vitest";
import { redact, diffOf } from "./audit.js";

/**
 * The audit log is the one table a reader would most like to mine for
 * credentials, so redaction is a security control, not a nicety. These tests
 * exist because the original implementation only inspected top-level keys and
 * would have stored `{ password: { from, to } }` in plaintext.
 */

describe("audit redaction", () => {
  it("redacts a direct password key", () => {
    const out = redact({ password: "hunter2" });
    expect(out.password).toBe("[redacted]");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("redacts nested credentials, which the first version leaked", () => {
    const out = redact({ password: { from: "hunter2", to: "hunter3" } });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("hunter3");
    expect(out.password).toBe("[redacted]");
  });

  it("redacts by substring, not only exact names", () => {
    const out = redact({ passwordResetToken: "abc123", new_secret: "s3cr3t" });
    expect(JSON.stringify(out)).not.toContain("abc123");
    expect(JSON.stringify(out)).not.toContain("s3cr3t");
  });

  it("redacts credentials inside arrays of objects", () => {
    const out = redact({ users: [{ email: "a@b.test", password: "hunter2" }] });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).toContain("a@b.test");
  });

  it("is case-insensitive", () => {
    for (const key of ["PASSWORD", "Access_Token", "API_KEY", "RefreshToken"]) {
      expect(JSON.stringify(redact({ [key]: "value" }))).not.toContain("value");
    }
  });

  it("preserves ordinary business fields", () => {
    const out = redact({
      supplierCost: { from: 850, to: 900 },
      role: { from: "prospector", to: "outreach_specialist" },
      email: "someone@agency.test",
    });
    expect(out.supplierCost).toEqual({ from: 850, to: 900 });
    expect(out.role).toEqual({ from: "prospector", to: "outreach_specialist" });
    expect(out.email).toBe("someone@agency.test");
  });

  it("does not redact innocuous keys that merely contain 'token'", () => {
    const out = redact({ token_count: 5 });
    expect(out.token_count).toBe(5);
  });

  it("bounds recursion so a pathological diff cannot hang the writer", () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    // Must return rather than recurse forever.
    expect(() => redact(deep)).not.toThrow();
  });

  it("handles empty and undefined diffs", () => {
    expect(redact(undefined)).toEqual({});
    expect(redact({})).toEqual({});
  });
});

describe("diffOf", () => {
  it("records only changed fields, with before and after", () => {
    const diff = diffOf({ role: "prospector", is_active: true }, { role: "outreach_specialist" });
    expect(diff.role).toEqual({ from: "prospector", to: "outreach_specialist" });
    expect(diff.is_active).toBeUndefined();
  });

  it("returns an empty diff when nothing changed", () => {
    expect(diffOf({ a: 1 }, { a: 1 })).toEqual({});
  });

  it("never yields a diff that redaction would strip of meaning", () => {
    const diff = diffOf({ role: "prospector" }, { role: "account_manager" });
    const redacted = redact(diff);
    expect(redacted.role).toEqual({ from: "prospector", to: "account_manager" });
  });
});
