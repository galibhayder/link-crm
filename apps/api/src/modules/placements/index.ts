import { Router } from "express";
import { z } from "zod";
import { can, uuidSchema } from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";
import { orgOf, pageMeta, rangeFor, resolveOrder, resolveSort, searchClause, toColumnPatch, assertSameOrg } from "../../lib/crud.js";
import { recordFromRequest } from "../../lib/placement-history.js";
import {
  ALLOWED_TRANSITIONS,
  canTransition,
  derivedStatusFor,
  PLACEMENT_STAGES,
  stageIndex,
  stageTimestamps,
  type PlacementStage,
} from "./pipeline.js";

export const placementsRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

/**
 * Internal columns for staff views.
 *
 * `negotiated_cost` is deliberately ABSENT. It used to live here, and that made
 * the wholesale cost readable by account_manager and content_writer — the exact
 * leak the three-tier money split exists to prevent (see migration 0018). The
 * agreed figure now lives only in `placement_costs`, behind `costs:read`.
 */
const COLUMNS =
  "id, campaign_id, prospect_id, publisher_id, supplier_id, target_url, anchor_text, anchor_type, live_url, link_type, rel_attribute, status, pipeline_stage, scheduled_date, live_date, index_status, index_status_manual, removal_detected_at, last_checked_at, link_review_state, link_reviewed_at, link_reviewed_by, link_review_note, link_reviewed_check_id, assigned_to, content_assignee, content_due_date, submitted_at, client_approved_at, client_approved_by, client_approval_note, client_rejected_reason, internal_notes, notes, created_at, updated_at";

const MAP: Record<string, string> = {
  campaignId: "campaign_id",
  prospectId: "prospect_id",
  publisherId: "publisher_id",
  supplierId: "supplier_id",
  targetUrl: "target_url",
  anchorText: "anchor_text",
  anchorType: "anchor_type",
  liveUrl: "live_url",
  linkType: "link_type",
  relAttribute: "rel_attribute",
  status: "status",
  pipelineStage: "pipeline_stage",
  scheduledDate: "scheduled_date",
  assignedTo: "assigned_to",
  contentAssignee: "content_assignee",
  contentDueDate: "content_due_date",
  internalNotes: "internal_notes",
  notes: "notes",
};

/**
 * Record the negotiated wholesale cost in TIER 2.
 *
 * `negotiatedCost` is still accepted on the placement endpoints because that is
 * what callers already send, but it is NOT a column on `placements` any more —
 * storing it there leaked it to every internal role (migration 0018). It is
 * written to `placement_costs`, which account_manager and content_writer have no
 * policy for, so a role that should not see the figure cannot read it back.
 *
 * A caller without `costs:write` is refused rather than silently ignored: a
 * write that quietly does nothing is how a wrong number ends up in a report.
 */
async function writeNegotiatedCost(
  req: Parameters<typeof auditFromRequest>[0],
  placementId: string,
  cost: number,
  currency: string,
): Promise<void> {
  if (!can(req.auth!.role, "costs:write")) {
    throw Errors.forbidden(
      "You cannot record a publisher cost: that requires the costs:write permission",
    );
  }

  const { error } = await req.auth!.db.from("placement_costs").upsert(
    {
      organization_id: req.auth!.orgId,
      placement_id: placementId,
      supplier_cost: cost,
      currency,
      agreed_at: new Date().toISOString(),
      agreed_by: req.auth!.userId,
    },
    { onConflict: "placement_id" },
  );

  if (error) {
    // 42501 here means the tier-2 policy refused the write, which is a
    // permission problem and must not masquerade as a server fault.
    if (error.code === "42501") throw Errors.forbidden("You cannot record a publisher cost");
    throw Errors.internal(error.message);
  }
}

const SORTABLE = [
  "created_at",
  "updated_at",
  "pipeline_stage",
  "live_date",
  "scheduled_date",
  "content_due_date",
  "target_url",
] as const;

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(40).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  campaignId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
  pipelineStage: z.string().optional(),
  assignedTo: uuidSchema.optional(),
  publisherId: uuidSchema.optional(),
  status: z.string().optional(),
});

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------
const createSchema = z.object({
  campaignId: uuidSchema,
  prospectId: uuidSchema.nullish(),
  publisherId: uuidSchema.nullish(),
  supplierId: uuidSchema.nullish(),
  targetUrl: z.string().trim().url("A valid target URL is required"),
  /**
   * The published article URL.
   *
   * It has to be settable here and on PATCH, not only through `/transition`: a
   * publication that has nothing to do with the pipeline (a re-post, a corrected
   * address) still needs its URL recorded, and previously the field was silently
   * dropped by PATCH because it was absent from this schema.
   *
   * `assertStorableUrl` below rejects internal addresses at write time, so a
   * loopback URL never reaches the database — the fetch-time guard is the second
   * line, not the first.
   */
  liveUrl: z
    .string()
    .trim()
    .url("A valid live URL is required")
    .nullish()
    .transform((v) => v || null),
  anchorText: z.string().trim().max(300).nullish().transform((v) => v || null),
  anchorType: z.enum(["branded", "exact_match", "partial_match", "generic", "naked_url", "image_alt"]).nullish(),
  linkType: z.enum(["dofollow", "nofollow", "ugc", "sponsored"]).nullish(),
  pipelineStage: z.enum(PLACEMENT_STAGES).default("prospected"),
  assignedTo: uuidSchema.nullish(),
  contentAssignee: uuidSchema.nullish(),
  contentDueDate: z.string().trim().nullish(),
  negotiatedCost: z.coerce.number().min(0).nullish(),
  negotiatedCurrency: z.string().trim().length(3).default("USD"),
  internalNotes: z.string().trim().max(10_000).nullish().transform((v) => v || null),
  notes: z.string().trim().max(10_000).nullish().transform((v) => v || null),
});

placementsRouter.post(
  "/",
  authorize("placements:write"),
  validate({ body: createSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    const orgId = orgOf(req);

    // Authorization BEFORE resource lookup.
    //
    // The tier-2 check used to sit after the campaign query, so a caller asking
    // for something they may not have got "Campaign not found" instead of
    // "forbidden" — a confusing 400 that also hinted the campaign might exist.
    // A permission the caller lacks should be reported first, every time.
    if (body.negotiatedCost != null && !can(req.auth!.role, "costs:write")) {
      throw Errors.forbidden(
        "You cannot record a publisher cost: that requires the costs:write permission",
      );
    }

    // The campaign must be visible to this caller. RLS enforces it, but this
    // gives a clear message instead of a foreign-key failure.
    const { data: campaign } = await req.auth!.db
      .from("campaigns")
      .select("id")
      .eq("id", body.campaignId)
      .maybeSingle();
    if (!campaign) throw Errors.badRequest("Campaign not found");

    if (body.assignedTo) await assertSameOrg(req.auth!.db, "profiles", body.assignedTo, orgId, "Assignee");
    if (body.contentAssignee) {
      await assertSameOrg(req.auth!.db, "profiles", body.contentAssignee, orgId, "Content assignee");
    }
    if (body.publisherId) await assertSameOrg(req.auth!.db, "publishers", body.publisherId, orgId, "Publisher");

    // A new placement cannot START in a late stage.
    //
    // The transition endpoint enforces the state machine — live needs a URL,
    // approval needs attribution. Creation used to accept any stage, so
    // `pipelineStage: 'live'` wrote a `live` row with no URL: the pipeline skipped
    // and link monitoring got something it could never check (migration 0019 adds
    // the database constraint, this is the clear error message).
    if (body.pipelineStage !== "prospected" && body.pipelineStage !== "pitched") {
      throw Errors.badRequest(
        "A new placement starts at prospected or pitched. Move it along the pipeline after it exists.",
      );
    }

    // Refuse an internal address BEFORE it is stored.
    //
    // The verification service also guards at fetch time, but storing a loopback or
    // metadata URL is a problem in itself: it would appear in reports, exports and
    // any future feature that reads it. Rejecting at the edge means the bad value
    // never exists.
    if (body.liveUrl) {
      const { assertStorableUrl } = await import("../../integrations/url-safety.js");
      try {
        assertStorableUrl(body.liveUrl);
      } catch (err) {
        throw Errors.badRequest(`Live URL rejected: ${(err as Error).message}`);
      }
    }

    // The negotiated cost is tier 2 and needs its own permission — already
    // checked at the top of this handler, before any lookup.

    const { data, error } = await req.auth!.db
      .from("placements")
      .insert({
        organization_id: orgId,
        ...toColumnPatch(body as Record<string, unknown>, MAP),
        content_due_date: body.contentDueDate ? new Date(body.contentDueDate).toISOString().slice(0, 10) : null,
      })
      .select(COLUMNS)
      .single();

    if (error) {
      if (error.code === "23514") throw Errors.badRequest("Unknown pipeline stage for this organization");
      throw Errors.internal(error.message);
    }

    // Tier 2, after the row exists (it is keyed on placement_id).
    if (body.negotiatedCost != null) {
      await writeNegotiatedCost(req, data.id, body.negotiatedCost, body.negotiatedCurrency);
    }

    await recordFromRequest(req, {
      placementId: data.id,
      eventType: "created",
      toStage: data.pipeline_stage,
      summary: `Placement created at ${data.pipeline_stage}`,
      detail: { targetUrl: data.target_url, campaignId: data.campaign_id },
    });

    await auditFromRequest(req, {
      entityType: "placement",
      entityId: data.id,
      action: "create",
      diff: { targetUrl: data.target_url, stage: data.pipeline_stage },
    });

    // Echo the cost back for callers entitled to it, so a create response has the
    // same shape as a read. Without this the client could not confirm what it
    // just recorded.
    const [withCost] = await attachAgreedCost(req, [data as { id: string }]);
    created(res, withCost);
  }),
);

/**
 * Attach the agreed wholesale cost, but only for callers entitled to see it.
 *
 * Reads through `v_placement_negotiation`, which is `security_invoker`, so the
 * tier-2 policy decides what comes back — a role with no policy gets no rows and
 * the field is simply absent. The permission check here is the second gate, so a
 * caller without `costs:read` never even issues the query.
 *
 * The field is OMITTED rather than nulled for unauthorised callers: a null would
 * render as "$0" in a UI that formats whatever it receives.
 */
async function attachAgreedCost<T extends { id: string }>(
  req: Parameters<typeof auditFromRequest>[0],
  rows: T[],
): Promise<Array<T & { agreed_cost?: number | null }>> {
  if (!can(req.auth!.role, "costs:read") || rows.length === 0) return rows;

  const { data, error } = await req.auth!.db
    .from("v_placement_negotiation")
    .select("placement_id, supplier_cost")
    .in("placement_id", rows.map((r) => r.id));

  if (error) {
    // A cost that cannot be read must not fail the whole board; the field is
    // simply absent, which the UI already handles.
    return rows;
  }

  const byId = new Map(
    ((data ?? []) as Array<{ placement_id: string; supplier_cost: number }>).map((r) => [
      r.placement_id,
      r.supplier_cost,
    ]),
  );

  return rows.map((r) => ({ ...r, agreed_cost: byId.get(r.id) ?? null }));
}

// ---------------------------------------------------------------------------
// LIST
// ---------------------------------------------------------------------------
placementsRouter.get(
  "/",
  authorize("placements:read"),
  validate({ query: listQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof listQuery>>(req);
    const { page, limit } = query;

    const sort = resolveSort(query.sort, SORTABLE, "updated_at");
    const order = resolveOrder(query.order, sort, ["updated_at", "created_at", "live_date"]);
    const { from, to } = rangeFor(page, limit);

    let campaignIds: string[] | null = null;
    if (query.clientId) {
      const { data: campaigns } = await req.auth!.db
        .from("campaigns")
        .select("id")
        .eq("client_id", query.clientId)
        .is("deleted_at", null);
      campaignIds = ((campaigns ?? []) as Array<{ id: string }>).map((c) => c.id);
      if (campaignIds.length === 0) {
        ok(res, [], pageMeta(page, limit, 0, sort, order));
        return;
      }
    }

    let dbQuery = req.auth!.db
      .from("placements")
      .select(`${COLUMNS}, publisher:publishers(id, domain, dr), assignee:profiles!placements_assigned_to_fkey(id, full_name)`, {
        count: "exact",
      })
      .is("deleted_at", null)
      .order(sort, { ascending: order === "asc", nullsFirst: false })
      .range(from, to);

    const search = searchClause(query.q, ["target_url", "anchor_text", "live_url"]);
    if (search) dbQuery = dbQuery.or(search);

    if (query.campaignId) dbQuery = dbQuery.eq("campaign_id", query.campaignId);
    if (campaignIds) dbQuery = dbQuery.in("campaign_id", campaignIds);
    if (query.pipelineStage) dbQuery = dbQuery.eq("pipeline_stage", query.pipelineStage);
    if (query.assignedTo) dbQuery = dbQuery.eq("assigned_to", query.assignedTo);
    if (query.publisherId) dbQuery = dbQuery.eq("publisher_id", query.publisherId);
    if (query.status) dbQuery = dbQuery.eq("status", query.status);

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    const withCosts = await attachAgreedCost(req, (data ?? []) as Array<{ id: string }>);
    ok(res, withCosts, pageMeta(page, limit, count ?? 0, sort, order));
  }),
);

// ---------------------------------------------------------------------------
// BOARD — the kanban payload
//
// Declared before /:id so "board" is not parsed as an id.
// ---------------------------------------------------------------------------
placementsRouter.get(
  "/board",
  authorize("placements:read"),
  validate({
    query: z.object({
      campaignId: uuidSchema.optional(),
      assignedTo: uuidSchema.optional(),
      clientId: uuidSchema.optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<{ campaignId?: string; assignedTo?: string; clientId?: string }>(req);

    const { data: stages, error: stageErr } = await req.auth!.db
      .from("pipeline_stages")
      .select("key, label, sort_order, is_won, is_lost")
      .eq("applies_to", "placement")
      .order("sort_order", { ascending: true });

    if (stageErr) throw Errors.internal(stageErr.message);

    let campaignIds: string[] | null = null;
    if (query.clientId) {
      const { data: campaigns } = await req.auth!.db
        .from("campaigns")
        .select("id")
        .eq("client_id", query.clientId)
        .is("deleted_at", null);
      campaignIds = ((campaigns ?? []) as Array<{ id: string }>).map((c) => c.id);
    }

    // A generous cap: a board is useless paginated, and a campaign rarely holds
    // more than a few hundred placements.
    let dbQuery = req.auth!.db
      .from("placements")
      .select(
        "id, campaign_id, publisher_id, target_url, anchor_text, anchor_type, live_url, " +
          "pipeline_stage, status, assigned_to, content_assignee, content_due_date, " +
          "client_approved_at, live_date, updated_at",
      )
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(1000);

    if (query.campaignId) dbQuery = dbQuery.eq("campaign_id", query.campaignId);
    if (campaignIds) dbQuery = dbQuery.in("campaign_id", campaignIds);
    if (query.assignedTo) dbQuery = dbQuery.eq("assigned_to", query.assignedTo);

    const { data: placements, error } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    const withCosts = await attachAgreedCost(req, (placements ?? []) as unknown as Array<{ id: string }>);
    const rows = withCosts as unknown as Array<{ pipeline_stage: string }>;
    const stageRows = (stages ?? []) as Array<{ key: string; label: string; sort_order: number }>;

    ok(res, {
      stages: stageRows.map((s) => ({
        ...s,
        placements: rows.filter((p) => p.pipeline_stage === s.key),
      })),
      // A placement whose stage is not in the configured list would otherwise
      // vanish from the board. Surfacing it is better than silently losing it.
      orphans: rows.filter((p) => !stageRows.some((s) => s.key === p.pipeline_stage)),
    });
  }),
);

// ---------------------------------------------------------------------------
// READ ONE, with history and related records
// ---------------------------------------------------------------------------
placementsRouter.get(
  "/:id([0-9a-fA-F-]{36})",
  authorize("placements:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("placements")
      .select(
        `${COLUMNS},
         campaign:campaigns(id, name, client_id),
         publisher:publishers(id, domain, dr, monthly_traffic),
         assignee:profiles!placements_assigned_to_fkey(id, full_name, email)`,
      )
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Placement");

    // The agreed wholesale cost comes from tier 2, for callers entitled to it.
    const [withCost] = await attachAgreedCost(req, [data as { id: string }]);
    ok(res, withCost);
  }),
);

placementsRouter.get(
  "/:id([0-9a-fA-F-]{36})/history",
  authorize("placements:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("placement_events")
      .select("id, event_type, from_stage, to_stage, actor_id, actor_name, summary, detail, created_at")
      .eq("placement_id", req.params.id)
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

// ---------------------------------------------------------------------------
// STAGE TRANSITION — the drag-and-drop endpoint
//
// A dedicated route rather than a PATCH on the whole row, because a stage move
// has rules (allowed transitions, required fields per stage, history, client
// approval) that must not be bypassable by sending pipeline_stage in a generic
// update. Migration 0014's trigger validates the stage exists; this validates
// the MOVE is legal.
// ---------------------------------------------------------------------------
const transitionSchema = z.object({
  toStage: z.enum(PLACEMENT_STAGES),
  note: z.string().trim().max(2000).optional(),
  /** Required to enter client_approved: who approved it, on the client side. */
  clientApprovalNote: z.string().trim().max(2000).optional(),
  liveUrl: z.string().trim().url().optional(),
});

placementsRouter.post(
  "/:id([0-9a-fA-F-]{36})/transition",
  authorize("placements:write"),
  validate({ params: idParams, body: transitionSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof transitionSchema>;
    const orgId = orgOf(req);

    const { data: current, error: readErr } = await req.auth!.db
      .from("placements")
      .select("id, campaign_id, pipeline_stage, status, live_url")
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (readErr) throw Errors.internal(readErr.message);
    if (!current) throw Errors.notFound("Placement");

    const from = current.pipeline_stage as string;

    if (!canTransition(from, body.toStage)) {
      // List the stages that ARE reachable, not the whole pipeline. The previous
      // message enumerated all six, which reads like an invitation to try them.
      const allowed = ALLOWED_TRANSITIONS[from as PlacementStage] ?? [];
      throw Errors.badRequest(`Cannot move from ${from} to ${body.toStage}. From here you can reach: ${allowed.join(", ")}`, {
        from,
        to: body.toStage,
        allowed,
      });
    }

    // Approving on a client's behalf is a distinct authority from doing the work.
    // Without this, content_writer — who holds placements:write — could record a
    // client approval they are not entitled to give.
    if (body.toStage === "client_approved" && from !== "client_approved" && !can(req.auth!.role, "placements:approve")) {
      throw Errors.forbidden("Recording a client approval requires the placements:approve permission");
    }

    // Entering `live` without a URL would make monitoring impossible.
    const liveUrl = body.liveUrl ?? current.live_url;
    if (body.toStage === "live" && !liveUrl) {
      throw Errors.badRequest("A live URL is required before marking a placement live");
    }

    // Entering client_approved is a claim that the CLIENT said yes. It must be
    // attributable, otherwise the stage means nothing.
    if (body.toStage === "client_approved" && !body.clientApprovalNote) {
      throw Errors.badRequest("Record how the client approved this placement");
    }

    const patch: Record<string, unknown> = { pipeline_stage: body.toStage, ...stageTimestamps(body.toStage) };

    // Keep the operational status from contradicting the pipeline.
    const derived = derivedStatusFor(body.toStage, current.status as string);
    if (derived) patch.status = derived;

    if (body.toStage === "live" && body.liveUrl) patch.live_url = body.liveUrl;

    if (body.toStage === "client_approved") {
      patch.client_approved_at = new Date().toISOString();
      patch.client_approved_by = req.auth!.userId;
      patch.client_approval_note = body.clientApprovalNote;
      patch.client_rejected_reason = null;
    }

    const { data, error } = await req.auth!.db
      .from("placements")
      .update(patch)
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) {
      if (error.code === "23514") throw Errors.badRequest("Unknown pipeline stage for this organization");
      throw Errors.internal(error.message);
    }
    if (!data) throw Errors.notFound("Placement");

    const isApproval = body.toStage === "client_approved" && from !== "client_approved";

    await recordFromRequest(req, {
      placementId: data.id,
      eventType: isApproval ? "client_approved" : "stage_change",
      fromStage: from,
      toStage: body.toStage,
      summary: body.note ?? `${from} → ${body.toStage}`,
      detail: { note: body.note ?? null, clientApprovalNote: body.clientApprovalNote ?? null },
    });

    await auditFromRequest(req, {
      entityType: "placement",
      entityId: data.id,
      action: "status_change",
      diff: { pipeline_stage: { from, to: body.toStage }, note: body.note },
    });

    // Status change notifications: the assignee hears about their own work.
    if (data.assigned_to && data.assigned_to !== req.auth!.userId) {
      const { admin } = await import("../../integrations/supabase.js");
      await admin()
        .from("notifications")
        .insert({
          organization_id: orgId,
          user_id: data.assigned_to,
          type: "placement_stage_changed",
          payload: {
            placementId: data.id,
            targetUrl: data.target_url,
            from,
            to: body.toStage,
          },
        })
        .then(({ error: notifyErr }) => {
          if (notifyErr) {
            // A missing notification must not fail the transition.
            void import("../../lib/logger.js").then(({ logger }) =>
              logger.warn({ err: notifyErr }, "could not notify assignee of stage change"),
            );
          }
        });
    }

    const [withCost] = await attachAgreedCost(req, [data as { id: string }]);
    ok(res, withCost);
  }),
);

// ---------------------------------------------------------------------------
// CLIENT DECISION — approve or reject
//
// Separate from /transition because rejection is not a stage: a client saying no
// returns the work to `pitched` with a recorded reason, which is a different
// event and a different conversation.
// ---------------------------------------------------------------------------
const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().min(3, "Say what the client decided").max(2000),
});

placementsRouter.post(
  "/:id([0-9a-fA-F-]{36})/client-decision",
  // `placements:approve`, not `placements:write`.
  //
  // The two are deliberately different. account_manager holds approve but not
  // write — approving pitched sites is that role's job — so gating on write
  // locked them out of their own responsibility while letting content_writer,
  // who holds write but not approve, record a client's decision for them.
  authorize("placements:approve"),
  validate({ params: idParams, body: decisionSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof decisionSchema>;

    const { data: current, error: readErr } = await req.auth!.db
      .from("placements")
      .select("id, pipeline_stage")
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    if (readErr) throw Errors.internal(readErr.message);
    if (!current) throw Errors.notFound("Placement");

    const from = current.pipeline_stage as string;

    // Only a placement that has been pitched can be approved or rejected.
    if (from !== "pitched" && from !== "client_approved") {
      throw Errors.badRequest(`A client decision applies to a pitched placement, not one at ${from}`);
    }

    const patch =
      body.decision === "approve"
        ? {
            pipeline_stage: "client_approved",
            client_approved_at: new Date().toISOString(),
            client_approved_by: req.auth!.userId,
            client_approval_note: body.note,
            client_rejected_reason: null,
          }
        : {
            pipeline_stage: "pitched",
            client_approved_at: null,
            client_approved_by: null,
            client_approval_note: null,
            client_rejected_reason: body.note,
          };

    const { data, error } = await req.auth!.db
      .from("placements")
      .update(patch)
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Placement");

    await recordFromRequest(req, {
      placementId: data.id,
      eventType: body.decision === "approve" ? "client_approved" : "client_rejected",
      fromStage: from,
      toStage: patch.pipeline_stage,
      summary: body.note,
    });

    await auditFromRequest(req, {
      entityType: "placement",
      entityId: data.id,
      action: "status_change",
      diff: { clientDecision: body.decision, note: body.note },
    });

    const [withCost] = await attachAgreedCost(req, [data as { id: string }]);
    ok(res, withCost);
  }),
);

// ---------------------------------------------------------------------------
// UPDATE — everything except the stage, which has its own route
// ---------------------------------------------------------------------------
const patchSchema = createSchema.partial().omit({ pipelineStage: true });

placementsRouter.patch(
  "/:id([0-9a-fA-F-]{36})",
  authorize("placements:write"),
  validate({ params: idParams, body: patchSchema }),
  asyncRoute(async (req, res) => {
    const body = req.body as Partial<z.infer<typeof patchSchema>>;
    const orgId = orgOf(req);

    if (body.assignedTo !== undefined) {
      await assertSameOrg(req.auth!.db, "profiles", body.assignedTo, orgId, "Assignee");
    }
    if (body.contentAssignee !== undefined) {
      await assertSameOrg(req.auth!.db, "profiles", body.contentAssignee, orgId, "Content assignee");
    }
    if (body.publisherId !== undefined) {
      await assertSameOrg(req.auth!.db, "publishers", body.publisherId, orgId, "Publisher");
    }

    // Same write-time guard as creation: never store an internal address.
    if (body.liveUrl) {
      const { assertStorableUrl } = await import("../../integrations/url-safety.js");
      try {
        assertStorableUrl(body.liveUrl);
      } catch (err) {
        throw Errors.badRequest(`Live URL rejected: ${(err as Error).message}`);
      }
    }

    const patch = toColumnPatch(body as Record<string, unknown>, MAP);
    if (body.contentDueDate !== undefined) {
      patch.content_due_date = body.contentDueDate ? new Date(body.contentDueDate).toISOString().slice(0, 10) : null;
    }
    if (Object.keys(patch).length === 0 && body.negotiatedCost === undefined) {
      throw Errors.badRequest("No fields to update");
    }

    const { data: before } = await req.auth!.db
      .from("placements")
      .select(COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();
    if (!before) throw Errors.notFound("Placement");

    // The cost is not a placement column any more (migration 0018). Read the
    // previous figure from the view so the history entry is accurate, then write
    // the new one to tier 2 under `costs:write`.
    let previousCost: number | null = null;
    if (body.negotiatedCost !== undefined) {
      const { data: prev } = await req.auth!.db
        .from("v_placement_negotiation")
        .select("supplier_cost")
        .eq("placement_id", req.params.id)
        .maybeSingle();
      previousCost = (prev as { supplier_cost?: number } | null)?.supplier_cost ?? null;
    }

    let data = before;

    if (Object.keys(patch).length > 0) {
      const { data: updated, error } = await req.auth!.db
        .from("placements")
        .update(patch)
        .eq("id", req.params.id)
        .select(COLUMNS)
        .maybeSingle();

      if (error) throw Errors.internal(error.message);
      if (!updated) throw Errors.notFound("Placement");
      data = updated;
    }

    if (body.negotiatedCost !== undefined) {
      if (body.negotiatedCost === null) {
        if (!can(req.auth!.role, "costs:write")) {
          throw Errors.forbidden("You cannot change a publisher cost");
        }
        await req.auth!.db.from("placement_costs").delete().eq("placement_id", req.params.id);
      } else {
        await writeNegotiatedCost(req, req.params.id!, body.negotiatedCost, body.negotiatedCurrency ?? "USD");
      }
    }

    // Assignment and cost changes are worth their own history entries: they
    // answer "who has been sitting on this?" and "what did we agree?".
    if (body.assignedTo !== undefined && body.assignedTo !== before.assigned_to) {
      await recordFromRequest(req, {
        placementId: data.id,
        eventType: "assignment_change",
        summary: "Assignee changed",
        detail: { from: before.assigned_to, to: body.assignedTo },
      });
    }
    if (body.publisherId !== undefined && body.publisherId !== before.publisher_id) {
      await recordFromRequest(req, {
        placementId: data.id,
        eventType: "publisher_assigned",
        summary: "Publisher assigned",
        detail: { from: before.publisher_id, to: body.publisherId },
      });
    }
    if (body.negotiatedCost !== undefined && body.negotiatedCost !== previousCost) {
      await recordFromRequest(req, {
        placementId: req.params.id!,
        eventType: "cost_agreed",
        summary: "Negotiated cost updated",
        detail: { from: previousCost, to: body.negotiatedCost },
      });
    }
    if (body.internalNotes !== undefined && body.internalNotes !== before.internal_notes) {
      await recordFromRequest(req, {
        placementId: data.id,
        eventType: "note_added",
        summary: "Internal note updated",
      });
    }

    await auditFromRequest(req, {
      entityType: "placement",
      entityId: data.id,
      action: "update",
      diff: diffOf(before as Record<string, unknown>, patch),
    });

    // Same shape as a read, including the cost for callers entitled to it.
    const [withCost] = await attachAgreedCost(req, [data as { id: string }]);
    ok(res, withCost);
  }),
);

// ---------------------------------------------------------------------------
// ARCHIVE / RESTORE
// ---------------------------------------------------------------------------
placementsRouter.delete(
  "/:id([0-9a-fA-F-]{36})",
  authorize("placements:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    // Archiving goes through the SECURITY DEFINER function, not a direct UPDATE.
    //
    // `UPDATE ... SET deleted_at = now()` fails under RLS with "new row violates
    // row-level security policy" even though the WITH CHECK only tests
    // organization_id: PostgREST reads the row back, and the SELECT policy requires
    // `deleted_at is null`. This is the same wall all five CRM modules hit in
    // Phase 3, and `archive_record_rpc` is the fix they already share
    // (migration 0012; placements added in 0017).
    //
    // The function re-derives organization and role from the caller's claims, so
    // the role list passed here is a second check, not the only one.
    //
    // The stage is read BEFORE archiving: once `deleted_at` is set the row no
    // longer matches the SELECT policy, so it cannot be read back afterwards.
    const { data: before } = await req.auth!.db
      .from("placements")
      .select("pipeline_stage")
      .eq("id", req.params.id)
      .is("deleted_at", null)
      .maybeSingle();

    const { data, error } = await req.auth!.db.rpc("archive_record_rpc", {
      p_table: "placements",
      p_id: req.params.id,
      p_roles: ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer"],
    });

    if (error) {
      if (error.code === "42501") throw Errors.forbidden(error.message);
      throw Errors.internal(error.message);
    }

    const archived = (data as Array<{ id: string; label: string | null }> | null)?.[0];
    if (!archived) throw Errors.notFound("Placement");

    await recordFromRequest(req, {
      placementId: archived.id,
      eventType: "archived",
      fromStage: (before as { pipeline_stage?: string } | null)?.pipeline_stage ?? null,
      summary: "Placement archived",
      detail: { targetUrl: archived.label },
    });

    await auditFromRequest(req, {
      entityType: "placement",
      entityId: archived.id,
      action: "delete",
      diff: { archived: true, targetUrl: archived.label },
    });

    noContent(res);
  }),
);

placementsRouter.post(
  "/:id([0-9a-fA-F-]{36})/restore",
  authorize("placements:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    // Restore uses the matching SECURITY DEFINER function for the mirror-image
    // reason: while `deleted_at` is set the row is invisible to the SELECT policy,
    // so a direct UPDATE cannot see or return it.
    const { data: restored, error } = await req.auth!.db.rpc("restore_record_rpc", {
      p_table: "placements",
      p_id: req.params.id,
      p_roles: ["owner", "account_manager", "prospector", "outreach_specialist", "content_writer"],
    });

    if (error) {
      if (error.code === "42501") throw Errors.forbidden(error.message);
      throw Errors.internal(error.message);
    }

    if (!restored) throw Errors.notFound("Placement");

    // Now visible again.
    const { data, error: readErr } = await req.auth!.db
      .from("placements")
      .select(COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();

    if (readErr) throw Errors.internal(readErr.message);
    if (!data) throw Errors.notFound("Placement");

    await recordFromRequest(req, {
      placementId: data.id,
      eventType: "restored",
      toStage: data.pipeline_stage,
      summary: "Placement restored",
    });

    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// EXPORT
// ---------------------------------------------------------------------------
placementsRouter.get(
  "/export/csv",
  authorize("placements:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("placements")
      .select(
        "target_url, anchor_text, anchor_type, live_url, link_type, status, pipeline_stage, " +
          "scheduled_date, live_date, index_status, notes",
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (error) throw Errors.internal(error.message);

    const { toCsv, exportFilename } = await import("../../lib/csv.js");
    const headers = [
      "target_url", "anchor_text", "anchor_type", "live_url", "link_type", "status",
      "pipeline_stage", "scheduled_date", "live_date", "index_status", "notes",
    ];
    const csv = toCsv(headers, (data ?? []) as unknown as Array<Record<string, unknown>>);

    await auditFromRequest(req, {
      entityType: "placement",
      action: "export",
      diff: { rows: data?.length ?? 0 },
    });

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="${exportFilename("placements")}"`);
    res.send(csv);
  }),
);

/** Stage metadata, for the UI to render the board without hardcoding them. */
placementsRouter.get(
  "/options/stages",
  authorize("placements:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("pipeline_stages")
      .select("key, label, sort_order, is_won, is_lost")
      .eq("applies_to", "placement")
      .order("sort_order", { ascending: true });

    if (error) throw Errors.internal(error.message);
    ok(
      res,
      (data ?? []).map((s: { key: string }) => ({ ...s, index: stageIndex(s.key) })),
    );
  }),
);

// ---------------------------------------------------------------------------
// LINK MONITORING — restored from Phase 1-3; it must not be lost to the rewrite.
// ---------------------------------------------------------------------------
placementsRouter.get(
  "/:id([0-9a-fA-F-]{36})/checks",
  authorize("placements:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("link_checks")
      .select("*")
      .eq("placement_id", req.params.id)
      .order("checked_at", { ascending: false })
      .limit(50);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

/**
 * THE REVIEW QUEUE.
 *
 * A JavaScript-rendered page cannot be judged from its server HTML, so
 * verification returns `needs_manual_review` instead of a false `link_missing` or
 * a false `ok`. This is where those verdicts come to be answered.
 *
 * Read through `admin()` against `v_link_review_queue`, which keeps "latest check
 * per placement" as a single DISTINCT ON rather than a hand-rolled reduce over a
 * paginated list. The view is service_role-only, so this aggregate cannot leak
 * through PostgREST to a portal user.
 */
placementsRouter.get(
  "/review-queue",
  authorize("placements:check"),
  asyncRoute(async (req, res) => {
    const { admin } = await import("../../integrations/supabase.js");

    const { data, error } = await admin()
      .from("v_link_review_queue")
      .select("*")
      .eq("organization_id", orgOf(req))
      .order("checked_at", { ascending: true })
      .limit(200);

    if (error) throw Errors.internal(error.message);

    const rows = data ?? [];
    ok(res, rows, { total: rows.length });
  }),
);

/**
 * RESOLVE A REVIEW.
 *
 * The reviewer opens the page, looks, and records what they saw. Three properties
 * this endpoint must have:
 *
 *   1. The decision is tied to the OBSERVATION that was adjudicated (`checkId`),
 *      so a stale browser tab cannot silently apply a decision to a newer, and
 *      possibly different, check.
 *   2. It records WHO and WHEN. The existing `PATCH /:id/index-status` captures
 *      neither, and that gap is not worth reproducing.
 *   3. `missing` records an observation (`removal_detected_at`) and does NOT move
 *      the placement. Changing status stays a human decision on the board, which
 *      is the rule stated on the verification endpoint above.
 *
 * The suppression this creates is deliberately temporary: the `check-links` job
 * clears it whenever the automatic verdict becomes judgeable, so a link that
 * genuinely disappears later is still caught.
 */
placementsRouter.post(
  "/:id([0-9a-fA-F-]{36})/review",
  authorize("placements:check"),
  validate({
    params: idParams,
    body: z.object({
      resolution: z.enum(["present", "missing"]),
      /** Which observation was adjudicated. Required, so the decision is anchored. */
      checkId: uuidSchema,
      note: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { resolution: "present" | "missing"; checkId: string; note?: string };

    const { data: placement, error: pErr } = await req.auth!.db
      .from("placements")
      .select("id, status, removal_detected_at")
      .eq("id", req.params.id)
      .maybeSingle();

    if (pErr) throw Errors.internal(pErr.message);
    if (!placement) throw Errors.notFound("Placement");

    // The check must belong to this placement AND still be the thing that needs
    // reviewing. Anything else means the page has moved on since the tab loaded.
    const { data: check, error: cErr } = await req.auth!.db
      .from("link_checks")
      .select("id, placement_id, verdict, checked_at")
      .eq("id", b.checkId)
      .eq("placement_id", placement.id)
      .maybeSingle();

    if (cErr) throw Errors.internal(cErr.message);
    if (!check) throw Errors.badRequest("That check does not belong to this placement");
    if (check.verdict !== "needs_manual_review") {
      throw Errors.badRequest(
        "That check has already been superseded. Reload the review queue and resolve the current one.",
      );
    }

    const patch: Record<string, unknown> = {
      link_review_state: b.resolution === "present" ? "confirmed_present" : "confirmed_missing",
      link_reviewed_at: new Date().toISOString(),
      link_reviewed_by: req.auth!.userId,
      link_review_note: b.note || null,
      link_reviewed_check_id: check.id,
    };

    // An OBSERVATION, not a transition. Preserve the first time the absence was
    // noticed: if a reviewer confirms it missing twice, the date that matters is
    // the earliest one. `status` is deliberately untouched — moving a placement to
    // `removed` is a decision a human makes on the board.
    if (b.resolution === "missing") {
      patch.removal_detected_at = placement.removal_detected_at ?? new Date().toISOString();
    } else if (placement.removal_detected_at) {
      // The reviewer looked and found it. A stale `removal_detected_at` from an
      // earlier observation would otherwise read as "still removed".
      patch.removal_detected_at = null;
    }

    const { data, error } = await req.auth!.db
      .from("placements")
      .update(patch)
      .eq("id", placement.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Placement");

    await auditFromRequest(req, {
      entityType: "placement",
      entityId: placement.id,
      action: "update",
      diff: {
        linkReview: {
          from: null,
          to: { resolution: b.resolution, checkId: check.id, checkedAt: check.checked_at },
        },
        ...(b.note ? { note: b.note } : {}),
      },
    });

    // The queue changed, so tell the client rather than making it guess.
    ok(res, { ...data, stillInQueue: false });
  }),
);

/**
 * On-demand verification.
 *
 * Answers all five questions and records each one. Two deliberate choices:
 *
 *   - A fetch failure is `unreachable`, never `link_missing`. Cloudflare, a rate
 *     limit or a 403 says nothing about whether the link is on the page, and
 *     conflating the two is how monitoring earns a reputation for false alarms.
 *   - The placement's `status` is NOT changed. A verification is an observation;
 *     marking a link removed is a decision that a human makes after reading it.
 */
placementsRouter.post(
  "/:id([0-9a-fA-F-]{36})/check",
  authorize("placements:check"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { verifyBacklink, expectedRelFromPlacement } = await import("../../integrations/verification.js");

    const { data: placement, error } = await req.auth!.db
      .from("placements")
      .select("id, live_url, target_url, anchor_text, anchor_type, link_type, rel_attribute")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!placement) throw Errors.notFound("Placement");
    if (!placement.live_url) {
      throw Errors.badRequest("This placement has no live URL, so there is nothing to verify");
    }

    const expectedRel = expectedRelFromPlacement(
      placement.link_type as string | null,
      placement.rel_attribute as string | null,
    );

    const outcome = await verifyBacklink({
      liveUrl: placement.live_url as string,
      expectedUrl: placement.target_url as string,
      expectedAnchor: placement.anchor_text as string | null,
      expectedRel,
      expectedAnchorType: placement.anchor_type as string | null,
    });

    const { data: check, error: insertErr } = await req.auth!.db
      .from("link_checks")
      .insert({
        organization_id: orgOf(req),
        placement_id: placement.id,
        http_status: outcome.httpStatus,
        // `found` means "an anchor to the target exists", independent of whether
        // the anchor text or rel is right.
        found: outcome.found,
        rel_attribute: outcome.rel.actual.join(" ") || null,
        checked_by: "manual",
        verdict: outcome.verdict,
        expected_url: placement.target_url,
        found_url: outcome.foundUrl,
        anchor_expected: placement.anchor_text,
        anchor_found: outcome.anchorFoundText,
        anchor_matches: outcome.anchor.matches,
        rel_expected: expectedRel.join(" ") || "",
        rel_matches: outcome.rel.matches,
        url_matches: outcome.urlMatches,
        failure_reason: outcome.failureReason,
        http_final_url: outcome.finalUrl,
        elapsed_ms: outcome.elapsedMs,
        raw: outcome.detail,
      })
      .select()
      .single();

    if (insertErr) throw Errors.internal(insertErr.message);

    await req.auth!.db
      .from("placements")
      .update({ last_checked_at: new Date().toISOString() })
      .eq("id", placement.id);

    ok(res, {
      ...check,
      // What the caller should act on, spelled out rather than left to be inferred
      // from a `found` boolean that means something narrower than it looks.
      verdict: outcome.verdict,
      ok: outcome.verdict === "ok",
      failureReason: outcome.failureReason,
      anchor: { expected: outcome.anchor.expected, actual: outcome.anchorFoundText, matches: outcome.anchor.matches },
      rel: { expected: expectedRel, actual: outcome.rel.actual, matches: outcome.rel.matches },
      // Explicit, because the question "did this change my placement?" is the
      // first one a user asks. A verification never writes to the placement except
      // `last_checked_at`: deciding a link is removed is a human judgement, so
      // this is always false and says so out loud rather than leaving it to be
      // inferred from an absent field.
      statusChanged: false,
    });
  }),
);

placementsRouter.patch(
  "/:id([0-9a-fA-F-]{36})/index-status",
  authorize("placements:write"),
  validate({
    params: idParams,
    body: z.object({
      indexStatus: z.enum(["unknown", "indexed", "not_indexed"]),
      manual: z.boolean().default(true),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { indexStatus: string; manual: boolean };

    const { data, error } = await req.auth!.db
      .from("placements")
      .update({ index_status: b.indexStatus, index_status_manual: b.manual })
      .eq("id", req.params.id)
      .select(COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Placement");
    ok(res, data);
  }),
);
