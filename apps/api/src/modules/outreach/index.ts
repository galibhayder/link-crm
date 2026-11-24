import { Router } from "express";
import { z } from "zod";
import { uuidSchema } from "@crm/shared";
import { authorize } from "../../middleware/authenticate.js";
import { asyncRoute, created, noContent, ok, parsedQuery, validate } from "../../lib/http.js";
import { Errors } from "../../lib/errors.js";
import { auditFromRequest, diffOf } from "../../lib/audit.js";
import { optionalBooleanQuery } from "../../lib/query.js";
import { orgOf, pageMeta, rangeFor, resolveOrder, resolveSort, searchClause, toColumnPatch } from "../../lib/crud.js";
import { emailDelivery } from "../../integrations/email.js";

/**
 * OUTREACH MANAGEMENT.
 *
 * Two related things live here:
 *
 *   1. `outreach_records` — the PLAN: what we intend to send, to whom, and when
 *      to follow up. A log of past events cannot express "chase this on Tuesday".
 *
 *   2. `outreach_touchpoints` — the HISTORY: what actually happened.
 *
 * SENDING IS GATED. There is no provider configured in this build, so the send
 * endpoint records intent, marks the record `queued`, and refuses to claim it
 * was delivered. Migration-independent by design: the check lives in
 * `integrations/email.ts`, which reports whether a provider is configured.
 */
export const outreachRouter: Router = Router();

const idParams = z.object({ id: uuidSchema });

const RECORD_COLUMNS =
  "id, prospect_id, campaign_id, template_id, kind, status, response_status, subject, body_excerpt, recipient_email, sent_at, responded_at, follow_up_due_at, follow_up_count, owner_id, delivery_provider, provider_message_id, created_at, updated_at";

const MAP: Record<string, string> = {
  prospectId: "prospect_id",
  campaignId: "campaign_id",
  templateId: "template_id",
  kind: "kind",
  status: "status",
  responseStatus: "response_status",
  subject: "subject",
  bodyExcerpt: "body_excerpt",
  recipientEmail: "recipient_email",
  followUpDueAt: "follow_up_due_at",
  ownerId: "owner_id",
};

const SORTABLE = ["created_at", "updated_at", "sent_at", "follow_up_due_at", "status"] as const;

// ---------------------------------------------------------------------------
// EMAIL TEMPLATES
//
// Declared before /:id so "templates" is not read as an id. Every parameterised
// route below is UUID-constrained for the same reason.
// ---------------------------------------------------------------------------
outreachRouter.get(
  "/templates",
  authorize("templates:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("email_templates")
      .select("id, name, subject, body_md, category, variables, created_at, updated_at")
      .order("name");

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

const templateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  subject: z.string().trim().min(1).max(300),
  bodyMd: z.string().trim().min(1).max(20_000),
  category: z.enum(["initial", "follow_up", "negotiation", "placement_notice", "invoice"]).default("initial"),
  variables: z.array(z.string().trim().max(60)).max(50).default([]),
});

outreachRouter.post(
  "/templates",
  authorize("templates:write"),
  validate({ body: templateSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof templateSchema>;

    const { data, error } = await req.auth!.db
      .from("email_templates")
      .insert({
        organization_id: orgOf(req),
        name: b.name,
        subject: b.subject,
        body_md: b.bodyMd,
        category: b.category,
        variables: b.variables,
      })
      .select()
      .single();

    if (error) throw Errors.internal(error.message);

    await auditFromRequest(req, {
      entityType: "email_template",
      entityId: data.id,
      action: "create",
      diff: { name: data.name, category: data.category },
    });

    created(res, data);
  }),
);

outreachRouter.patch(
  "/templates/:id([0-9a-fA-F-]{36})",
  authorize("templates:write"),
  validate({ params: idParams, body: templateSchema.partial() }),
  asyncRoute(async (req, res) => {
    const b = req.body as Partial<z.infer<typeof templateSchema>>;
    const patch = toColumnPatch(
      { ...b, bodyMd: b.bodyMd } as Record<string, unknown>,
      { name: "name", subject: "subject", bodyMd: "body_md", category: "category", variables: "variables" },
    );
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data, error } = await req.auth!.db
      .from("email_templates")
      .update(patch)
      .eq("id", req.params.id)
      .select()
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Template");
    ok(res, data);
  }),
);

outreachRouter.delete(
  "/templates/:id([0-9a-fA-F-]{36})",
  authorize("templates:write"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { error } = await req.auth!.db.from("email_templates").delete().eq("id", req.params.id);
    if (error) throw Errors.internal(error.message);
    noContent(res);
  }),
);

/**
 * Renders a template for a prospect.
 *
 * Substitution only — deliberately NOT a template engine. Running user-authored
 * templates through something that can evaluate expressions is how a CRM becomes
 * a remote code execution vector.
 */
outreachRouter.post(
  "/templates/:id([0-9a-fA-F-]{36})/render",
  authorize("templates:read"),
  validate({ params: idParams, body: z.object({ prospectId: uuidSchema }) }),
  asyncRoute(async (req, res) => {
    const { admin } = await import("../../integrations/supabase.js");

    const { data: template } = await req.auth!.db
      .from("email_templates")
      .select("id, name, subject, body_md, variables")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!template) throw Errors.notFound("Template");

    const { data: prospect } = await req.auth!.db
      .from("prospects")
      .select("id, domain, contact_name, contact_email, dr, monthly_traffic, price")
      .eq("id", (req.body as { prospectId: string }).prospectId)
      .maybeSingle();
    if (!prospect) throw Errors.notFound("Prospect");

    const { data: org } = await admin()
      .from("organizations")
      .select("name")
      .eq("id", orgOf(req))
      .single();

    const values: Record<string, string> = {
      domain: prospect.domain ?? "",
      contact_name: prospect.contact_name ?? "there",
      contact_email: prospect.contact_email ?? "",
      dr: prospect.dr != null ? String(prospect.dr) : "",
      monthly_traffic: prospect.monthly_traffic != null ? String(prospect.monthly_traffic) : "",
      price: prospect.price != null ? String(prospect.price) : "",
      agency_name: org?.name ?? "",
    };

    const substitute = (input: string) =>
      input.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_m, key: string) => values[key.toLowerCase()] ?? "");

    ok(res, {
      subject: substitute(template.subject),
      body: substitute(template.body_md),
      missingVariables: ((template.variables ?? []) as string[]).filter((v) => !values[v.toLowerCase()]),
    });
  }),
);

// ---------------------------------------------------------------------------
// OUTREACH RECORDS
// ---------------------------------------------------------------------------
outreachRouter.get(
  "/",
  authorize("touchpoints:read"),
  validate({
    query: z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      q: z.string().trim().max(200).optional(),
      sort: z.string().max(40).optional(),
      order: z.enum(["asc", "desc"]).default("desc"),
      prospectId: uuidSchema.optional(),
      campaignId: uuidSchema.optional(),
      status: z.string().optional(),
      ownerId: uuidSchema.optional(),
      dueOnly: optionalBooleanQuery,
    }),
  }),
  asyncRoute(async (req, res) => {
    const query = parsedQuery<{
      page: number; limit: number; q?: string; sort?: string; order: "asc" | "desc";
      prospectId?: string; campaignId?: string; status?: string; ownerId?: string; dueOnly?: boolean;
    }>(req);

    const sort = resolveSort(query.sort, SORTABLE, "created_at");
    const order = resolveOrder(query.order, sort, ["created_at", "updated_at", "sent_at", "follow_up_due_at"]);
    const { from, to } = rangeFor(query.page, query.limit);

    let dbQuery = req.auth!.db
      .from("outreach_records")
      .select(`${RECORD_COLUMNS}, prospect:prospects(id, domain, contact_name, contact_email)`, { count: "exact" })
      .order(sort, { ascending: order === "asc", nullsFirst: false })
      .range(from, to);

    const search = searchClause(query.q, ["subject", "recipient_email"]);
    if (search) dbQuery = dbQuery.or(search);

    if (query.prospectId) dbQuery = dbQuery.eq("prospect_id", query.prospectId);
    if (query.campaignId) dbQuery = dbQuery.eq("campaign_id", query.campaignId);
    if (query.status) dbQuery = dbQuery.eq("status", query.status);
    if (query.ownerId) dbQuery = dbQuery.eq("owner_id", query.ownerId);
    if (query.dueOnly) {
      dbQuery = dbQuery.lte("follow_up_due_at", new Date().toISOString()).in("status", ["sent", "no_response"]);
    }

    const { data, error, count } = await dbQuery;
    if (error) throw Errors.internal(error.message);
    ok(res, data ?? [], pageMeta(query.page, query.limit, count ?? 0, sort, order));
  }),
);

/** The follow-up queue: what is due, oldest first. */
outreachRouter.get(
  "/follow-ups",
  authorize("touchpoints:read"),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("outreach_records")
      .select(`${RECORD_COLUMNS}, prospect:prospects(id, domain, contact_name, contact_email)`)
      .lte("follow_up_due_at", new Date().toISOString())
      .in("status", ["sent", "no_response"])
      .order("follow_up_due_at", { ascending: true })
      .limit(200);

    if (error) throw Errors.internal(error.message);
    ok(res, data ?? []);
  }),
);

outreachRouter.get(
  "/:id([0-9a-fA-F-]{36})",
  authorize("touchpoints:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const { data, error } = await req.auth!.db
      .from("outreach_records")
      .select(
        `${RECORD_COLUMNS}, prospect:prospects(id, domain, contact_name, contact_email), template:email_templates(id, name, subject)`,
      )
      .eq("id", req.params.id)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Outreach record");
    ok(res, data);
  }),
);

const recordSchema = z.object({
  prospectId: uuidSchema,
  campaignId: uuidSchema,
  templateId: uuidSchema.nullish(),
  kind: z.enum(["initial", "follow_up", "negotiation", "placement_notice"]).default("initial"),
  subject: z.string().trim().max(300).nullish().transform((v) => v || null),
  bodyExcerpt: z.string().trim().max(10_000).nullish().transform((v) => v || null),
  recipientEmail: z.string().trim().email().nullish().transform((v) => (v ? v.toLowerCase() : null)),
  ownerId: uuidSchema.nullish(),
  followUpDueAt: z.string().trim().nullish(),
});

outreachRouter.post(
  "/",
  authorize("touchpoints:write"),
  validate({ body: recordSchema }),
  asyncRoute(async (req, res) => {
    const b = req.body as z.infer<typeof recordSchema>;

    const { data, error } = await req.auth!.db
      .from("outreach_records")
      .insert({
        organization_id: orgOf(req),
        ...toColumnPatch(b as Record<string, unknown>, MAP),
        owner_id: b.ownerId ?? req.auth!.userId,
        follow_up_due_at: b.followUpDueAt ? new Date(b.followUpDueAt).toISOString() : null,
        status: "draft",
      })
      .select(RECORD_COLUMNS)
      .single();

    if (error) {
      if (error.code === "23503") throw Errors.badRequest("Prospect or campaign not found");
      throw Errors.internal(error.message);
    }

    await auditFromRequest(req, {
      entityType: "outreach_record",
      entityId: data.id,
      action: "create",
      diff: { prospectId: data.prospect_id, kind: data.kind },
    });

    created(res, data);
  }),
);

outreachRouter.patch(
  "/:id([0-9a-fA-F-]{36})",
  authorize("touchpoints:write"),
  validate({
    params: idParams,
    body: recordSchema.partial().extend({
      status: z.enum(["draft", "queued", "sent", "replied", "no_response", "bounced", "cancelled"]).optional(),
      responseStatus: z.enum(["positive", "negative", "neutral", "out_of_office", "not_interested"]).nullish(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as Record<string, unknown>;

    // A record cannot be marked `sent` through a generic PATCH: that would claim
    // an email left the building when nothing did. Sending has its own endpoint.
    if (b.status === "sent") {
      throw Errors.badRequest("Marking a record as sent requires the send endpoint");
    }

    const patch = toColumnPatch(b, MAP);
    if (b.followUpDueAt !== undefined) {
      patch.follow_up_due_at = b.followUpDueAt ? new Date(String(b.followUpDueAt)).toISOString() : null;
    }
    if (Object.keys(patch).length === 0) throw Errors.badRequest("No fields to update");

    const { data: before } = await req.auth!.db
      .from("outreach_records")
      .select(RECORD_COLUMNS)
      .eq("id", req.params.id)
      .maybeSingle();
    if (!before) throw Errors.notFound("Outreach record");

    // A response should advance the prospect's stage and record the outcome.
    const responseStatus = b.responseStatus as string | null | undefined;
    if (responseStatus !== undefined) {
      patch.responded_at = responseStatus ? new Date().toISOString() : null;
      if (responseStatus) {
        patch.status = "replied";

        // Advance the prospect to reflect the reply, so the pipeline stays honest.
        //
        // The stage is CHECKED against the org's configured pipeline first. The
        // validity trigger would silently reject an unknown stage and return no
        // rows, so writing blind would claim success while nothing changed —
        // which is exactly the bug this handler previously had with
        // 'negotiating' (absent from the default seed).
        const wanted = responseStatus === "negative" || responseStatus === "not_interested"
          ? "declined"
          : "negotiating";

        const { data: stageRow } = await req.auth!.db
          .from("pipeline_stages")
          .select("key")
          .eq("applies_to", "prospect")
          .eq("key", wanted)
          .maybeSingle();

        const stageToApply = stageRow ? wanted : null;

        const { data: moved, error: moveErr } = await req.auth!.db
          .from("prospects")
          .update({
            reply_received: true,
            last_contacted_at: new Date().toISOString(),
            ...(stageToApply ? { stage: stageToApply } : {}),
          })
          .eq("id", before.prospect_id)
          .select("id, stage");

        if (moveErr) {
          throw Errors.internal(`Could not update the prospect after a reply: ${moveErr.message}`);
        }
        if (!moved || moved.length === 0) {
          // Zero rows means RLS or the validity trigger refused it. Surfacing
          // this is better than reporting a reply that was never recorded.
          throw Errors.forbidden("You cannot update that prospect, so the reply was not recorded");
        }
      }
    }

    const { data, error } = await req.auth!.db
      .from("outreach_records")
      .update(patch)
      .eq("id", req.params.id)
      .select(RECORD_COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);
    if (!data) throw Errors.notFound("Outreach record");

    await auditFromRequest(req, {
      entityType: "outreach_record",
      entityId: data.id,
      action: "update",
      diff: diffOf(before, patch),
    });

    ok(res, data);
  }),
);

/**
 * SEND — gated on a configured provider.
 *
 * With no provider configured this returns 503 and records nothing as sent. The
 * alternative — marking it `sent` and hoping — would make every downstream
 * number (reply rate, follow-up due dates, outreach history) a fiction.
 */
outreachRouter.post(
  "/:id([0-9a-fA-F-]{36})/send",
  authorize("touchpoints:write"),
  validate({ params: idParams, body: z.object({ confirm: z.literal(true) }).optional() }),
  asyncRoute(async (req, res) => {
    const delivery = emailDelivery();

    const { data: record } = await req.auth!.db
      .from("outreach_records")
      .select("id, status, subject, body_excerpt, recipient_email")
      .eq("id", req.params.id)
      .maybeSingle();

    if (!record) throw Errors.notFound("Outreach record");

    if (!record.recipient_email) {
      throw Errors.badRequest("This record has no recipient email address");
    }

    if (!delivery.configured) {
      // Explicit, actionable refusal. Not a silent no-op.
      throw Errors.unavailable(
        "email_not_configured",
        "No email provider is configured, so nothing was sent. Set EMAIL_PROVIDER and its credentials to enable sending.",
        { provider: delivery.provider, configured: false },
      );
    }

    // With a provider, the send would happen here. It is unreachable in this
    // build because `configured` is false unless real credentials are present.
    throw Errors.notImplemented(
      `A provider (${delivery.provider}) is configured but the send path is not implemented in this build.`,
    );
  }),
);

/**
 * Log an outreach that happened OUTSIDE the system — a sent email, a phone call,
 * a LinkedIn message. This is the honest path when no provider exists.
 */
outreachRouter.post(
  "/:id([0-9a-fA-F-]{36})/log",
  authorize("touchpoints:write"),
  validate({
    params: idParams,
    body: z.object({
      occurredAt: z.string().trim().optional(),
      outcome: z.enum(["no_reply", "positive", "negative", "bounce", "auto_reply"]).optional(),
      channel: z.enum(["email", "linkedin", "contact_form", "phone", "other"]).default("email"),
      note: z.string().trim().max(2000).optional(),
      nextFollowUpAt: z.string().trim().nullish(),
    }),
  }),
  asyncRoute(async (req, res) => {
    const b = req.body as {
      occurredAt?: string;
      outcome?: string;
      channel: string;
      note?: string;
      nextFollowUpAt?: string | null;
    };

    const { data: record } = await req.auth!.db
      .from("outreach_records")
      .select("id, prospect_id, subject, body_excerpt, follow_up_count")
      .eq("id", req.params.id)
      .maybeSingle();
    if (!record) throw Errors.notFound("Outreach record");

    const occurredAt = b.occurredAt ? new Date(b.occurredAt) : new Date();

    // The touchpoint is the immutable history.
    const { error: touchErr } = await req.auth!.db.from("outreach_touchpoints").insert({
      organization_id: orgOf(req),
      prospect_id: record.prospect_id,
      user_id: req.auth!.userId,
      channel: b.channel,
      direction: "outbound",
      subject: record.subject,
      body_excerpt: b.note ?? record.body_excerpt,
      outcome: b.outcome ?? "no_reply",
      occurred_at: occurredAt.toISOString(),
    });
    if (touchErr) throw Errors.internal(touchErr.message);

    // The record is the plan; logging advances it.
    const { data, error } = await req.auth!.db
      .from("outreach_records")
      .update({
        status: b.outcome === "positive" ? "replied" : "sent",
        sent_at: occurredAt.toISOString(),
        follow_up_due_at: b.nextFollowUpAt ? new Date(b.nextFollowUpAt).toISOString() : null,
        follow_up_count: (record.follow_up_count ?? 0) + 1,
      })
      .eq("id", req.params.id)
      .select(RECORD_COLUMNS)
      .maybeSingle();

    if (error) throw Errors.internal(error.message);

    await req.auth!.db
      .from("prospects")
      .update({ last_contacted_at: occurredAt.toISOString() })
      .eq("id", record.prospect_id);

    await auditFromRequest(req, {
      entityType: "outreach_record",
      entityId: req.params.id!,
      action: "update",
      diff: { logged: true, outcome: b.outcome ?? "no_reply", channel: b.channel },
    });

    ok(res, data);
  }),
);

// ---------------------------------------------------------------------------
// PROSPECT-CENTRED VIEW: contact info and full outreach history
// ---------------------------------------------------------------------------
outreachRouter.get(
  "/prospect/:id([0-9a-fA-F-]{36})",
  authorize("touchpoints:read"),
  validate({ params: idParams }),
  asyncRoute(async (req, res) => {
    const db = req.auth!.db;

    const [prospect, records, touchpoints] = await Promise.all([
      db
        .from("prospects")
        .select("id, domain, contact_name, contact_email, stage, reply_received, last_contacted_at, next_follow_up_at")
        .eq("id", req.params.id)
        .maybeSingle(),
      db
        .from("outreach_records")
        .select(RECORD_COLUMNS)
        .eq("prospect_id", req.params.id)
        .order("created_at", { ascending: false })
        .limit(100),
      db
        .from("outreach_touchpoints")
        .select("id, channel, direction, subject, outcome, occurred_at, user_id")
        .eq("prospect_id", req.params.id)
        .order("occurred_at", { ascending: false })
        .limit(100),
    ]);

    if (!prospect.data) throw Errors.notFound("Prospect");

    ok(res, {
      prospect: prospect.data,
      records: records.data ?? [],
      touchpoints: touchpoints.data ?? [],
      counts: {
        records: records.data?.length ?? 0,
        touchpoints: touchpoints.data?.length ?? 0,
      },
    });
  }),
);
