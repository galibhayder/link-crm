import { Router } from "express";
import { z } from "zod";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, ok, validate, parsedQuery } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";

/**
 * CUSTOM FIELD DEFINITIONS.
 *
 * The table already existed from Phase 1 with seven field types and a per-entity
 * uniqueness constraint. This exposes CRUD for the Admin panel rather than adding
 * a parallel table — the values already live in `custom_field_values` with typed
 * columns and RLS.
 *
 * Two rules that protect existing data:
 *
 *   1. `entity_type` and `key` are IMMUTABLE once values exist. Changing either
 *      would orphan every captured value: the unique key is
 *      (organization_id, entity_type, key), so a rename silently detaches rows.
 *
 *   2. Deleting a definition CASCADES to its values. That is correct when a field
 *      was created by mistake and has no data, and destructive when it has some —
 *      so a delete with values present is refused, and `is_active: false` is the
 *      offered alternative.
 */
export const adminFieldsRouter: Router = Router();

const idParams = z.object({ id: z.string().uuid() });

/** The seven types the table's CHECK constraint permits. */
const FIELD_TYPES = ["text", "number", "date", "select", "multiselect", "boolean", "url"] as const;
const ENTITY_TYPES = ["client", "campaign", "publisher", "prospect", "placement"] as const;

const definitionSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  // A machine key: lowercase, no spaces. It is stored in JSON payloads, so a key
  // with spaces or capitals would be awkward to address later.
  key: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9_]*$/, "Use lowercase letters, digits and underscores, starting with a letter"),
  label: z.string().trim().min(1).max(80),
  fieldType: z.enum(FIELD_TYPES),
  options: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  isRequired: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  isActive: z.boolean().default(true),
});

adminFieldsRouter.get(
  "/",
  authorize("settings:manage"),
  validate({ query: z.object({ entityType: z.enum(ENTITY_TYPES).optional() }) }),
  asyncRoute(async (req, res) => {
    const { entityType } = parsedQuery<{ entityType?: string }>(req);

    let query = req.auth!.db
      .from("custom_field_definitions")
      .select("id, entity_type, key, label, field_type, options, is_required, is_active, sort_order, created_at")
      .order("entity_type")
      .order("sort_order");

    if (entityType) query = query.eq("entity_type", entityType);

    const { data, error } = await query;
    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

adminFieldsRouter.post(
  "/",
  authorize("settings:manage"),
  validate({ body: definitionSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof definitionSchema>;

    // A select/multiselect with no options is a field nobody can fill in. The
    // CHECK constraint permits any jsonb, so this is the only place it is caught.
    if ((b.fieldType === "select" || b.fieldType === "multiselect") && (b.options ?? []).length === 0) {
      throw Errors.badRequest("A select field needs at least one option");
    }

    const { data, error } = await req.auth!.db
      .from("custom_field_definitions")
      .insert({
        organization_id: req.auth!.orgId,
        entity_type: b.entityType,
        key: b.key,
        label: b.label,
        field_type: b.fieldType,
        // Options are meaningless for non-select types; storing them anyway would
        // leave a field carrying configuration its UI never reads.
        options: b.fieldType === "select" || b.fieldType === "multiselect" ? (b.options ?? []) : [],
        is_required: b.isRequired,
        sort_order: b.sortOrder,
        is_active: b.isActive,
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That field key already exists for this entity");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "custom_field_definition",
      entityId: (data as { id: string }).id,
      action: "create",
      diff: { entityType: b.entityType, key: b.key, fieldType: b.fieldType },
    });

    created(res, data);
  }),
);

adminFieldsRouter.patch(
  "/:id",
  authorize("settings:manage"),
  validate({
    params: idParams,
    body: definitionSchema
      .partial()
      // `entityType` and `key` are accepted by the schema but rejected below when
      // values exist — the schema cannot see the data, so the check is at runtime.
      .omit({}),
  }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;
    const b = req.body as Partial<z.infer<typeof definitionSchema>>;

    const { data: before, error: findErr } = await req.auth!.db
      .from("custom_field_definitions")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (findErr) throw Errors.internal(findErr.message);
    if (!before) throw Errors.notFound("Custom field");

    const current = before as { entity_type: string; key: string; field_type: string };

    // How many values does this field already hold?
    const { count } = await req.auth!.db
      .from("custom_field_values")
      .select("id", { count: "exact", head: true })
      .eq("definition_id", id);

    const hasValues = (count ?? 0) > 0;

    if (hasValues && b.entityType !== undefined && b.entityType !== current.entity_type) {
      throw Errors.badRequest("This field already has values, so its entity type cannot change");
    }
    if (hasValues && b.key !== undefined && b.key !== current.key) {
      throw Errors.badRequest("This field already has values, so its key cannot change");
    }

    // Changing the type of a populated field would misread its stored values: a
    // number in value_text is invisible to a date picker.
    if (hasValues && b.fieldType !== undefined && b.fieldType !== current.field_type) {
      throw Errors.badRequest("This field already has values, so its type cannot change");
    }

    if ((b.fieldType === "select" || b.fieldType === "multiselect") && b.options !== undefined && b.options.length === 0) {
      throw Errors.badRequest("A select field needs at least one option");
    }

    const patch: Record<string, unknown> = {};
    if (b.entityType !== undefined) patch.entity_type = b.entityType;
    if (b.key !== undefined) patch.key = b.key;
    if (b.label !== undefined) patch.label = b.label;
    if (b.fieldType !== undefined) patch.field_type = b.fieldType;
    if (b.options !== undefined) patch.options = b.options;
    if (b.isRequired !== undefined) patch.is_required = b.isRequired;
    if (b.sortOrder !== undefined) patch.sort_order = b.sortOrder;
    if (b.isActive !== undefined) patch.is_active = b.isActive;

    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data, error } = await req.auth!.db
      .from("custom_field_definitions")
      .update(patch)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw Errors.conflict("That field key already exists for this entity");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "custom_field_definition",
      entityId: id,
      action: "update",
      diff: diffOf(before, data),
    });

    ok(res, data);
  }),
);

adminFieldsRouter.delete(
  "/:id",
  authorize("settings:manage"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const id = req.params.id as string;

    const { data: before } = await req.auth!.db
      .from("custom_field_definitions")
      .select("id, entity_type, key, label")
      .eq("id", id)
      .maybeSingle();

    if (!before) throw Errors.notFound("Custom field");

    const { count } = await req.auth!.db
      .from("custom_field_values")
      .select("id", { count: "exact", head: true })
      .eq("definition_id", id);

    // Deleting cascades. With values that is data loss disguised as tidying, so it
    // is refused and deactivation is offered instead — which keeps the data.
    if ((count ?? 0) > 0) {
      throw Errors.badRequest(
        `This field has ${count} value(s) recorded. Deactivate it instead to keep the data.`,
      );
    }

    const { error } = await req.auth!.db.from("custom_field_definitions").delete().eq("id", id);
    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "custom_field_definition",
      entityId: id,
      action: "delete",
      diff: before as Record<string, unknown>,
    });

    ok(res, { deleted: true });
  }),
);
