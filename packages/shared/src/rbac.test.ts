import { describe, expect, it } from "vitest";
import { can, canAny, PERMISSIONS, ROLE_PERMISSIONS, TIER_1_PRICING_ROLES, TIER_2_COST_ROLES, TIER_3_MARGIN_ROLES } from "../src/rbac.js";
import { ROLES, ROLE_SURFACE, type Role } from "../src/roles.js";

const ACTORS: Role[] = ["account_manager", "prospector", "outreach_specialist", "content_writer", "client_user", "publisher_user"];

describe("role model", () => {
  it("has exactly the seven roles from the agency's role research", () => {
    expect(ROLES).toHaveLength(7);
    expect([...ROLES]).toEqual([
      "owner",
      "account_manager",
      "prospector",
      "outreach_specialist",
      "content_writer",
      "client_user",
      "publisher_user",
    ]);
  });

  it("maps each role to exactly one surface", () => {
    expect(ROLE_SURFACE.client_user).toBe("portal");
    expect(ROLE_SURFACE.publisher_user).toBe("supplier");
    for (const r of ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer"] as Role[]) {
      expect(ROLE_SURFACE[r]).toBe("internal");
    }
  });
});

describe("financial tier isolation", () => {
  it("only the owner holds margin reporting", () => {
    expect(TIER_3_MARGIN_ROLES).toEqual(["owner"]);
    for (const r of ACTORS) {
      expect(can(r, "reports:margins"), `${r} must not see margin`).toBe(false);
    }
  });

  it("wholesale cost is readable by owner, fulfillment staff and the publisher only", () => {
    expect([...TIER_2_COST_ROLES].sort()).toEqual(
      ["outreach_specialist", "owner", "prospector", "publisher_user"].sort(),
    );
    // The bridge role between client and fulfillment must NOT see wholesale cost.
    expect(can("account_manager", "costs:read")).toBe(false);
    // Nor may the client, or the writer.
    expect(can("client_user", "costs:read")).toBe(false);
    expect(can("content_writer", "costs:read")).toBe(false);
  });

  it("client pricing is readable by the quoting roles and the client, never the publisher", () => {
    expect([...TIER_1_PRICING_ROLES].sort()).toEqual(["account_manager", "client_user", "owner"].sort());
    expect(can("publisher_user", "pricing:read")).toBe(false);
    expect(can("publisher_user", "pricing:write")).toBe(false);
    expect(can("prospector", "pricing:read")).toBe(false);
    expect(can("content_writer", "pricing:read")).toBe(false);
  });

  it("no non-owner role can both read client price and read supplier cost except through deliberate design", () => {
    // Any role holding both tiers could derive margin by subtraction, which is
    // exactly the leak the three-tier split exists to prevent.
    for (const r of ROLES) {
      if (r === "owner") continue;
      const both = can(r, "pricing:read") && can(r, "costs:read");
      expect(both, `${r} holds both tiers and could derive margin`).toBe(false);
    }
  });
});

describe("stakeholder guarantees from the brief", () => {
  it("client never sees wholesale cost, margin, touchpoints or costs:write", () => {
    const c = ROLE_PERMISSIONS.client_user;
    expect(c).not.toContain("costs:read");
    expect(c).not.toContain("costs:write");
    expect(c).not.toContain("reports:margins");
    expect(c).not.toContain("touchpoints:read");
    expect(c).not.toContain("pricing:write");
  });

  it("content writer never sees billing, negotiation threads or costs", () => {
    const w = ROLE_PERMISSIONS.content_writer;
    for (const denied of ["invoices:read", "payments:read", "touchpoints:read", "costs:read", "pricing:read", "suppliers:read"] as const) {
      expect(w, `content_writer must not hold ${denied}`).not.toContain(denied);
    }
  });

  it("publisher sees only its own side of the trade", () => {
    const p = ROLE_PERMISSIONS.publisher_user;
    expect(p).toContain("costs:read");
    expect(p).not.toContain("pricing:read");
    expect(p).not.toContain("invoices:read");
    expect(p).not.toContain("clients:read");
    expect(p).not.toContain("reports:margins");
  });

  it("only the owner manages staff, settings and audit", () => {
    for (const perm of ["staff:manage", "settings:manage", "audit:read"] as const) {
      expect(can("owner", perm)).toBe(true);
      for (const r of ACTORS) expect(can(r, perm), `${r} + ${perm}`).toBe(false);
    }
  });

  it("only the owner may write invoices and payments", () => {
    expect(can("owner", "invoices:write")).toBe(true);
    expect(can("owner", "payments:write")).toBe(true);
    for (const r of ACTORS) {
      expect(can(r, "invoices:write"), `${r} invoices:write`).toBe(false);
      expect(can(r, "payments:write"), `${r} payments:write`).toBe(false);
    }
  });
});

describe("matrix integrity", () => {
  it("every role's permission list is a subset of PERMISSIONS", () => {
    const all = new Set<string>(PERMISSIONS);
    for (const role of ROLES) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect(all.has(p), `${role} holds unknown permission ${p}`).toBe(true);
      }
    }
  });

  it("has no duplicate permissions within a role", () => {
    for (const role of ROLES) {
      const list = ROLE_PERMISSIONS[role];
      expect(new Set(list).size, `${role} has duplicates`).toBe(list.length);
    }
  });

  it("owner holds every permission", () => {
    expect(ROLE_PERMISSIONS.owner.length).toBe(PERMISSIONS.length);
  });

  it("canAny behaves as any-of, not all-of", () => {
    expect(canAny("content_writer", ["invoices:write", "briefs:read"])).toBe(true);
    expect(canAny("content_writer", ["invoices:write", "payments:write"])).toBe(false);
  });
});
