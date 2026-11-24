import { z } from "zod";
import { ROLES } from "./roles.js";
import {
  ANCHOR_TYPES,
  CAMPAIGN_STATUSES,
  CLIENT_STATUSES,
  INDEX_STATUSES,
  INVOICE_STATUSES,
  LINK_TYPES,
  PLACEMENT_STATUSES,
  PUBLISHER_STATUSES,
  SERVICE_TYPES,
  SUPPLIER_TYPES,
} from "./constants.js";

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().trim().toLowerCase().email();
export const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/, "Must be a bare domain, e.g. example.com")
  .transform((d) => d.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, ""));

/** numeric(12,2) as accepted on the wire: number or numeric string, non-negative. */
export const moneySchema = z
  .union([z.number(), z.string().regex(/^\d+(\.\d{1,2})?$/, "Up to 2 decimal places")])
  .transform((v) => (typeof v === "string" ? Number(v) : v))
  .refine((n) => Number.isFinite(n) && n >= 0, "Must be a non-negative amount")
  .refine((n) => n < 1e10, "Exceeds numeric(12,2) range");

export const optionalMoneySchema = moneySchema.nullish();

export const roleSchema = z.enum(ROLES);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  q: z.string().trim().max(200).optional(),
});

export const organizationSettingsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).default("UTC"),
  currency: z.string().trim().length(3).default("USD"),
  invoicePrefix: z.string().trim().max(12).default("INV"),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  logoUrl: z.string().url().optional(),
});

export const clientCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  domain: domainSchema,
  industry: z.string().trim().max(80).optional(),
  status: z.enum(CLIENT_STATUSES).default("prospect"),
  startDate: z.coerce.date().optional(),
  notes: z.string().max(5000).optional(),
});

export const clientBillingProfileSchema = z.object({
  legalName: z.string().trim().max(160).optional(),
  billingAddress: z
    .object({
      line1: z.string().trim().max(200).optional(),
      line2: z.string().trim().max(200).optional(),
      city: z.string().trim().max(80).optional(),
      region: z.string().trim().max(80).optional(),
      postcode: z.string().trim().max(20).optional(),
      country: z.string().trim().length(2).optional(),
    })
    .optional(),
  taxId: z.string().trim().max(40).optional(),
  taxRate: z.number().min(0).max(100).default(0),
  billingCurrency: z.string().trim().length(3).default("USD"),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
});

export const campaignCreateSchema = z.object({
  clientId: uuidSchema,
  name: z.string().trim().min(1).max(160),
  status: z.enum(CAMPAIGN_STATUSES).default("draft"),
  serviceType: z.enum(SERVICE_TYPES).default("guest_post"),
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
  monthlyLinkTarget: z.coerce.number().int().min(0).max(10000).default(0),
  targetDrMin: z.coerce.number().int().min(0).max(100).optional(),
  targetTrafficMin: z.coerce.number().int().min(0).optional(),
  anchorMix: z.record(z.enum(ANCHOR_TYPES), z.number().min(0).max(1)).optional(),
});

export const monthlyTargetSchema = z.object({
  periodMonth: z.coerce.date(),
  targetLinks: z.coerce.number().int().min(0).max(10000),
  targetCost: optionalMoneySchema,
});

export const supplierCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  supplierType: z.enum(SUPPLIER_TYPES),
  contactName: z.string().trim().max(120).optional(),
  contactEmail: emailSchema.optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  notes: z.string().max(5000).optional(),
});

export const publisherCreateSchema = z.object({
  domain: domainSchema,
  name: z.string().trim().max(160).optional(),
  supplierId: uuidSchema.nullish(),
  dr: z.coerce.number().int().min(0).max(100).optional(),
  da: z.coerce.number().int().min(0).max(100).optional(),
  monthlyTraffic: z.coerce.number().int().min(0).optional(),
  niche: z.array(z.string().trim().max(60)).max(12).optional(),
  country: z.string().trim().length(2).optional(),
  language: z.string().trim().max(5).optional(),
  linkType: z.enum(LINK_TYPES).optional(),
  acceptsGuestPost: z.boolean().optional(),
  status: z.enum(PUBLISHER_STATUSES).default("active"),
  contactEmail: emailSchema.optional(),
  contactFormUrl: z.string().url().optional(),
  notes: z.string().max(5000).optional(),
});

/** Price history: a new offer supersedes by valid_from, never overwrites. */
export const publisherOfferSchema = z.object({
  publisherId: uuidSchema,
  quotedPrice: moneySchema,
  currency: z.string().trim().length(3).default("USD"),
  linkType: z.enum(LINK_TYPES).default("dofollow"),
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date().optional(),
  source: z.string().trim().max(80).optional(),
});

export const prospectCreateSchema = z.object({
  campaignId: uuidSchema,
  publisherId: uuidSchema.nullish(),
  domain: domainSchema,
  contactName: z.string().trim().max(120).optional(),
  contactEmail: emailSchema.optional(),
  assignedTo: uuidSchema.nullish(),
  supplierId: uuidSchema.nullish(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  notes: z.string().max(5000).optional(),
});

export const stageChangeSchema = z.object({
  stage: z.string().trim().min(1).max(60),
  /** Required when moving to a lost/declined stage, so drops are never silent. */
  reason: z.string().trim().max(500).optional(),
});

export const touchpointCreateSchema = z.object({
  channel: z.enum(["email", "linkedin", "contact_form", "phone", "other"]),
  direction: z.enum(["outbound", "inbound"]),
  subject: z.string().trim().max(300).optional(),
  bodyExcerpt: z.string().max(5000).optional(),
  outcome: z.enum(["no_reply", "positive", "negative", "bounce", "auto_reply"]).optional(),
  occurredAt: z.coerce.date().default(() => new Date()),
});

export const placementCreateSchema = z.object({
  campaignId: uuidSchema,
  prospectId: uuidSchema.nullish(),
  publisherId: uuidSchema.nullish(),
  supplierId: uuidSchema.nullish(),
  targetUrl: z.string().url(),
  anchorText: z.string().trim().max(300).optional(),
  anchorType: z.enum(ANCHOR_TYPES).optional(),
  liveUrl: z.string().url().optional(),
  linkType: z.enum(LINK_TYPES).optional(),
  relAttribute: z.string().trim().max(120).optional(),
  status: z.enum(PLACEMENT_STATUSES).default("pending"),
  scheduledDate: z.coerce.date().optional(),
});

/** Tier 1 payload — client-side price. Separate route, separate permission. */
export const placementPricingSchema = z.object({
  clientRate: moneySchema,
  currency: z.string().trim().length(3).default("USD"),
});

/** Tier 2 payload — wholesale cost. Separate route, separate permission. */
export const placementCostSchema = z.object({
  supplierCost: moneySchema,
  currency: z.string().trim().length(3).default("USD"),
  supplierId: uuidSchema.nullish(),
});

export const invoiceCreateSchema = z.object({
  clientId: uuidSchema,
  /** Either a client or an agency partner may be billed; both may be supplied. */
  agencyPartnerId: uuidSchema.nullish(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  taxRate: z.number().min(0).max(100).default(0),
  discountAmount: moneySchema.default(0),
  currency: z.string().trim().toUpperCase().length(3).default("USD"),
  dueDate: z.coerce.date().optional(),
  notes: z.string().max(5000).optional(),
  paymentInstructions: z.string().max(2000).optional(),
  lineItems: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        quantity: z.coerce.number().positive().default(1),
        unitPrice: moneySchema,
        placementId: uuidSchema.nullish(),
      }),
    )
    .min(1),
});

/**
 * Editing an invoice. Draft only — enforced by the route as well, because a
 * validator cannot see the row's status.
 *
 * Line items are replaced wholesale rather than patched individually: an invoice
 * is a document, and reordering or renumbering items one at a time is how a
 * `sort_order` ends up with duplicates.
 */
export const invoiceUpdateSchema = z.object({
  agencyPartnerId: uuidSchema.nullish(),
  taxRate: z.number().min(0).max(100).optional(),
  discountAmount: moneySchema.optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
  dueDate: z.coerce.date().nullish(),
  notes: z.string().max(5000).nullish(),
  paymentInstructions: z.string().max(2000).nullish(),
  lineItems: z
    .array(
      z.object({
        description: z.string().trim().min(1).max(300),
        quantity: z.coerce.number().positive().default(1),
        unitPrice: moneySchema,
        placementId: uuidSchema.nullish(),
      }),
    )
    .min(1)
    .optional(),
});

export const invoiceShareLinkSchema = z.object({
  /** Days until the link expires. Omitted means it does not expire. */
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});

export const writerPayoutCreateSchema = z.object({
  placementId: uuidSchema.nullish(),
  campaignId: uuidSchema.nullish(),
  writerId: uuidSchema.nullish(),
  feeType: z.enum(["per_article", "per_word", "bonus", "other"]).default("per_article"),
  description: z.string().trim().max(500).optional(),
  amount: moneySchema,
  currency: z.string().trim().toUpperCase().length(3).default("USD"),
  status: z.enum(["pending", "approved", "paid"]).default("pending"),
  paidAt: z.coerce.date().optional(),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().max(2000).optional(),
});

export const writerPayoutUpdateSchema = writerPayoutCreateSchema.partial();

export const campaignExpenseCreateSchema = z.object({
  campaignId: uuidSchema,
  placementId: uuidSchema.nullish(),
  category: z.enum(["tools", "subcontractor", "advertising", "travel", "other"]).default("other"),
  description: z.string().trim().min(1).max(300),
  amount: moneySchema,
  currency: z.string().trim().toUpperCase().length(3).default("USD"),
  incurredOn: z.coerce.date().optional(),
  vendor: z.string().trim().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

export const campaignExpenseUpdateSchema = campaignExpenseCreateSchema.partial();

export const paymentCreateSchema = z.object({
  invoiceId: uuidSchema,
  amount: moneySchema.refine((n) => n > 0, "Payment must be positive"),
  method: z.enum(["bank_transfer", "card", "paypal", "wise", "other"]).default("bank_transfer"),
  reference: z.string().trim().max(120).optional(),
  receivedAt: z.coerce.date().default(() => new Date()),
});

export const exportRequestSchema = z.object({
  entity: z.enum(["clients", "publishers", "prospects", "placements", "invoices", "payments"]),
  format: z.enum(["csv", "xlsx"]).default("csv"),
  filters: z.record(z.unknown()).optional(),
});

/**
 * Bulk CSV import. Rows are validated individually so a single bad row does not
 * reject the file; the response reports created / skipped / errored per row.
 */
export const importRequestSchema = z.object({
  entity: z.enum(["clients", "publishers", "prospects", "placements"]),
  dryRun: z.boolean().default(true),
  rows: z.array(z.record(z.unknown())).min(1).max(5000),
});

export const indexStatusUpdateSchema = z.object({
  indexStatus: z.enum(INDEX_STATUSES),
  manual: z.boolean().default(true),
});
