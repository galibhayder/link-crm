import { Router } from "express";
import { z } from "zod";
import { importCommitSchema, importPreviewSchema, uuidSchema } from "@crm/shared";
import { can } from "@crm/shared";
import { asyncRoute, created, ok, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { orgOf } from "../../lib/crud.js";
import { commitImport, prepareImport, recordsFromObjects } from "../../lib/import-engine.js";
import { auditFromRequest } from "../../lib/audit.js";
import { exportFilename, toCsv } from "../../lib/csv.js";
import { IMPORT_SPECS } from "./specs.js";
import { admin } from "../../integrations/supabase.js";

/**
 * BULK CSV IMPORT.
 *
 * Three-step contract:
 *   1. POST /import/:entity/preview  — parse, validate, detect duplicates
 *   2. GET  /import/:entity/jobs/:id — re-read the stored preview
 *   3. POST /import/:entity/commit   — apply exactly what was previewed
 *
 * The preview is persisted so the commit cannot apply something the user never
 * saw. That is the property that makes a bulk import safe to offer at all.
 */
export const importRouter: Router = Router();

const entityParams = z.object({
  entity: z.enum(["clients", "agency_partners", "publishers", "prospects", "campaigns"]),
});

const jobParams = entityParams.extend({ id: uuidSchema });

/** Permission required to import into each entity. */
const IMPORT_PERMISSION = {
  clients: "clients:write",
  agency_partners: "clients:write",
  publishers: "publishers:write",
  prospects: "prospects:write",
  campaigns: "campaigns:write",
} as const;

type ImportEntity = keyof typeof IMPORT_PERMISSION;

/**
 * authorize() cannot be parameterised at declaration time, so the check is
 * explicit — but it uses the SAME matrix as every other route.
 */
function assertCanImport(req: Parameters<Parameters<typeof asyncRoute>[0]>[0], entity: ImportEntity) {
  if (!can(req.auth!.role, IMPORT_PERMISSION[entity])) {
    throw Errors.forbidden(`Your role cannot import ${entity.replace("_", " ")}`);
  }
}

importRouter.post(
  "/:entity/preview",
  validate({ params: entityParams, body: importPreviewSchema }),
  asyncRoute(async (req, res) => {
    const entity = req.params.entity as ImportEntity;
    assertCanImport(req, entity);

    const body = req.body as z.infer<typeof importPreviewSchema>;
    const orgId = orgOf(req);

    // Prospects and campaigns are scoped to a parent; refuse early rather than
    // failing once per row on insert.
    if (entity === "prospects" && !body.defaults?.campaignId) {
      throw Errors.badRequest("campaignId is required when importing prospects");
    }
    if (entity === "campaigns" && !body.defaults?.clientId) {
      throw Errors.badRequest("clientId is required when importing campaigns");
    }

    const spec = IMPORT_SPECS[entity]();
    const { records, missingRequired } = recordsFromObjects(body.rows, spec.columns);

    if (missingRequired.length > 0) {
      throw Errors.badRequest(`The file is missing required column(s): ${missingRequired.join(", ")}`, {
        missingRequired,
      });
    }

    const { verdicts, summary } = await prepareImport({
      spec: spec as never,
      db: req.auth!.db,
      orgId,
      records,
      duplicateStrategy: body.duplicateStrategy,
      defaults: body.defaults,
    });

    const { data: job, error } = await req.auth!.db
      .from("import_jobs")
      .insert({
        organization_id: orgId,
        created_by: req.auth!.userId,
        entity,
        status: "preview",
        file_name: body.fileName ?? null,
        rows: body.rows,
        results: verdicts,
        summary,
      })
      .select("id")
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "import_job",
      entityId: job.id,
      action: "create",
      diff: { entity, summary, duplicateStrategy: body.duplicateStrategy },
    });

    ok(res, {
      jobId: job.id,
      entity,
      summary,
      verdicts,
      columns: spec.columns.map((c) => ({
        field: c.field,
        required: Boolean(c.required),
        example: c.example,
        description: c.description,
      })),
    });
  }),
);

importRouter.get(
  "/:entity/jobs/:id",
  validate({ params: jobParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("import_jobs")
      .select("id, entity, status, file_name, summary, results, created_at, committed_at")
      .eq("id", req.params.id)
      .eq("entity", req.params.entity)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Import job");
    ok(res, data);
  }),
);

importRouter.post(
  "/:entity/commit",
  validate({ params: entityParams, body: importCommitSchema }),
  asyncRoute(async (req, res) => {
    const entity = req.params.entity as ImportEntity;
    assertCanImport(req, entity);

    const body = req.body as z.infer<typeof importCommitSchema>;
    const orgId = orgOf(req);

    // Read the stored preview through service_role so the commit applies the
    // SAVED verdicts. Reading them from the request body would let a caller
    // supply their own verdicts and bypass validation entirely.
    const { data: job, error: jobErr } = await admin()
      .from("import_jobs")
      .select("id, organization_id, entity, status, results, created_by")
      .eq("id", body.jobId)
      .maybeSingle();

    if (jobErr) throw Errors.internal(jobErr.message);
    // 404 rather than 403 for a job in another organization: confirming it
    // exists would leak that a record with that id is present elsewhere.
    if (!job) throw Errors.notFound("Import job");
    if (job.organization_id !== orgId) throw Errors.notFound("Import job");

    // A preview belongs to the person who made it. Without this, one staff
    // member could commit a file another had reviewed and decided against —
    // the preview is a review step, and a review is meaningless if someone else
    // can skip it. The owner may act on any job in the organisation.
    const isCreator = job.created_by === req.auth!.userId;
    const isOwner = req.auth!.role === "owner";
    if (!isCreator && !isOwner) {
      throw Errors.forbidden("This import was created by another user");
    }

    if (job.entity !== entity) throw Errors.badRequest("Import job belongs to a different entity");
    if (job.status !== "preview") throw Errors.conflict("This import has already been applied or cancelled");

    const result = await commitImport({
      db: admin(),
      table: IMPORT_SPECS[entity]().table,
      verdicts: (job.results ?? []) as never[],
      includeRowIndexes: body.includeRowIndexes,
    });

    await admin()
      .from("import_jobs")
      .update({ status: "committed", committed_at: new Date().toISOString() })
      .eq("id", job.id);

    await auditFromRequest(req, {
      entityType: "import_job",
      entityId: job.id,
      action: "create",
      diff: { entity, committed: result },
    });

    ok(res, { jobId: job.id, ...result });
  }),
);

importRouter.delete(
  "/:entity/jobs/:id",
  validate({ params: jobParams }),
  asyncRoute(async (req, res) => {
    const entity = req.params.entity as ImportEntity;
    assertCanImport(req, entity);

    const { data, error } = await admin()
      .from("import_jobs")
      .update({ status: "cancelled" })
      .eq("id", req.params.id)
      .eq("entity", entity)
      .eq("organization_id", orgOf(req))
      .eq("status", "preview")
      .select("id")
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Pending import");
    ok(res, { cancelled: true });
  }),
);

/**
 * A downloadable template so a user can see the expected columns rather than
 * guessing and discovering the problem 500 rows later.
 */
importRouter.get(
  "/:entity/template",
  validate({ params: entityParams }),
  asyncRoute(async (req, res) => {
    const entity = req.params.entity as ImportEntity;
    const spec = IMPORT_SPECS[entity]();

    const headers = spec.columns.map((c) => c.field);
    const example: Record<string, unknown> = {};
    for (const column of spec.columns) {
      example[column.field] = column.example ?? "";
    }

    const csv = toCsv(headers, [example]);

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${exportFilename(`${entity}-template`)}"`);
    res.send(csv);
  }),
);
