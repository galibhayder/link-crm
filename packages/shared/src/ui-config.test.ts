import { describe, expect, it } from "vitest";
import { can } from "./rbac.js";
import {
  ALL_COLUMN_IDS,
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_WIDGET_LABELS,
  EMPTY_UI_CONFIG,
  MODULE_COLUMNS,
  MODULE_IDS,
  MODULE_PERMISSIONS,
  UIConfigSchema,
  effectiveModules,
  findPermissionWidening,
  findUnknownIds,
  type UIConfig,
} from "./ui-config.js";

/**
 * THE SECURITY BOUNDARY OF PHASE 7.
 *
 * Customization may hide and rename. It may never grant. These tests exist
 * because that is the single claim the whole feature rests on, and because the
 * dangerous direction is the one that produces no error — a config that quietly
 * widens access looks exactly like one that works.
 */

const perms = (role: string, permission: string) => can(role as never, permission as never);

describe("effectiveModules — RBAC is the ceiling", () => {
  it("gives a role only what its permissions allow when config is empty", () => {
    const client: UIConfig = {};
    const modules = effectiveModules("client_user", client, perms);

    // A client_user must never see an internal module.
    expect(modules).not.toContain("/finance");
    expect(modules).not.toContain("/staff");
    expect(modules).not.toContain("/payouts" as never);
  });

  it("never grants a module RBAC denies, however the config is written", () => {
    // The most direct attempt: mark EVERY module enabled for a restricted role,
    // and hide nothing. A union-based implementation would grant everything here.
    const allEnabled: UIConfig = {
      modules: Object.fromEntries(MODULE_IDS.map((m) => [m, true])) as UIConfig["modules"],
    };

    const modules = effectiveModules("content_writer", allEnabled, perms);

    expect(modules).not.toContain("/finance");
    expect(modules).not.toContain("/staff");
    expect(modules).not.toContain("/payouts" as never);
    // And a writer still gets what they legitimately have.
    expect(modules).toContain("/content");
  });

  it("a roleVisibility entry can only remove, never add", () => {
    const hideFinance: UIConfig = { roleVisibility: { owner: ["/finance"] } };
    const withHide = effectiveModules("owner", hideFinance, perms);
    const baseline = effectiveModules("owner", EMPTY_UI_CONFIG, perms);

    expect(baseline).toContain("/finance");
    expect(withHide).not.toContain("/finance");

    // Nothing was ADDED as a side effect.
    const added = withHide.filter((m) => !baseline.includes(m));
    expect(added).toEqual([]);
  });

  it("disabling a module removes it for everyone", () => {
    const config: UIConfig = { modules: { "/placements": false } };
    for (const role of ["owner", "account_manager", "content_writer"]) {
      expect(effectiveModules(role, config, perms)).not.toContain("/placements");
    }
  });

  it("hiding a nav item hides the module too", () => {
    const config: UIConfig = { navigation: { items: [{ to: "/invoices", hidden: true }] } };
    expect(effectiveModules("owner", config, perms)).not.toContain("/invoices");
  });

  it("is never larger than the RBAC baseline, for any role and any config", () => {
    // The property that matters, asserted as a property rather than by example:
    // for a spread of configs, the effective set is a SUBSET of the baseline.
    const configs: UIConfig[] = [
      EMPTY_UI_CONFIG,
      { modules: Object.fromEntries(MODULE_IDS.map((m) => [m, true])) as UIConfig["modules"] },
      { roleVisibility: { content_writer: [], prospector: [], owner: [] } },
      { navigation: { items: MODULE_IDS.map((to) => ({ to, hidden: false })) } },
    ];

    for (const config of configs) {
      for (const role of ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer", "client_user"]) {
        const baseline = new Set(effectiveModules(role, EMPTY_UI_CONFIG, perms));
        const configured = effectiveModules(role, config, perms);

        const added = configured.filter((m) => !baseline.has(m));
        expect(added, `config granted ${added.join(",")} to ${role}`).toEqual([]);
      }
    }
  });
});

describe("findPermissionWidening", () => {
  it("finds nothing wrong with a narrowing config", () => {
    const config: UIConfig = {
      modules: { "/finance": false },
      roleVisibility: { content_writer: ["/content"] },
    };
    expect(findPermissionWidening(config, perms)).toEqual([]);
  });

  it("finds nothing wrong with an empty config", () => {
    expect(findPermissionWidening(EMPTY_UI_CONFIG, perms)).toEqual([]);
  });

  it("finds nothing wrong even when every module is marked true", () => {
    // `true` means "not disabled", NOT "grant". A naive checker that rejected any
    // `true` would make the Admin panel unusable; one that granted any `true`
    // would be a vulnerability. This asserts the middle ground.
    const config: UIConfig = {
      modules: Object.fromEntries(MODULE_IDS.map((m) => [m, true])) as UIConfig["modules"],
    };
    expect(findPermissionWidening(config, perms)).toEqual([]);
  });
});

describe("UI_CONFIG_SCHEMA — closed by construction", () => {
  it("rejects an unknown module id", () => {
    const result = UIConfigSchema.safeParse({ modules: { "/evil-route": true } });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown top-level key", () => {
    // `.strict()` — so a typo or an attempt to smuggle state is an error, not a
    // silently stored value.
    const result = UIConfigSchema.safeParse({ grantAll: true });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown key inside a nested section", () => {
    const result = UIConfigSchema.safeParse({ theme: { accent: "#112233", sql: "drop table" } });
    expect(result.success).toBe(false);
  });

  it("rejects a non-hex colour", () => {
    expect(UIConfigSchema.safeParse({ theme: { accent: "red" } }).success).toBe(false);
    expect(UIConfigSchema.safeParse({ theme: { accent: "javascript:alert(1)" } }).success).toBe(false);
  });

  it("rejects an unknown widget id", () => {
    expect(UIConfigSchema.safeParse({ dashboard: { order: ["notAWidget"] } }).success).toBe(false);
  });

  it("accepts a legitimate configuration", () => {
    const result = UIConfigSchema.safeParse({
      navigation: {
        sections: [{ id: "clients", label: "Customers" }],
        items: [{ to: "/invoices", label: "Billing" }],
      },
      modules: { "/publishers": false },
      roleVisibility: { prospector: ["/finance"] },
      tables: { "/invoices": { columns: ["invoice_number", "total"], pageSize: 25 } },
      dashboard: { order: ["metrics", "health"] },
      theme: { accent: "#4F5BEE", radius: "round" },
      branding: { appName: "Trivero Marketing" },
    });
    expect(result.success).toBe(true);
  });
});

describe("findUnknownIds", () => {
  it("rejects a column that is not in the module's registry", () => {
    const config = { tables: { "/invoices": { columns: ["invoice_number", "password_hash"] } } } as UIConfig;
    const unknown = findUnknownIds(config);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toContain("password_hash");
  });

  it("rejects a column borrowed from a different module", () => {
    // `dr` is a publisher column; naming it for invoices must not pass.
    const config = { tables: { "/invoices": { columns: ["dr"] } } } as UIConfig;
    expect(findUnknownIds(config)).toHaveLength(1);
  });

  it("accepts known columns", () => {
    const config = { tables: { "/invoices": { columns: ["invoice_number", "balance"] } } } as UIConfig;
    expect(findUnknownIds(config)).toEqual([]);
  });

  it("rejects table config for a module with no column registry", () => {
    const config = { tables: { "/payouts": { columns: ["amount"] } } } as unknown as UIConfig;
    const unknown = findUnknownIds(config);
    expect(unknown.length).toBeGreaterThan(0);
  });
});

describe("MODULE_PERMISSIONS — every module declares its gate", () => {
  it("maps every module id to a permission or null", () => {
    for (const moduleId of MODULE_IDS) {
      expect(moduleId in MODULE_PERMISSIONS).toBe(true);
    }
  });

  it("gives the dashboard and admin panel the right gates", () => {
    expect(MODULE_PERMISSIONS["/"]).toBeNull();
    expect(MODULE_PERMISSIONS["/admin"]).toBe("settings:manage");
    expect(MODULE_PERMISSIONS["/finance"]).toBe("reports:margins");
  });
});

describe("registries describe real things only", () => {
  /**
   * The first cut of the dashboard widget registry listed `placementStages` and
   * `recentActivity`, neither of which existed on the dashboard. The Admin panel
   * therefore offered switches for blocks nobody could see, and the two real
   * blocks could not be configured at all.
   *
   * A registry that describes imaginary widgets is worse than no registry: it
   * looks like control. These tests pin the registry to what actually renders.
   */
  it("every dashboard widget id is one the dashboard can render", () => {
    // Kept in step with `dashboard-page.tsx`, which reads
    // `shownWidgets.includes("<id>")` for exactly these three.
    expect([...DASHBOARD_WIDGET_IDS].sort()).toEqual(["gettingStarted", "health", "metrics"]);
  });

  it("every dashboard widget has a human label", () => {
    for (const id of DASHBOARD_WIDGET_IDS) {
      expect(DASHBOARD_WIDGET_LABELS[id]).toBeTruthy();
    }
  });

  it("every module with a column registry has at least one column", () => {
    for (const [moduleId, columns] of Object.entries(MODULE_COLUMNS)) {
      expect(columns.length, moduleId).toBeGreaterThan(0);
    }
  });

  it("column ids are unique within each module", () => {
    for (const [moduleId, columns] of Object.entries(MODULE_COLUMNS)) {
      expect(new Set(columns).size, moduleId).toBe(columns!.length);
    }
  });

  it("every module in the column registry is a real module id", () => {
    for (const moduleId of Object.keys(MODULE_COLUMNS)) {
      expect(MODULE_IDS).toContain(moduleId);
    }
  });
});
