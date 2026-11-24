import { Router } from "express";
import { z } from "zod";
import {
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
  can,
  type UIConfig,
} from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, ok, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest } from "../../lib/audit.js";
import { logger } from "../../lib/logger.js";

/**
 * ADMIN UI CUSTOMIZATION.
 *
 * Read this file with one question in mind: can any request here widen access?
 *
 * The answer is no, and the shape of that guarantee is:
 *
 *   - `effectiveModules` is imported from @crm/shared and filters RBAC FIRST.
 *     Config is applied afterwards with `filter`, never a union.
 *   - `findPermissionWidening` computes the effective module list for EVERY role
 *     with the config applied, and compares it to the same list with no config.
 *     If the config ever produced a module RBAC would not, the write is refused.
 *   - The schema is `.strict()` with closed enums, so a config cannot name a
 *     module, column or widget that does not exist.
 *
 * This router can therefore only describe the UI. It cannot change what anyone is
 * permitted to do, and it never executes DDL — there is no SQL string built from
 * user input anywhere in this file.
 */
export const adminUiRouter: Router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const roleHasPermission = (role: string, permission: string) => can(role as never, permission as never);

interface UiSettingsRow {
  config: unknown;
  version: number;
  updated_at: string;
  updated_by: string | null;
}

/** Reads the org's config, tolerating a missing row (see the note in migration 0032). */
async function readConfig(db: { from: (t: string) => unknown }, orgId: string) {
  const client = db as unknown as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (col: string, v: string) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
      };
    };
  };

  const { data, error } = await client
    .from("ui_settings")
    .select("config, version, updated_at, updated_by")
    .eq("organization_id", orgId)
    .maybeSingle();

  if (error) throw Errors.internal(String(error));

  const row = data as UiSettingsRow | null;

  // Validating on READ as well as write is deliberate: if a row was edited by
  // hand (or written by an older schema), the API must not hand an invalid
  // document to the client and let it half-apply.
  if (!row) {
    return { config: EMPTY_UI_CONFIG, version: 0, updatedAt: null, updatedBy: null, valid: true };
  }

  const parsed = UIConfigSchema.safeParse(row.config ?? {});
  if (!parsed.success) {
    logger.warn(
      { issues: parsed.error.issues.slice(0, 5), orgId },
      "stored UI config failed validation — serving defaults instead",
    );
    return { config: EMPTY_UI_CONFIG, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by, valid: false };
  }

  return { config: parsed.data, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by, valid: true };
}

/**
 * The navigation the caller should actually see.
 *
 * Built from the SAME `effectiveModules` the security tests exercise, so the menu
 * and the enforcement cannot disagree about what is reachable.
 */
function buildEffective(role: string, config: UIConfig) {
  const modules = effectiveModules(role, config, roleHasPermission);

  const labelFor = (moduleId: string) =>
    config.navigation?.items?.find((i) => i.to === moduleId)?.label ?? null;

  const sectionLabel = (id: string) =>
    config.navigation?.sections?.find((s) => s.id === id)?.label ?? null;

  return {
    modules,
    // Labels only for modules the caller can actually reach — a hidden module's
    // custom label is not sensitive, but returning it would imply access.
    labels: Object.fromEntries(modules.map((m) => [m, labelFor(m)])),
    sectionLabels: Object.fromEntries(["overview", "clients", "fulfillment", "administration"].map((s) => [s, sectionLabel(s)])),
    theme: config.theme ?? {},
    branding: config.branding ?? {},
    dashboard: config.dashboard ?? {},
    // Column preferences are presentation only; the API still returns its own
    // SELECT list, so this cannot widen what columns exist.
    tables: Object.fromEntries(
      Object.entries(config.tables ?? {}).filter(([moduleId]) => modules.includes(moduleId as never)),
    ),
  };
}

// ---------------------------------------------------------------------------
// GET /admin/ui/config — the raw document, for the Admin editor
// ---------------------------------------------------------------------------
adminUiRouter.get(
  "/config",
  authorize("settings:manage"),
  asyncRoute(async (req, res) => {
    const stored = await readConfig(req.auth!.db, req.auth!.orgId);

    ok(res, {
      config: stored.config,
      version: stored.version,
      updatedAt: stored.updatedAt,
      updatedBy: stored.updatedBy,
      // Surfaced so the Admin page can warn that the stored document was rejected
      // and defaults are being served — otherwise a broken config looks like a
      // working one until someone notices the nav is wrong.
      valid: stored.valid,
    });
  }),
);

// ---------------------------------------------------------------------------
// PUT /admin/ui/config — validate, refuse widening, save
// ---------------------------------------------------------------------------
adminUiRouter.put(
  "/config",
  authorize("settings:manage"),
  validate({ body: z.object({ config: UIConfigSchema }) }),
  asyncRoute(async (req, res) => {
    const incoming = (req.body as { config: UIConfig }).config;

    // 1. Unknown ids (columns are free strings; the enums cover the rest).
    const unknown = findUnknownIds(incoming);
    if (unknown.length > 0) {
      throw Errors.badRequest(`Unknown identifiers: ${unknown.slice(0, 5).join("; ")}`);
    }

    // 2. Widening. Computed by outcome, not by inspecting the input — so a future
    //    refactor of `effectiveModules` cannot quietly introduce a grant.
    const widening = findPermissionWidening(incoming, roleHasPermission);
    if (widening.length > 0) {
      throw Errors.forbidden(`This configuration would widen access: ${widening.slice(0, 3).join("; ")}`);
    }

    // 3. The Admin panel must never become unreachable.
    //
    // There are THREE independent ways to remove it, and the first version of this
    // guard checked only two. `navigation.items[].hidden` slipped through: an admin
    // could hide every nav item, the API accepted it, and the owner was left with a
    // blank sidebar and no UI route back to the page that could undo it. The data
    // was recoverable only by an API call nobody could discover.
    //
    // Each shape is rejected here rather than by special-casing the frontend,
    // because the config is what other clients would trust too.
    if (incoming.modules?.["/admin"] === false) {
      throw Errors.badRequest("The Admin panel cannot disable itself");
    }
    if (incoming.roleVisibility?.owner?.includes("/admin")) {
      throw Errors.badRequest("The Admin panel cannot be hidden from the owner");
    }
    if (incoming.navigation?.items?.some((i) => i.to === "/admin" && i.hidden)) {
      throw Errors.badRequest("The Admin panel cannot be hidden from the navigation");
    }

    // A config that hides everything else is still a lockout in spirit: the owner
    // lands on a dashboard with no destinations. Require at least one reachable
    // module besides Admin, so the app remains usable.
    const hiddenItems = new Set(
      (incoming.navigation?.items ?? []).filter((i) => i.hidden).map((i) => i.to),
    );
    const ownerHidden = new Set(incoming.roleVisibility?.owner ?? []);
    const disabled = new Set(
      Object.entries(incoming.modules ?? {})
        .filter(([, v]) => v === false)
        .map(([k]) => k),
    );

    const stillReachable = MODULE_IDS.filter(
      (m) => m !== "/admin" && !hiddenItems.has(m) && !ownerHidden.has(m) && !disabled.has(m),
    );

    // "At least one" is too weak a floor: leaving only /approvals and /admin is
    // technically usable and practically a lockout. Three is the smallest set that
    // still looks like an application rather than a mistake.
    const MIN_REACHABLE = 3;
    if (stillReachable.length < MIN_REACHABLE) {
      throw Errors.badRequest(
        `This would leave the owner with only ${stillReachable.length} reachable module(s). ` +
          `Keep at least ${MIN_REACHABLE} sections visible.`,
      );
    }

    const { data, error } = await req.auth!.db
      .from("ui_settings")
      .upsert(
        {
          organization_id: req.auth!.orgId,
          config: incoming,
          updated_by: req.auth!.userId,
        },
        { onConflict: "organization_id" },
      )
      .select("version, updated_at")
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "ui_settings",
      entityId: req.auth!.orgId,
      action: "update",
      diff: {
        sections: Object.keys(incoming),
        modulesDisabled: Object.entries(incoming.modules ?? {})
          .filter(([, v]) => v === false)
          .map(([k]) => k),
        roleVisibility: incoming.roleVisibility ?? {},
      },
    });

    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// POST /admin/ui/config/reset — back to defaults
// ---------------------------------------------------------------------------
adminUiRouter.post(
  "/config/reset",
  authorize("settings:manage"),
  validate({ body: z.object({ section: z.enum(["all", "navigation", "modules", "tables", "dashboard", "theme", "branding", "roleVisibility"]).default("all") }).optional() }),
  asyncRoute(async (req, res) => {
    const section = (req.body as { section?: string } | undefined)?.section ?? "all";

    const current = await readConfig(req.auth!.db, req.auth!.orgId);
    let next: UIConfig = current.config;

    if (section === "all") {
      next = EMPTY_UI_CONFIG;
    } else {
      // Section-scoped reset, so an owner can undo one bad editor without losing
      // everything else they configured.
      const { [section as keyof UIConfig]: _removed, ...rest } = current.config;
      next = rest as UIConfig;
    }

    const { data, error } = await req.auth!.db
      .from("ui_settings")
      .upsert(
        { organization_id: req.auth!.orgId, config: next, updated_by: req.auth!.userId },
        { onConflict: "organization_id" },
      )
      .select("version")
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "ui_settings",
      entityId: req.auth!.orgId,
      action: "update",
      diff: { reset: section },
    });

    ok(res, { ...data, config: next });
  }),
);

// ---------------------------------------------------------------------------
// GET /admin/ui/effective — what THIS caller should render
//
// The only endpoint the app needs at boot. Every internal role may call it; a
// client or publisher cannot reach this surface at all.
// ---------------------------------------------------------------------------
adminUiRouter.get(
  "/effective",
  asyncRoute(async (req, res) => {
    const stored = await readConfig(req.auth!.db, req.auth!.orgId);
    const role = req.auth!.role;

    ok(res, {
      ...buildEffective(role, stored.config),
      version: stored.version,
      valid: stored.valid,
      role,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /admin/ui/registries — the legal ids, for the Admin editor
// ---------------------------------------------------------------------------
adminUiRouter.get(
  "/registries",
  authorize("settings:manage"),
  asyncRoute(async (_req, res) => {
    ok(res, {
      modules: MODULE_IDS.map((id) => ({
        id,
        permission: MODULE_PERMISSIONS[id],
      })),
      sections: [
        { id: "overview", label: "Overview" },
        { id: "clients", label: "Clients" },
        { id: "fulfillment", label: "Fulfillment" },
        { id: "administration", label: "Administration" },
      ],
      columns: MODULE_COLUMNS,
      // Drawn from the shared registry so the Admin panel cannot offer a widget
      // the dashboard does not render — which is exactly what happened when this
      // list was written by hand.
      widgets: DASHBOARD_WIDGET_IDS.map((id) => ({ id, label: DASHBOARD_WIDGET_LABELS[id] })),
      // The role matrix, so the Admin UI can show which modules a role could ever
      // have — and disable the "hide" toggle for ones it already cannot reach.
      rolePermissions: Object.fromEntries(
        ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer", "client_user"].map((role) => [
          role,
          MODULE_IDS.filter((m) => {
            const p = MODULE_PERMISSIONS[m];
            return p === null || roleHasPermission(role, p);
          }),
        ]),
      ),
    });
  }),
);
