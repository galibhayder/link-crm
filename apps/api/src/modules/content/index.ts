import { Router } from "express";
import { z } from "zod";
import {
  can,
  canTransitionDraft,
  clientMaySeeDraft,
  countWords,
  DRAFT_TRANSITION_AUTHORITY,
  isOpenDraftStatus,
  uuidSchema,
} from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";
import { admin } from "../../integrations/supabase.js";
import { orgOf, pageMeta, rangeFor, resolveOrder, resolveSort, searchClause } from "../../lib/crud.js";
import { optionalBooleanQuery } from "../../lib/query.js";

/**
 * CONTENT MANAGEMENT.
 *
 * The unit of work is a BRIEF (the assignment) which owns one DRAFT (the
 * document), which owns many VERSIONS (every saved state). Revisions are requests
 * attached to the draft rather than edits to it, so the record of "what was asked
 * for" survives the correction.
 *
 * Why versions exist at all: the client approves version N. If editing mutated
 * that row, what they approved would no longer exist. A published draft must be
 * reproducible, so versions are append-only and restoring one creates a NEW
 * version rather than deleting history.
 */
export const contentRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

// A single string literal, not concatenated with `+`.
//
// supabase-js infers the row shape from this argument. With `"a, " + "b"` the
// expression widens to `string`, inference is lost, and every `.select()` returns
// `GenericStringError` — which then fails to typecheck at each property access.
// Keeping it one literal is what makes the types work.
const DRAFT_COLUMNS =
  "id, brief_id, placement_id, title, body_md, word_count, status, current_version, submitted_at, approved_at, approved_by, published_at, client_approval_note, created_by, created_at, updated_at";

// ===========================================================================
// BRIEFS — the assignment
// ===========================================================================

const briefListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(40).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  status: z.string().optional(),
  assignedTo: uuidSchema.optional(),
  placementId: uuidSchema.optional(),
  /** "mine" restricts to briefs assigned to the caller — the writer's queue. */
  mine: optionalBooleanQuery,
});

const BRIEF_SORTABLE = ["created_at", "updated_at", "due_date", "status"] as const;

contentRouter.get(
  "/briefs",
  authorize("briefs:read"),
  validate({ query: briefListQuery }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<z.infer<typeof briefListQuery>>(req);
    const sort = resolveSort(query.sort, BRIEF_SORTABLE, "created_at");
    const order = resolveOrder(query.order, sort, ["created_at", "updated_at", "due_date"]);
    const { from, to } = rangeFor(query.page, query.limit);

    let dbQuery = req.auth!.db
      .from("content_briefs")
      .select(
        "id, placement_id, assigned_to, brief, draft_url, status, revision_notes, due_date, created_at, updated_at",
        { count: "exact" },
      )
      .order(sort, { ascending: order === "asc", nullsFirst: false })
      .range(from, to);

    const search = searchClause(query.q, ["brief"]);
    if (search) dbQuery = dbQuery.or(search);

    if (query.status) dbQuery = dbQuery.eq("status", query.status);
    if (query.placementId) dbQuery = dbQuery.eq("placement_id", query.placementId);
    // `mine` and an explicit assignee are the same filter; the caller's own id is
    // not something they should have to know.
    if (query.mine) dbQuery = dbQuery.eq("assigned_to", req.auth!.userId);
    else if (query.assignedTo) dbQuery = dbQuery.eq("assigned_to", query.assignedTo);

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    // Attach each brief's draft.
    //
    // Without this the list said "no draft yet" for every row regardless of
    // reality, because the brief table has no draft column — the draft lives in
    // its own table. One extra query for the page beats N+1 per row.
    const briefIds = ((data ?? []) as Array<{ id: string }>).map((b) => b.id);
    const draftsByBrief = new Map<string, unknown>();

    if (briefIds.length > 0) {
      const { data: draftRows } = await req.auth!.db
        .from("content_drafts")
        .select(DRAFT_COLUMNS)
        .in("brief_id", briefIds);

      for (const d of (draftRows ?? []) as Array<{ brief_id: string }>) {
        draftsByBrief.set(d.brief_id, d);
      }
    }

    const withDrafts = ((data ?? []) as Array<{ id: string }>).map((b) => ({
      ...b,
      draft: draftsByBrief.get(b.id) ?? null,
    }));

    ok(res, withDrafts, pageMeta(query.page, query.limit, count ?? 0, sort, order));
  }),
);

/**
 * Create a brief, and the placement's content stage begins.
 *
 * A brief is created against a placement, so the work always has a home. The
 * placement is moved to `content_writing` here rather than requiring a second
 * call: creating the assignment IS the move, and two calls is a chance to do one.
 */
const briefCreateSchema = z.object({
  placementId: uuidSchema,
  assignedTo: uuidSchema.nullish(),
  brief: z.string().trim().max(20_000).nullish(),
  dueDate: z.string().trim().nullish(),
});

contentRouter.post(
  "/briefs",
  authorize("briefs:write"),
  validate({ body: briefCreateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof briefCreateSchema>;
    const orgId = orgOf(req);

    const { data: placement } = await req.auth!.db
      .from("placements")
      .select("id, campaign_id, pipeline_stage, deleted_at")
      .eq("id", b.placementId)
      .is("deleted_at", null)
      .maybeSingle();

    if (!placement) throw Errors.notFound("Placement");

    if (b.assignedTo) {
      // The writer must be a real member of this organization. RLS would reject it
      // via the trigger, but a clear message beats a constraint violation.
      const { data: writer } = await req.auth!.db
        .from("profiles")
        .select("id, role")
        .eq("id", b.assignedTo)
        .maybeSingle();
      if (!writer) throw Errors.badRequest("Assignee not found");
    }

    const { data, error } = await req.auth!.db
      .from("content_briefs")
      .insert({
        organization_id: orgId,
        placement_id: b.placementId,
        assigned_to: b.assignedTo ?? null,
        brief: b.brief ?? null,
        due_date: b.dueDate ? new Date(b.dueDate).toISOString().slice(0, 10) : null,
        status: "briefed",
      })
      .select()
      .single();

    if (error) {
      // One brief per placement is the intent; the unique index enforces it.
      if (error.code === "23505") throw Errors.conflict("This placement already has a content brief");
      throw Errors.internal(error.message);
    }

    // Creating the writing assignment IS the move into `content_writing`.
    //
    // The comment on this handler claimed that behaviour but the code never did it,
    // so a placement with a brief sat in whatever stage it was already in and the
    // board disagreed with the content screen. Done as a plain update rather than a
    // pipeline transition because this is a legitimate consequence of the work
    // starting, not a workflow decision a human is making — and only when the
    // placement is already at or past client approval. Moving an unapproved
    // placement forward would skip the client's sign-off.
    const stage = (placement as { pipeline_stage?: string }).pipeline_stage;
    if (stage === "client_approved") {
      await req.auth!.db
        .from("placements")
        .update({ pipeline_stage: "content_writing" })
        .eq("id", b.placementId)
        .eq("organization_id", orgId);
    }

    await auditFromRequest(req, {
      entityType: "content_brief",
      entityId: data.id,
      action: "create",
      diff: { placementId: b.placementId, assignedTo: b.assignedTo, dueDate: b.dueDate },
    });

    ok(res, data);
  }),
);

contentRouter.get(
  "/briefs/:id([0-9a-fA-F-]{36})",
  authorize("briefs:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("content_briefs")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Brief");

    // The draft travels with the brief: opening a brief and then fetching the
    // draft is two round-trips for one screen.
    const { data: draft } = await req.auth!.db
      .from("content_drafts")
      .select(DRAFT_COLUMNS)
      .eq("brief_id", req.params.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    ok(res, { ...data, draft: draft ?? null });
  }),
);

contentRouter.patch(
  "/briefs/:id([0-9a-fA-F-]{36})",
  authorize("briefs:write"),
  validate({
    params: idParams,
    body: z.object({
      assignedTo: uuidSchema.nullish(),
      brief: z.string().trim().max(20_000).nullish(),
      dueDate: z.string().trim().nullish(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { assignedTo?: string | null; brief?: string | null; dueDate?: string | null };
    const patch: Record<string, unknown> = {};

    if (b.assignedTo !== undefined) patch.assigned_to = b.assignedTo;
    if (b.brief !== undefined) patch.brief = b.brief;
    if (b.dueDate !== undefined) {
      patch.due_date = b.dueDate ? new Date(b.dueDate).toISOString().slice(0, 10) : null;
    }
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data: before } = await req.auth!.db
      .from("content_briefs")
      .select("*")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!before) throw Errors.notFound("Brief");

    const { data, error } = await req.auth!.db
      .from("content_briefs")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Brief");

    await auditFromRequest(req, {
      entityType: "content_brief",
      entityId: req.params.id!,
      action: "update",
      diff: diffOf(before, patch),
    });

    ok(res, data);
  }),
);

// ===========================================================================
// DRAFTS
// ===========================================================================

contentRouter.get(
  "/drafts",
  authorize("briefs:read"),
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      status: z.string().optional(),
      briefId: uuidSchema.optional(),
      /** "open" means: still needs somebody to act. */
      open: optionalBooleanQuery,
    }),
  }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<{ page: number; limit: number; status?: string; briefId?: string; open?: boolean }>(req);
    const { from, to } = rangeFor(query.page, query.limit);

    let dbQuery = req.auth!.db
      .from("content_drafts")
      .select(DRAFT_COLUMNS, { count: "exact" })
      .order("updated_at", { ascending: false })
      .range(from, to);

    if (query.status) dbQuery = dbQuery.eq("status", query.status);
    if (query.briefId) dbQuery = dbQuery.eq("brief_id", query.briefId);
    if (query.open) dbQuery = dbQuery.in("status", ["draft", "in_review", "revision_requested"]);

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);

    ok(res, data ?? [], pageMeta(query.page, query.limit, count ?? 0, "updated_at", "desc"));
  }),
);

/**
 * Create a draft for a brief.
 *
 * Version 1 is written in the same call, so a draft never exists with no content
 * to show. The two writes are sequential rather than transactional because the
 * version needs the draft's id — and a draft with zero versions is recoverable
 * (the next save creates v1), whereas a version with no draft is not.
 */
const draftCreateSchema = z.object({
  briefId: uuidSchema,
  title: z.string().trim().max(300).nullish(),
  bodyMd: z.string().max(200_000).default(""),
});

contentRouter.post(
  "/drafts",
  authorize("briefs:write"),
  validate({ body: draftCreateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof draftCreateSchema>;
    const orgId = orgOf(req);

    const { data: brief } = await req.auth!.db
      .from("content_briefs")
      .select("id, placement_id, status")
      .eq("id", b.briefId)
      .maybeSingle();
    if (!brief) throw Errors.notFound("Brief");

    // One live draft per brief. A second draft would make "the current draft"
    // ambiguous, and the version history exists precisely to avoid needing one.
    const { data: existing } = await req.auth!.db
      .from("content_drafts")
      .select("id")
      .eq("brief_id", b.briefId)
      .maybeSingle();
    if (existing) throw Errors.conflict("This brief already has a draft. Add a version instead.");

    const body = b.bodyMd ?? "";
    const { data, error } = await req.auth!.db
      .from("content_drafts")
      .insert({
        organization_id: orgId,
        brief_id: b.briefId,
        placement_id: brief.placement_id,
        title: b.title ?? null,
        body_md: body,
        word_count: countWords(body),
        status: "draft",
        created_by: req.auth!.userId,
        current_version: 1,
      })
      .select(DRAFT_COLUMNS)
      .single();

    if (error) throw Errors.internal(error.message);

    // Versions are written over service_role: the table has no INSERT policy for
    // any end-user role, because a version that a user could edit is not history.
    const { error: versionErr } = await admin().from("content_draft_versions").insert({
      organization_id: orgId,
      draft_id: data.id,
      version: 1,
      title: b.title ?? null,
      body_md: body,
      word_count: countWords(body),
      reason: "initial",
      created_by: req.auth!.userId,
    });
    if (versionErr) throw Errors.internal(versionErr.message);

    // The brief reflects that work has started.
    await req.auth!.db.from("content_briefs").update({ status: "drafting" }).eq("id", b.briefId);

    await auditFromRequest(req, {
      entityType: "content_draft",
      entityId: data.id,
      action: "create",
      diff: { briefId: b.briefId, wordCount: countWords(body) },
    });

    created(res, data);
  }),
);

contentRouter.get(
  "/drafts/:id([0-9a-fA-F-]{36})",
  authorize("briefs:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("content_drafts")
      .select(DRAFT_COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Draft");

    const [versions, revisions] = await Promise.all([
      req.auth!.db
        .from("content_draft_versions")
        .select("id, version, title, word_count, reason, created_by, created_at")
        .eq("draft_id", req.params.id)
        .order("version", { ascending: false }),
      req.auth!.db
        .from("content_revisions")
        .select("id, notes, status, requested_by, created_at, resolved_at, resolved_by_version")
        .eq("draft_id", req.params.id)
        .order("created_at", { ascending: false }),
    ]);

    ok(res, {
      ...data,
      // The body of the LATEST version is the draft's body; the list is metadata
      // so a long history does not send every revision of a 2000-word article.
      versions: versions.data ?? [],
      revisions: revisions.data ?? [],
    });
  }),
);

/** One version's full text, for diffing or restoring. */
contentRouter.get(
  "/drafts/:id([0-9a-fA-F-]{36})/versions/:version",
  authorize("briefs:read"),
  validate({ params: idParams.extend({ version: z.coerce.number().int().min(1) }) }),
  asyncRoute(async (req, res) => {
    const version = Number(req.params.version);

    const { data, error } = await req.auth!.db
      .from("content_draft_versions")
      .select("id, version, title, body_md, word_count, reason, created_by, created_at")
      .eq("draft_id", req.params.id)
      .eq("version", version)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Version");
    ok(res, data);
  }),
);

/**
 * Save a new version.
 *
 * Every save creates a version rather than mutating the draft's text. That is
 * slightly more storage and eliminates the whole class of "we can't show you what
 * you approved" problems. If an open revision request exists, saving resolves it:
 * the correction the reviewer asked for has been made.
 */
contentRouter.post(
  "/drafts/:id([0-9a-fA-F-]{36})/versions",
  authorize("briefs:write"),
  validate({
    params: idParams,
    body: z.object({
      title: z.string().trim().max(300).nullish(),
      bodyMd: z.string().max(200_000),
      reason: z.enum(["revision", "restore"]).default("revision"),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as { title?: string | null; bodyMd: string; reason: "revision" | "restore" };
    const orgId = orgOf(req);

    const { data: draft } = await req.auth!.db
      .from("content_drafts")
      .select("id, brief_id, status, current_version")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!draft) throw Errors.notFound("Draft");

    // Published content is frozen. Editing it silently would mean the client's
    // approved version and the published version differ.
    if (draft.status === "published") {
      throw Errors.badRequest("This draft is published. Unpublish it or create a new draft to revise it.");
    }

    const nextVersion = ((draft.current_version as number | null) ?? 0) + 1;
    const words = countWords(b.bodyMd);

    const { error: versionErr } = await admin().from("content_draft_versions").insert({
      organization_id: orgId,
      draft_id: req.params.id,
      version: nextVersion,
      title: b.title ?? null,
      body_md: b.bodyMd,
      word_count: words,
      reason: b.reason,
      created_by: req.auth!.userId,
    });
    if (versionErr) throw Errors.internal(versionErr.message);

    // A save after a revision request IS the fix, so the request closes and the
    // draft returns to review rather than straight to approved.
    const patch: Record<string, unknown> = {
      title: b.title ?? null,
      body_md: b.bodyMd,
      word_count: words,
      current_version: nextVersion,
    };
    if (draft.status === "revision_requested") {
      patch.status = "in_review";
      patch.submitted_at = new Date().toISOString();
    }

    const { data, error } = await req.auth!.db
      .from("content_drafts")
      .update(patch)
      .eq("id", req.params.id)
      .select(DRAFT_COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Draft");

    if (draft.status === "revision_requested") {
      await req.auth!.db
        .from("content_revisions")
        .update({
          status: "resolved",
          resolved_at: new Date().toISOString(),
          resolved_by_version: nextVersion,
        })
        .eq("draft_id", req.params.id)
        .eq("status", "open");
    }

    await auditFromRequest(req, {
      entityType: "content_draft",
      entityId: req.params.id!,
      action: "update",
      diff: { version: nextVersion, wordCount: words, reason: b.reason },
    });

    ok(res, data);
  }),
);

/**
 * Move a draft through the workflow.
 *
 * The authority check is the point: submitting needs `briefs:write`, approving
 * needs `briefs:approve`. Without the split a writer could approve their own
 * work, and the review step would be decoration.
 */
const transitionSchema = z.object({
  status: z.enum(["in_review", "approved", "revision_requested", "published"]),
  /** Required when requesting a revision: what needs to change. */
  notes: z.string().trim().max(4000).optional(),
});

contentRouter.post(
  "/drafts/:id([0-9a-fA-F-]{36})/transition",
  authorize("briefs:read"),
  validate({ params: idParams, body: transitionSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof transitionSchema>;

    const { data: draft } = await req.auth!.db
      .from("content_drafts")
      .select("id, brief_id, status, current_version")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!draft) throw Errors.notFound("Draft");

    const from = draft.status as string;

    if (!canTransitionDraft(from, b.status)) {
      throw Errors.badRequest(`Cannot move a draft from ${from} to ${b.status}`, { from, to: b.status });
    }

    const authority = DRAFT_TRANSITION_AUTHORITY[b.status];
    if (authority === "approve" && !can(req.auth!.role, "briefs:approve")) {
      throw Errors.forbidden(
        "Approving or publishing content requires the briefs:approve permission",
      );
    }
    if (authority === "write" && !can(req.auth!.role, "briefs:write")) {
      throw Errors.forbidden("Submitting content requires the briefs:write permission");
    }

    // A revision request with no notes is not actionable: the writer would be told
    // "change something" and have to guess.
    if (b.status === "revision_requested" && (!b.notes || b.notes.trim().length < 3)) {
      throw Errors.badRequest("Say what needs to change when requesting a revision");
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status: b.status };

    if (b.status === "in_review") patch.submitted_at = now;
    if (b.status === "approved") {
      patch.approved_at = now;
      patch.approved_by = req.auth!.userId;
    }
    if (b.status === "published") patch.published_at = now;

    const { data, error } = await req.auth!.db
      .from("content_drafts")
      .update(patch)
      .eq("id", req.params.id)
      .select(DRAFT_COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Draft");

    if (b.status === "revision_requested") {
      // A partial unique index allows only one open request per draft, so a
      // second one is not possible — and should not be.
      const { error: revErr } = await req.auth!.db.from("content_revisions").insert({
        organization_id: orgOf(req),
        draft_id: req.params.id,
        requested_by: req.auth!.userId,
        notes: b.notes!,
        status: "open",
      });
      if (revErr && revErr.code !== "23505") throw Errors.internal(revErr.message);

      await req.auth!.db.from("content_drafts").update({ status: "revision_requested" }).eq("id", req.params.id);
    }

    // The brief tracks the draft, so the two never disagree about where the work is.
    await req.auth!.db
      .from("content_briefs")
      .update({
        status:
          b.status === "published"
            ? "published"
            : b.status === "approved"
              ? "approved"
              : b.status === "revision_requested"
                ? "revision"
                : "submitted",
      })
      .eq("id", draft.brief_id);

    await auditFromRequest(req, {
      entityType: "content_draft",
      entityId: req.params.id!,
      action: "status_change",
      diff: { from, to: b.status, notes: b.notes },
    });

    ok(res, data);
  }),
);

/** Restore an earlier version by copying it forward. History is never rewritten. */
contentRouter.post(
  "/drafts/:id([0-9a-fA-F-]{36})/restore/:version",
  authorize("briefs:write"),
  validate({ params: idParams.extend({ version: z.coerce.number().int().min(1) }) }),
  asyncRoute(async (req, res) => {
    const version = Number(req.params.version);
    const orgId = orgOf(req);

    const { data: source } = await req.auth!.db
      .from("content_draft_versions")
      .select("title, body_md, word_count")
      .eq("draft_id", req.params.id)
      .eq("version", version)
      .maybeSingle();
    if (!source) throw Errors.notFound("Version");

    const { data: draft } = await req.auth!.db
      .from("content_drafts")
      .select("current_version, status")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!draft) throw Errors.notFound("Draft");

    // Restoring is only allowed for a draft the writer still owns.
    //
    // A draft in review or already approved is somebody else's decision in flight.
    // Silently replacing its text with an older version would change what the
    // reviewer is looking at — or what the client already approved — with no trace
    // beyond a new version number. The writer must withdraw it first, which is an
    // explicit act that shows in the history.
    if (draft.status === "published") {
      throw Errors.badRequest("This draft is published and cannot be changed");
    }
    if (draft.status === "in_review" || draft.status === "approved") {
      throw Errors.badRequest(
        `This draft is ${draft.status === "in_review" ? "in review" : "approved"} and cannot be overwritten by a restore. ` +
          "Request a revision first so the change is recorded against the review.",
      );
    }

    const nextVersion = ((draft.current_version as number | null) ?? 0) + 1;

    await admin().from("content_draft_versions").insert({
      organization_id: orgId,
      draft_id: req.params.id,
      version: nextVersion,
      title: source.title,
      body_md: source.body_md,
      word_count: source.word_count,
      reason: "restore",
      created_by: req.auth!.userId,
    });

    const { data, error } = await req.auth!.db
      .from("content_drafts")
      .update({
        title: source.title,
        body_md: source.body_md,
        word_count: source.word_count,
        current_version: nextVersion,
      })
      .eq("id", req.params.id)
      .select(DRAFT_COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "content_draft",
      entityId: req.params.id!,
      action: "update",
      diff: { restoredFrom: version, newVersion: nextVersion },
    });

    ok(res, data);
  }),
);

/** Revision requests for a draft, including resolved ones for the audit trail. */
contentRouter.get(
  "/drafts/:id([0-9a-fA-F-]{36})/revisions",
  authorize("briefs:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("content_revisions")
      .select("id, notes, status, requested_by, created_at, resolved_at, resolved_by_version")
      .eq("draft_id", req.params.id)
      .order("created_at", { ascending: false });

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

contentRouter.delete(
  "/revisions/:id([0-9a-fA-F-]{36})",
  authorize("briefs:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    // Withdrawing leaves the row: "this was asked for and then dropped" is part of
    // the history, and deleting it would make the writer's inbox inexplicable.
    const { data, error } = await req.auth!.db
      .from("content_revisions")
      .update({ status: "withdrawn", resolved_at: new Date().toISOString() })
      .eq("id", req.params.id)
      .eq("status", "open")
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Open revision request");
    noContent(res);
  }),
);

/**
 * The writer's queue: everything assigned to me that still needs work.
 *
 * Exists as its own endpoint because the writer's question is "what do I do next",
 * not "browse all briefs".
 */
contentRouter.get(
  "/my-queue",
  authorize("briefs:read"),
  asyncRoute(async (req, res) => {
    const { data: briefs, error } = await req.auth!.db
      .from("content_briefs")
      .select("id, placement_id, status, due_date, revision_notes, created_at")
      .eq("assigned_to", req.auth!.userId)
      .in("status", ["briefed", "drafting", "revision", "submitted"])
      .order("due_date", { ascending: true, nullsFirst: false });

    if (error) throw Errors.internal(error.message);

    const briefIds = (briefs ?? []).map((b: { id: string }) => b.id);
    const drafts =
      briefIds.length > 0
        ? await req.auth!.db
            .from("content_drafts")
            .select(DRAFT_COLUMNS)
            .in("brief_id", briefIds)
        : { data: [] };

    const draftByBrief = new Map(
      ((drafts.data ?? []) as Array<{ brief_id: string }>).map((d) => [d.brief_id, d]),
    );

    ok(res, (briefs ?? []).map((b: { id: string }) => ({ ...b, draft: draftByBrief.get(b.id) ?? null })));
  }),
);

/** Counts for the queue header, so the UI does not have to aggregate client-side. */
contentRouter.get(
  "/summary",
  authorize("briefs:read"),
  asyncRoute(async (req, res) => {
    const { data: drafts, error } = await req.auth!.db
      .from("content_drafts")
      .select("status");

    if (error) throw Errors.internal(error.message);

    const counts: Record<string, number> = {
      draft: 0,
      in_review: 0,
      revision_requested: 0,
      approved: 0,
      published: 0,
    };
    for (const row of (drafts ?? []) as Array<{ status: string }>) {
      if (row.status in counts) counts[row.status] = (counts[row.status] ?? 0) + 1;
    }

    ok(res, {
      byStatus: counts,
      open: (drafts ?? []).filter((d: { status: string }) => isOpenDraftStatus(d.status)).length,
      total: drafts?.length ?? 0,
      // Whether the caller can approve, so the UI can hide the button rather than
      // offer one that will 403.
      canApprove: can(req.auth!.role, "briefs:approve"),
    });
  }),
);
