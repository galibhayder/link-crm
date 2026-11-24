import { Router } from "express";
import { clientsRouter } from "./clients/index.js";
import { agencyPartnersRouter } from "./agency-partners/index.js";
import { campaignsRouter } from "./campaigns/index.js";
import { publishersRouter } from "./publishers/index.js";
import { prospectsRouter } from "./prospects/index.js";
import { placementsRouter } from "./placements/index.js";
import { pricingRouter } from "./pricing/index.js";
import { costsRouter } from "./costs/index.js";
import { invoicesRouter } from "./invoices/index.js";
import { paymentsRouter } from "./payments/index.js";
import { payoutsRouter } from "./payouts/index.js";
import { expensesRouter } from "./expenses/index.js";
import { reportsRouter } from "./reports/index.js";
import { suppliersRouter } from "./suppliers/index.js";
import { staffRouter } from "./staff/index.js";
import { settingsRouter } from "./settings/index.js";
import { meRouter } from "./me/index.js";
import { profileRouter } from "./profile/index.js";
import { auditRouter } from "./audit/index.js";
import { importRouter } from "./import/index.js";
import { outreachRouter } from "./outreach/index.js";
import { contentRouter } from "./content/index.js";
import { anchorsRouter } from "./anchors/index.js";
import { notificationsRouter } from "./notifications/index.js";
import { adminUiRouter } from "./admin-ui/index.js";
import { adminFieldsRouter } from "./admin-fields/index.js";
import { adminViewsRouter } from "./admin-views/index.js";
import { asyncRoute, ok } from "../lib/http.js";

/**
 * INTERNAL SURFACE — /api/v1
 *
 * Every route here sits behind `authenticate`, so nothing in this router may be
 * reachable without a user JWT. Scheduled jobs are deliberately NOT mounted here
 * (see app.ts): they authenticate with an HMAC because no user is involved, and
 * mounting them under `authenticate` would make them permanently unreachable.
 */
export const internalRouter: Router = Router();

internalRouter.use("/me", meRouter);
internalRouter.use("/profile", profileRouter);
internalRouter.use("/staff", staffRouter);
internalRouter.use("/audit", auditRouter);
internalRouter.use("/import", importRouter);
internalRouter.use("/outreach", outreachRouter);
internalRouter.use("/content", contentRouter);
internalRouter.use("/anchors", anchorsRouter);
internalRouter.use("/notifications", notificationsRouter);
internalRouter.use("/admin/ui", adminUiRouter);
internalRouter.use("/admin/fields", adminFieldsRouter);
internalRouter.use("/admin/views", adminViewsRouter);
internalRouter.use("/clients", clientsRouter);
internalRouter.use("/agency-partners", agencyPartnersRouter);
internalRouter.use("/campaigns", campaignsRouter);
internalRouter.use("/suppliers", suppliersRouter);
internalRouter.use("/publishers", publishersRouter);
internalRouter.use("/prospects", prospectsRouter);
internalRouter.use("/placements", placementsRouter);
internalRouter.use("/pricing", pricingRouter);
internalRouter.use("/costs", costsRouter);
internalRouter.use("/invoices", invoicesRouter);
internalRouter.use("/payments", paymentsRouter);
internalRouter.use("/payouts", payoutsRouter);
internalRouter.use("/expenses", expensesRouter);
internalRouter.use("/reports", reportsRouter);
internalRouter.use("/settings", settingsRouter);

/**
 * Deliberately returns the caller's effective permissions. The web app builds
 * its navigation from this rather than duplicating the matrix in the client,
 * so a hidden menu item and a rejected request can never disagree.
 */
internalRouter.get(
  "/me/permissions",
  asyncRoute(async (req, res) => {
    const { permissionsFor } = await import("@crm/shared");
    ok(res, {
      role: req.auth!.role,
      permissions: permissionsFor(req.auth!.role),
      organizationId: req.auth!.orgId,
      surface: req.auth!.surface,
    });
  }),
);
