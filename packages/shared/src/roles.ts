/**
 * The seven user types, taken verbatim from the agency's own role research
 * (Link Building Agnecy A-Z.md, "seven core user types"):
 *
 * 1. Super Admin / Agency Owner      -> owner
 * 2. Account Manager / Strategist    -> account_manager
 * 3. Prospector / Lead Researcher    -> prospector
 * 4. Outreach Specialist             -> outreach_specialist
 * 5. Content Manager / Writer        -> content_writer
 * 6. Client / Agency Partner         -> client_user
 * 7. Publisher / Vendor              -> publisher_user
 */
export const ROLES = [
  "owner",
  "account_manager",
  "prospector",
  "outreach_specialist",
  "content_writer",
  "client_user",
  "publisher_user",
] as const;

export type Role = (typeof ROLES)[number];

/** Roles that may reach the internal application surface. */
export const INTERNAL_ROLES: readonly Role[] = [
  "owner",
  "account_manager",
  "prospector",
  "outreach_specialist",
  "content_writer",
];

/**
 * Each external role gets exactly one dedicated API surface. Anything else is
 * rejected by surfaceGuard before authorization runs.
 */
export const SURFACES = {
  internal: "/api/v1",
  portal: "/portal/v1",
  supplier: "/supplier/v1",
} as const;

export type Surface = keyof typeof SURFACES;

export const ROLE_SURFACE: Record<Role, Surface> = {
  owner: "internal",
  account_manager: "internal",
  prospector: "internal",
  outreach_specialist: "internal",
  content_writer: "internal",
  client_user: "portal",
  publisher_user: "supplier",
};

export function surfaceForRole(role: Role): Surface {
  return ROLE_SURFACE[role];
}

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Super Admin / Agency Owner",
  account_manager: "Account Manager / Strategist",
  prospector: "Prospector / Lead Researcher",
  outreach_specialist: "Outreach Specialist",
  content_writer: "Content Manager / Writer",
  client_user: "Client / Agency Partner",
  publisher_user: "Publisher / Vendor",
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
