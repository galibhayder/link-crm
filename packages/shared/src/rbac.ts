import { ROLES, type Role } from "./roles.js";

/**
 * Permission identifiers are `<resource>:<action>`. Every route, every UI guard
 * and every RLS test reads from this one matrix, so a hidden button and a
 * rejected request can never disagree.
 */
export const PERMISSIONS = [
  // staff & tenancy
  "staff:read",
  "staff:manage",
  "settings:manage",
  "audit:read",
  "pipeline:configure",
  // clients
  "clients:read",
  "clients:write",
  "clients:billing_profile",
  "portal_access:manage",
  // campaigns
  "campaigns:read",
  "campaigns:write",
  "assignments:manage",
  // suppliers / publishers
  "suppliers:read",
  "suppliers:write",
  "publishers:read",
  "publishers:write",
  "offers:read",
  "offers:write",
  // prospects & outreach
  "prospects:read",
  "prospects:write",
  "prospects:assign",
  "touchpoints:read",
  "touchpoints:write",
  "templates:read",
  "templates:write",
  // content stage
  "briefs:read",
  "briefs:write",
  /**
   * Approving a draft. Separate from `briefs:write` so a writer cannot sign off
   * their own work: the person who drafts and the person who approves must be
   * different authorities, which is the whole point of a review step.
   */
  "briefs:approve",
  // placements
  "placements:read",
  "placements:write",
  "placements:check",
  "placements:approve",
  // TIER 1 — client pricing (what we charge)
  "pricing:read",
  "pricing:write",
  // TIER 2 — wholesale cost (what we pay)
  "costs:read",
  "costs:write",
  // TIER 3 — derived margin
  "reports:margins",
  // billing
  "invoices:read",
  "invoices:write",
  /**
   * Publishing an invoice and minting/revoking its public link.
   *
   * Split from `invoices:write` deliberately: an account manager may be trusted
   * to share an invoice with a client, but not to change what it charges. Keeping
   * them apart means "permitted Account Manager" from the brief is expressible
   * without granting the whole write surface.
   */
  "invoices:share",
  "payments:read",
  "payments:write",
  /**
   * Writer fees and other campaign costs.
   *
   * Not folded into `costs:*` because that permission includes prospectors and
   * outreach specialists, who negotiate publisher prices but have no business
   * seeing what a writer is paid. Owner only.
   */
  "payouts:read",
  "payouts:write",
  "expenses:read",
  "expenses:write",
  // reporting & export
  "reports:read",
  "exports:request",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Every permission a given role holds. Absence from this set is a hard denial. */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: [...PERMISSIONS],

  /**
   * The bridge between client and fulfillment. Sets campaign targets, reviews
   * prospected sites, generates client reports.
   * Explicitly DENIED wholesale cost — the doc's own note on this role says
   * "Hide raw publisher wholesale costs if you want to separate sales from
   * fulfillment". We always separate them.
   */
  account_manager: [
    "staff:read",
    "clients:read",
    "clients:write",
    "clients:billing_profile",
    "portal_access:manage",
    "campaigns:read",
    "campaigns:write",
    "assignments:manage",
    "suppliers:read",
    "publishers:read",
    "publishers:write",
    "offers:read",
    "prospects:read",
    "prospects:assign",
    "touchpoints:read",
    "templates:read",
    "briefs:read",
    "briefs:approve",
    "placements:read",
    /**
     * Clearing a `needs_manual_review` verdict — opening a JS-rendered page and
     * confirming the link is there. It is the delivery owner's job, and the
     * `link_needs_review` notification is addressed to them, so withholding it here
     * would ping them about a queue they cannot open. Read-only on the placement:
     * moving one to `removed` still needs `placements:write`.
     */
    "placements:check",
    "placements:approve",
    "pricing:read",
    "pricing:write",
    "invoices:read",
    // May share an invoice with a client, but not alter its amounts — which is
    // exactly the split `invoices:write` describes.
    "invoices:share",
    "reports:read",
    "exports:request",
  ],

  /**
   * Imports domains, logs SEO metrics and contact emails, submits sites to the
   * account manager. Logs the publisher cost — so holds tier 2 read/write, but
   * never tier 1 (client price) and never margin.
   */
  prospector: [
    "clients:read",
    "campaigns:read",
    "suppliers:read",
    "suppliers:write",
    "publishers:read",
    "publishers:write",
    "offers:read",
    "offers:write",
    "prospects:read",
    "prospects:write",
    "touchpoints:read",
    "touchpoints:write",
    "placements:read",
    "placements:write",
    "costs:read",
    "costs:write",
  ],

  /**
   * Runs sequences, pitches editors, negotiates fees. Needs to see and set what
   * we pay (tier 2) to negotiate, and must never see what the client is charged.
   */
  outreach_specialist: [
    "clients:read",
    "campaigns:read",
    "suppliers:read",
    "publishers:read",
    "offers:read",
    "offers:write",
    "prospects:read",
    "prospects:write",
    "touchpoints:read",
    "touchpoints:write",
    "templates:read",
    "templates:write",
    "placements:read",
    "placements:write",
    "costs:read",
    "costs:write",
  ],

  /**
   * Drafts guest posts and insertions, submits for approval, tracks revisions.
   * The doc: "Restrict access to client billing and publisher negotiation
   * threads" — so no tier 1, no tier 2, no touchpoints, no pricing.
   */
  content_writer: [
    "clients:read",
    "campaigns:read",
    "placements:read",
    "placements:write",
    "briefs:read",
    "briefs:write",
  ],

  /**
   * The paying brand or white-label partner. Submits target URLs/anchors,
   * pre-approves pitched sites, reviews drafts, views live link reports.
   * "Never expose internal outreach notes, writer fees, or publisher wholesale
   * costs to this role."
   */
  client_user: [
    "clients:read",
    "campaigns:read",
    "placements:read",
    "placements:approve",
    "briefs:read",
    // The client reviews the draft written for them, so their sign-off is the
    // approval that matters most. It does not let them edit the text.
    "briefs:approve",
    "publishers:read",
    "pricing:read",
    "invoices:read",
    "reports:read",
  ],

  /**
   * Blog owners, editors, media contacts. Sees only their own properties, their
   * own agreed rate, and their own placements. Never the client rate.
   */
  publisher_user: [
    "publishers:read",
    "publishers:write",
    "offers:read",
    "offers:write",
    "prospects:read",
    "prospects:write",
    "touchpoints:read",
    "touchpoints:write",
    "placements:read",
    "placements:write",
    "costs:read",
    "payments:read",
  ],
};

const PERMISSION_SETS = ROLES.reduce(
  (acc, role) => {
    acc[role] = new Set(ROLE_PERMISSIONS[role]);
    return acc;
  },
  {} as Record<Role, ReadonlySet<Permission>>,
);

export function can(role: Role, permission: Permission): boolean {
  return PERMISSION_SETS[role]?.has(permission) ?? false;
}

export function canAny(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(role, p));
}

/** Permissions held by at least one role but by this one — used by the UI to hide nav. */
export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * The financial tiers, expressed once. These three lists are the security
 * contract: a role absent from tier 2 has NO policy on any tier-2 table, so no
 * query, export or future endpoint can reach wholesale cost through them.
 */
export const TIER_1_PRICING_ROLES: readonly Role[] = ["owner", "account_manager", "client_user"];
export const TIER_2_COST_ROLES: readonly Role[] = ["owner", "prospector", "outreach_specialist", "publisher_user"];
export const TIER_3_MARGIN_ROLES: readonly Role[] = ["owner"];
