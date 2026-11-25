import { z } from "zod";
import { ROLES } from "./roles.js";

/**
 * UI CUSTOMIZATION CONTRACT.
 *
 * One schema, shared by the API (which enforces it) and the web app (which types
 * itself from it). If the two ever disagree, the API wins — but they cannot
 * disagree, because there is only one definition.
 *
 * THREE DELIBERATE CHOICES, each closing a hole:
 *
 * 1. Every identifier is a CLOSED ENUM drawn from a registry below. A config
 *    cannot name a module, column or widget that does not exist, so it cannot
 *    point the UI at a route that is not real.
 *
 * 2. `.strict()` on every object. An unknown key is a validation ERROR, not a
 *    silently stored value — otherwise JSONB becomes a place to hide state that
 *    no one reads but everyone trusts.
 *
 * 3. Nothing here expresses PERMISSION. The schema can say "hide the Invoices
 *    module from prospectors"; it has no way to say "show the Invoices module to
 *    prospectors", because that would be a privilege grant. The enforcement
 *    function `findPermissionWidening` checks the same rule at the API layer.
 */

// ---------------------------------------------------------------------------
// The registry: what the Admin panel is allowed to name
// ---------------------------------------------------------------------------

/** Module identifiers, matching the `to` paths in the web navigation. */
export const MODULE_IDS = [
  "/",
  "/approvals",
  "/reports",
  "/finance",
  "/clients",
  "/agency-partners",
  "/campaigns",
  "/invoices",
  "/payments",
  "/publishers",
  "/prospects",
  "/placements",
  // The triage queue for links that could not be verified automatically. A module
  // in its own right rather than a tab under /placements, because it is a separate
  // job ("open the page and look") with its own permission.
  "/placements/review",
  "/outreach",
  "/content",
  "/anchors",
  "/suppliers",
  "/staff",
  "/audit",
  "/settings",
  "/admin",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

/** The permission that gates each module. Config can hide, never reveal. */
export const MODULE_PERMISSIONS: Record<ModuleId, string | null> = {
  "/": null,
  "/approvals": "placements:approve",
  "/reports": "reports:read",
  "/finance": "reports:margins",
  "/clients": "clients:read",
  "/agency-partners": "clients:read",
  "/campaigns": "campaigns:read",
  "/invoices": "invoices:read",
  "/payments": "payments:read",
  "/publishers": "publishers:read",
  "/prospects": "prospects:read",
  "/placements": "placements:read",
  "/placements/review": "placements:check",
  "/outreach": "touchpoints:read",
  "/content": "briefs:read",
  "/anchors": "reports:read",
  "/suppliers": "suppliers:read",
  "/staff": "staff:read",
  "/audit": "audit:read",
  "/settings": "settings:manage",
  "/admin": "settings:manage",
};

/** Navigation sections, matching `NAV_SECTIONS` ids. */
export const SECTION_IDS = ["overview", "clients", "fulfillment", "administration"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

/**
 * Dashboard widgets that can be shown, hidden and reordered.
 *
 * These MUST match the blocks the dashboard actually renders. The first version
 * listed `placementStages` and `recentActivity`, neither of which existed — so the
 * Admin panel offered switches for blocks nobody could see, while the two real
 * blocks could not be configured at all. A registry that describes imaginary
 * widgets is worse than no registry: it looks like control.
 */
export const DASHBOARD_WIDGET_IDS = ["metrics", "gettingStarted", "health"] as const;
export type DashboardWidgetId = (typeof DASHBOARD_WIDGET_IDS)[number];

/** Human labels for the Admin panel, so the UI does not hardcode a second list. */
export const DASHBOARD_WIDGET_LABELS: Record<DashboardWidgetId, string> = {
  metrics: "Headline metrics",
  gettingStarted: "Getting started",
  health: "System health",
};

/**
 * Columns the Admin panel may name, per module.
 *
 * This is a registry, not a reflection of the database. The API also validates
 * against its own SELECT list at query time, so a column named here that the
 * query does not return is simply not rendered — the registry cannot be used to
 * widen what the API sends.
 */
export const MODULE_COLUMNS: Partial<Record<ModuleId, readonly string[]>> = {
  "/invoices": ["invoice_number", "client_name", "effective_status", "total", "balance", "due_date"],
  "/payments": ["received_at", "invoice", "method", "reference", "amount"],
  "/placements": ["target_url", "anchor_text", "anchor_type", "pipeline_stage", "live_url", "live_date"],
  "/publishers": ["domain", "dr", "monthly_traffic", "spam_score", "status", "niche"],
  "/content": ["title", "status", "word_count", "submitted_at"],
  "/outreach": ["domain", "status", "template", "sent_at"],
  "/staff": ["email", "role", "is_active", "created_at"],
  "/audit": ["created_at", "actor", "action", "entity_type"],
};

/** Every known column id across every module, for cheap validation. */
export const ALL_COLUMN_IDS: ReadonlySet<string> = new Set(
  Object.values(MODULE_COLUMNS).flatMap((cols) => cols ?? []),
);

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a #rrggbb colour");

export const UIConfigSchema = z
  .object({
    /**
     * Navigation. Rename, reorder, hide — never "add".
     *
     * A section or item that is not in the registry cannot be described, so the
     * config cannot invent a tab.
     */
    navigation: z
      .object({
        sections: z
          .array(
            z
              .object({
                id: z.enum(SECTION_IDS),
                label: z.string().trim().min(1).max(40).optional(),
                order: z.number().int().min(0).max(100).optional(),
                hidden: z.boolean().optional(),
              })
              .strict(),
          )
          .max(20)
          .optional(),
        items: z
          .array(
            z
              .object({
                to: z.enum(MODULE_IDS),
                label: z.string().trim().min(1).max(40).optional(),
                order: z.number().int().min(0).max(100).optional(),
                hidden: z.boolean().optional(),
              })
              .strict(),
          )
          .max(40)
          .optional(),
      })
      .strict()
      .optional(),

    /** Module on/off. `false` disables; `true` is the default and changes nothing. */
    modules: z.record(z.enum(MODULE_IDS), z.boolean()).optional(),

    /**
     * Per-role hiding. The array lists modules to HIDE for that role.
     *
     * Modelled as a deny-list on purpose: an allow-list would read as "these are
     * the modules this role may see", which is a permission grant in disguise.
     */
    roleVisibility: z.record(z.enum(ROLES), z.array(z.enum(MODULE_IDS)).max(40)).optional(),

    /** Table presentation, per module. */
    tables: z
      .record(
        z.enum(MODULE_IDS),
        z
          .object({
            columns: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
            order: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
            pageSize: z.number().int().min(5).max(200).optional(),
          })
          .strict(),
      )
      .optional(),

    /** Dashboard composition. */
    dashboard: z
      .object({
        hidden: z.array(z.enum(DASHBOARD_WIDGET_IDS)).max(20).optional(),
        order: z.array(z.enum(DASHBOARD_WIDGET_IDS)).max(20).optional(),
      })
      .strict()
      .optional(),

    /** Theme. Accent colours only — spacing and structure are not exposed. */
    theme: z
      .object({
        accent: hexColor.optional(),
        sidebar: hexColor.optional(),
        radius: z.enum(["sharp", "default", "round"]).optional(),
      })
      .strict()
      .optional(),

    /** Branding shown in the sidebar, login screen and page title. */
    branding: z
      .object({
        appName: z.string().trim().min(1).max(40).optional(),
        tagline: z.string().trim().max(80).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type UIConfig = z.infer<typeof UIConfigSchema>;

/** An empty config — the shape a fresh organisation starts with. */
export const EMPTY_UI_CONFIG: UIConfig = {};

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * The modules a role actually gets, after RBAC and config are combined.
 *
 * THIS function is the security boundary, and its shape is the whole argument:
 *
 *     RBAC is the FIRST term. Config is applied with `filter`, never with `union`.
 *
 * There is no branch in which a config entry adds a module. A module is visible
 * only if RBAC permits it AND the config has not removed it. `modules[path] = true`
 * is therefore a no-op rather than a grant — `true` means "not disabled", not
 * "allow".
 *
 * Exported so the API and the tests use the same implementation. If the API ever
 * grew its own copy of this logic, that copy is where a privilege escalation would
 * eventually appear.
 */
export function effectiveModules(
  role: string,
  config: UIConfig,
  rolePermissions: (role: string, permission: string) => boolean,
): ModuleId[] {
  const hiddenForRole = new Set(config.roleVisibility?.[role as keyof typeof config.roleVisibility] ?? []);

  return MODULE_IDS.filter((moduleId) => {
    const permission = MODULE_PERMISSIONS[moduleId];

    // 1. RBAC is the ceiling. No permission, no module — regardless of config.
    if (permission !== null && !rolePermissions(role, permission)) return false;

    // 2. Config may disable a module entirely.
    if (config.modules?.[moduleId] === false) return false;

    // 3. Config may hide a module from this role specifically.
    if (hiddenForRole.has(moduleId)) return false;

    // 4. Navigation-level hiding (the item's `hidden` flag) applies too.
    const navItem = config.navigation?.items?.find((i) => i.to === moduleId);
    if (navItem?.hidden) return false;

    return true;
  });
}

/**
 * Verifies a config cannot widen access, by construction rather than by inspection.
 *
 * It computes the effective module list for EVERY role, with the config applied,
 * and compares against the same list with NO config at all. If the config ever
 * produced a module that RBAC alone would not, this returns a violation.
 *
 * That is a much stronger check than reading the config for suspicious keys: it
 * tests the actual outcome, so it stays correct even if `effectiveModules` is
 * changed later. A test that inspects the input would pass on a broken
 * implementation; this one cannot.
 */
export function findPermissionWidening(
  config: UIConfig,
  rolePermissions: (role: string, permission: string) => boolean,
): string[] {
  const violations: string[] = [];

  for (const role of ROLES) {
    const baseline = new Set(effectiveModules(role, EMPTY_UI_CONFIG, rolePermissions));
    const configured = effectiveModules(role, config, rolePermissions);

    for (const moduleId of configured) {
      if (!baseline.has(moduleId)) {
        // Unreachable by design — `effectiveModules` filters rather than unions.
        // Kept as an assertion so a future refactor that introduced a grant path
        // fails loudly at the API boundary instead of shipping.
        violations.push(`Config grants ${moduleId} to ${role}, which RBAC does not permit`);
      }
    }
  }

  return violations;
}

/**
 * Finds ids that are not in the registry.
 *
 * The Zod enums already reject unknown module/section/widget ids. This catches
 * the one thing they cannot: COLUMN names, which are free strings validated here
 * against `MODULE_COLUMNS` so a config cannot name a column the API does not
 * return.
 */
export function findUnknownIds(config: UIConfig): string[] {
  const unknown: string[] = [];

  for (const [moduleId, table] of Object.entries(config.tables ?? {})) {
    const allowed = MODULE_COLUMNS[moduleId as ModuleId];
    if (!allowed) {
      // A module with no column registry has nothing configurable. Naming a table
      // config for it is a mistake worth reporting rather than ignoring.
      if ((table?.columns?.length ?? 0) > 0 || (table?.order?.length ?? 0) > 0) {
        unknown.push(`${moduleId}: this module has no configurable columns`);
      }
      continue;
    }

    for (const column of [...(table?.columns ?? []), ...(table?.order ?? [])]) {
      if (!allowed.includes(column)) {
        unknown.push(`${moduleId}: unknown column "${column}"`);
      }
    }
  }

  return unknown;
}
