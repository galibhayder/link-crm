import { z } from "zod";
import {
  ANCHOR_TYPES,
  CAMPAIGN_STATUSES,
  CLIENT_STATUSES,
  LINK_TYPES,
  PUBLISHER_STATUSES,
  SERVICE_TYPES,
} from "./constants.js";
// Reuse the canonical identity schemas rather than redefining them: two subtly
// different `domainSchema`s in one package is exactly how a validation rule
// drifts between the form and the API.
import { domainSchema, uuidSchema } from "./schemas.js";

export { domainSchema, uuidSchema };

/**
 * Phase 3 CRM schemas.
 *
 * Every list endpoint shares one query shape (pagination + search + filters +
 * sort) so the front end can drive all five modules with the same table
 * component. `sort` is constrained to a per-module allowlist at the route level,
 * never passed through to SQL unchecked.
 */

export const sortOrderSchema = z.enum(["asc", "desc"]).default("desc");

export const baseListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.string().trim().max(60).optional(),
  order: sortOrderSchema,
});

export const optionalMoney = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "string" ? Number(v.replace(/[^0-9.\-]/g, "")) : v;
    return Number.isFinite(n) ? n : null;
  })
  .refine((n) => n === null || n >= 0, "Must be a positive amount");

export const optionalInt = (min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .nullish()
    .transform((v) => {
      if (v === null || v === undefined || v === "") return null;
      const n = typeof v === "string" ? Number(v.replace(/[^0-9.\-]/g, "")) : v;
      return Number.isFinite(n) ? Math.round(n) : null;
    })
    .refine((n) => n === null || (n >= min && n <= max), `Must be between ${min} and ${max}`);

/** Accepts a domain or URL and normalises to a full https URL. */
export const websiteUrlSchema = z
  .string()
  .trim()
  .nullish()
  .transform((raw) => {
    if (!raw) return null;
    let v = raw.trim();
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    return v;
  })
  .refine((v) => v === null || /^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(v), {
    message: "Must be a valid URL",
  });

export const optionalEmail = z
  .string()
  .trim()
  .nullish()
  .transform((v) => (v ? v.toLowerCase() : null))
  .refine((v) => v === null || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), { message: "Must be a valid email" });

export const optionalDate = z
  .string()
  .trim()
  .nullish()
  .transform((v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  });

export const nicheSchema = z
  .union([z.array(z.string().trim().max(60)), z.string()])
  .nullish()
  .transform((v) => {
    if (!v) return [] as string[];
    const list = Array.isArray(v) ? v : v.split(/[,;|]/);
    return [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, 20);
  });

const notesSchema = z.string().trim().max(10_000).nullish().transform((v) => v || null);

// ---------------------------------------------------------------------------
// CLIENTS
// ---------------------------------------------------------------------------
export const clientInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  domain: domainSchema,
  websiteUrl: websiteUrlSchema,
  industry: z.string().trim().max(80).nullish().transform((v) => v || null),
  status: z.enum(CLIENT_STATUSES).default("prospect"),
  managerId: uuidSchema.nullish(),
  agencyPartnerId: uuidSchema.nullish(),
  startDate: optionalDate,
  notes: notesSchema,
});

export const clientListQuery = baseListQuery.extend({
  status: z.string().optional(),
  managerId: uuidSchema.optional(),
  agencyPartnerId: uuidSchema.optional(),
  industry: z.string().optional(),
});

/**
 * Columns a client list may be sorted by. An allowlist, because `sort` arrives
 * from the query string and would otherwise be interpolated into SQL.
 */
export const CLIENT_SORTABLE = [
  "name",
  "domain",
  "status",
  "industry",
  "start_date",
  "created_at",
  "updated_at",
] as const;

// ---------------------------------------------------------------------------
// AGENCY PARTNERS
// ---------------------------------------------------------------------------
export const AGENCY_PARTNER_STATUSES = ["prospect", "active", "paused", "churned"] as const;
export const PARTNER_TYPES = ["white_label", "reseller", "referral"] as const;
export const PRICING_MODELS = ["markup", "discount", "fixed"] as const;

export const agencyPartnerInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(160),
    domain: domainSchema,
    partnerType: z.enum(PARTNER_TYPES).default("white_label"),
    status: z.enum(AGENCY_PARTNER_STATUSES).default("active"),
    contactName: z.string().trim().max(120).nullish().transform((v) => v || null),
    contactEmail: optionalEmail,
    contactPhone: z.string().trim().max(40).nullish().transform((v) => v || null),
    pricingModel: z.enum(PRICING_MODELS).default("markup"),
    markupPct: optionalInt(0, 1000),
    discountPct: optionalInt(0, 100),
    fixedRate: optionalMoney,
    currency: z.string().trim().length(3).default("USD"),
    billingEmail: optionalEmail,
    paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
    whiteLabelReports: z.coerce.boolean().default(true),
    accountManagerId: uuidSchema.nullish(),
    startDate: optionalDate,
    notes: notesSchema,
  })
  // Exactly one pricing figure matches the chosen model. Sending two is allowed
  // (a partner can be re-priced) but the model decides which is in force, so the
  // corresponding one must be present.
  .refine(
    (v) =>
      (v.pricingModel === "markup" && v.markupPct !== null) ||
      (v.pricingModel === "discount" && v.discountPct !== null) ||
      (v.pricingModel === "fixed" && v.fixedRate !== null),
    { message: "Provide the rate that matches the pricing model", path: ["pricingModel"] },
  );

export const agencyPartnerListQuery = baseListQuery.extend({
  status: z.string().optional(),
  partnerType: z.string().optional(),
  pricingModel: z.string().optional(),
});

export const AGENCY_PARTNER_SORTABLE = [
  "name",
  "domain",
  "status",
  "partner_type",
  "created_at",
  "updated_at",
] as const;

// ---------------------------------------------------------------------------
// PUBLISHERS
// ---------------------------------------------------------------------------
export const publisherInputSchema = z.object({
  domain: domainSchema,
  websiteUrl: websiteUrlSchema,
  name: z.string().trim().max(160).nullish().transform((v) => v || null),
  supplierId: uuidSchema.nullish(),
  dr: optionalInt(0, 100),
  da: optionalInt(0, 100),
  monthlyTraffic: optionalInt(0, 2_000_000_000),
  spamScore: optionalInt(0, 100),
  spamSource: z.string().trim().max(60).nullish().transform((v) => v || null),
  niche: nicheSchema,
  // An empty CSV cell means "not supplied", not "an invalid country". The
  // exporter writes "" for a NULL country, so a strict 2-char check here made
  // every exported row fail to re-import — a round-trip that could never work.
  country: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v && v.length > 0 ? v.toUpperCase() : null))
    .refine((v) => v === null || /^[A-Z]{2}$/.test(v), { message: "Must be a 2-letter country code" }),
  language: z.string().trim().max(10).nullish().transform((v) => v || null),
  // Same round-trip problem as `country`: the exporter emits "" for an unset
  // enum, and `z.enum` rejects "" as an invalid option.
  linkType: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null))
    .pipe(z.enum(LINK_TYPES).nullish()),
  price: optionalMoney,
  // An empty currency cell falls back to the default rather than failing: the
  // exporter always writes one, but a hand-made file may not.
  currency: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v && v.length === 3 ? v.toUpperCase() : "USD")),
  // `z.coerce.boolean()` turns "" into false, which is the right reading for a
  // blank CSV cell ("not stated" → treat as not accepted). Written explicitly
  // so the intent is visible rather than a coercion side effect.
  acceptsGuestPost: z
    .union([z.boolean(), z.string()])
    .nullish()
    .transform((v) => (v === null || v === undefined || v === "" ? null : v === true || /^(true|yes|1|y)$/i.test(String(v)))),
  acceptsLinkInsertion: z
    .union([z.boolean(), z.string()])
    .nullish()
    .transform((v) => (v === null || v === undefined || v === "" ? null : v === true || /^(true|yes|1|y)$/i.test(String(v)))),
  status: z
    .string()
    .trim()
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : "active"))
    .pipe(z.enum(PUBLISHER_STATUSES)),
  contactName: z.string().trim().max(120).nullish().transform((v) => v || null),
  contactEmail: optionalEmail,
  contactFormUrl: websiteUrlSchema,
  notes: notesSchema,
});

export const publisherListQuery = baseListQuery.extend({
  status: z.string().optional(),
  supplierId: uuidSchema.optional(),
  drMin: z.coerce.number().int().min(0).max(100).optional(),
  drMax: z.coerce.number().int().min(0).max(100).optional(),
  trafficMin: z.coerce.number().int().min(0).optional(),
  spamMax: z.coerce.number().min(0).max(100).optional(),
  priceMin: z.coerce.number().min(0).optional(),
  priceMax: z.coerce.number().min(0).optional(),
  niche: z.string().optional(),
  linkType: z.string().optional(),
  country: z.string().optional(),
});

export const PUBLISHER_SORTABLE = [
  "domain",
  "name",
  "dr",
  "da",
  "monthly_traffic",
  "spam_score",
  "price",
  "status",
  "created_at",
  "updated_at",
] as const;

// ---------------------------------------------------------------------------
// PROSPECTS
// ---------------------------------------------------------------------------
export const prospectInputSchema = z.object({
  campaignId: uuidSchema,
  publisherId: uuidSchema.nullish(),
  domain: domainSchema,
  websiteUrl: websiteUrlSchema,
  dr: optionalInt(0, 100),
  monthlyTraffic: optionalInt(0, 2_000_000_000),
  spamScore: optionalInt(0, 100),
  niche: nicheSchema,
  price: optionalMoney,
  currency: z.string().trim().length(3).default("USD"),
  contactName: z.string().trim().max(120).nullish().transform((v) => v || null),
  contactEmail: optionalEmail,
  assignedTo: uuidSchema.nullish(),
  supplierId: uuidSchema.nullish(),
  stage: z.string().trim().max(60).optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  nextFollowUpAt: optionalDate,
  notes: notesSchema,
});

export const prospectListQuery = baseListQuery.extend({
  campaignId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
  stage: z.string().optional(),
  assignedTo: uuidSchema.optional(),
  supplierId: uuidSchema.optional(),
  priority: z.string().optional(),
  drMin: z.coerce.number().int().min(0).max(100).optional(),
  trafficMin: z.coerce.number().int().min(0).optional(),
  followUpDue: z.coerce.boolean().optional(),
});

export const PROSPECT_SORTABLE = [
  "domain",
  "stage",
  "priority",
  "dr",
  "monthly_traffic",
  "price",
  "next_follow_up_at",
  "created_at",
  "updated_at",
] as const;

// ---------------------------------------------------------------------------
// CAMPAIGNS
// ---------------------------------------------------------------------------
export const campaignInputSchema = z.object({
  clientId: uuidSchema,
  name: z.string().trim().min(1, "Name is required").max(160),
  status: z.enum(CAMPAIGN_STATUSES).default("draft"),
  serviceType: z.enum(SERVICE_TYPES).default("guest_post"),
  startDate: optionalDate,
  endDate: optionalDate,
  monthlyLinkTarget: z.coerce.number().int().min(0).max(10_000).default(0),
  targetDrMin: optionalInt(0, 100),
  targetTrafficMin: optionalInt(0, 2_000_000_000),
  anchorMix: z.record(z.enum(ANCHOR_TYPES), z.number().min(0).max(1)).nullish(),
  notes: notesSchema,
});

export const campaignListQuery = baseListQuery.extend({
  clientId: uuidSchema.optional(),
  status: z.string().optional(),
  serviceType: z.string().optional(),
});

export const CAMPAIGN_SORTABLE = [
  "name",
  "status",
  "service_type",
  "start_date",
  "monthly_link_target",
  "created_at",
  "updated_at",
] as const;

// ---------------------------------------------------------------------------
// CSV IMPORT CONTRACT
// ---------------------------------------------------------------------------
export const IMPORT_ENTITIES = ["clients", "agency_partners", "publishers", "prospects", "campaigns"] as const;
export type ImportEntity = (typeof IMPORT_ENTITIES)[number];

/** How a duplicate row is treated. */
export const DUPLICATE_STRATEGIES = ["skip", "update", "error"] as const;
export type DuplicateStrategy = (typeof DUPLICATE_STRATEGIES)[number];

export const importPreviewSchema = z.object({
  entity: z.enum(IMPORT_ENTITIES),
  fileName: z.string().trim().max(255).optional(),
  duplicateStrategy: z.enum(DUPLICATE_STRATEGIES).default("skip"),
  /** Rows keyed by column name, as parsed from the file. */
  rows: z
    .array(z.record(z.string()))
    .min(1, "The file contains no data rows")
    .max(5000, "Imports are limited to 5,000 rows at a time"),
  /** Used by prospects/campaigns, which are scoped to a parent record. */
  defaults: z.record(z.string()).optional(),
});

export const importCommitSchema = z.object({
  jobId: uuidSchema,
  /** Row indices the user chose to apply. Omitted means "all non-error rows". */
  includeRowIndexes: z.array(z.coerce.number().int().min(0)).optional(),
});

export type ImportRowVerdict = {
  rowIndex: number;
  status: "ok" | "duplicate" | "update" | "error";
  message?: string;
  errors?: Record<string, string>;
  normalized?: Record<string, unknown>;
  existingId?: string;
  /** Human-readable summary of what would change, for an update. */
  changes?: Record<string, { from: unknown; to: unknown }>;
};

export type ImportSummary = {
  total: number;
  ok: number;
  duplicates: number;
  updates: number;
  errors: number;
};
