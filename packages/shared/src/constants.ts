/**
 * Pipeline stages, from the agency's own definition:
 * "Tracks a single link from Prospected → Pitched → Approved by Client →
 *  Content Writing → Submitted → Live"
 *
 * Stored as a table (`pipeline_stages`) so an agency can rename or reorder
 * them; these are the seeded defaults.
 */
export const PIPELINE_STAGES = [
  { key: "prospected", label: "Prospected", sortOrder: 10, isWon: false, isLost: false },
  { key: "vetting", label: "Vetting", sortOrder: 20, isWon: false, isLost: false },
  { key: "pitched", label: "Pitched", sortOrder: 30, isWon: false, isLost: false },
  { key: "approved", label: "Approved by Client", sortOrder: 40, isWon: false, isLost: false },
  { key: "content_writing", label: "Content Writing", sortOrder: 50, isWon: false, isLost: false },
  { key: "submitted", label: "Submitted", sortOrder: 60, isWon: false, isLost: false },
  { key: "live", label: "Live", sortOrder: 70, isWon: true, isLost: false },
  { key: "declined", label: "Declined", sortOrder: 80, isWon: false, isLost: true },
  { key: "lost", label: "Lost", sortOrder: 90, isWon: false, isLost: true },
] as const;

export type PipelineStageKey = (typeof PIPELINE_STAGES)[number]["key"];

export const DEFAULT_PIPELINE_STAGES = PIPELINE_STAGES;

/** Operational placement status — distinct from pipeline stage. */
export const PLACEMENT_STATUSES = [
  "scheduled",
  "pending",
  "live",
  "removed",
  "declined",
  "refunded",
] as const;
export type PlacementStatus = (typeof PLACEMENT_STATUSES)[number];

/**
 * Anchor text taxonomy from the doc's "Anchor Text Ratio Tracking":
 * "categorizes and visualizes your placement anchor distribution across
 *  Branded, Exact Match, Partial Match, and Generic/Naked URL anchors to flag
 *  over-optimization risks."
 */
export const ANCHOR_TYPES = ["branded", "exact_match", "partial_match", "generic", "naked_url", "image_alt"] as const;
export type AnchorType = (typeof ANCHOR_TYPES)[number];

/**
 * Healthy anchor distribution for a new campaign. Exact-match above ~15% is the
 * classic over-optimization flag; the reporting surfaces deviations from this.
 */
export const ANCHOR_TARGET_RATIO: Record<AnchorType, { min: number; max: number }> = {
  branded: { min: 0.3, max: 0.5 },
  exact_match: { min: 0.05, max: 0.15 },
  partial_match: { min: 0.15, max: 0.3 },
  generic: { min: 0.1, max: 0.2 },
  naked_url: { min: 0.05, max: 0.15 },
  image_alt: { min: 0.0, max: 0.1 },
};

export const LINK_TYPES = ["dofollow", "nofollow", "ugc", "sponsored"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** Fulfillment models the agency sells. */
export const SERVICE_TYPES = ["guest_post", "niche_edit", "digital_pr", "link_insertion"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const PUBLISHER_STATUSES = ["active", "paused", "blacklisted"] as const;
export type PublisherStatus = (typeof PUBLISHER_STATUSES)[number];

export const SUPPLIER_TYPES = ["direct_publisher", "link_vendor"] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];

export const INDEX_STATUSES = ["unknown", "indexed", "not_indexed"] as const;
export type IndexStatus = (typeof INDEX_STATUSES)[number];

export const CLIENT_STATUSES = ["prospect", "active", "paused", "churned"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed", "cancelled"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const INVOICE_STATUSES = ["draft", "sent", "paid", "partially_paid", "overdue", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
