/**
 * PLACEMENT PIPELINE — shared rules.
 *
 * Stage transitions are the heart of Phase 4, so the rules live in one place
 * rather than being re-derived by the route, the trigger and the UI.
 */

/** The six pipeline stages, in order. */
export const PLACEMENT_STAGES = [
  "prospected",
  "pitched",
  "client_approved",
  "content_writing",
  "submitted",
  "live",
] as const;

export type PlacementStage = (typeof PLACEMENT_STAGES)[number];

/**
 * Allowed forward/backward moves.
 *
 * Deliberately permissive backwards (a link can fail at any point and go back to
 * `pitched`) but guarded forwards, because skipping a step hides work that has
 * not happened — marking something `live` from `prospected` would claim a link
 * exists when nothing was pitched.
 */
export const ALLOWED_TRANSITIONS: Record<PlacementStage, PlacementStage[]> = {
  prospected: ["pitched", "prospected"],
  pitched: ["client_approved", "prospected", "pitched"],
  client_approved: ["content_writing", "pitched", "client_approved"],
  content_writing: ["submitted", "client_approved", "content_writing"],
  submitted: ["live", "content_writing", "submitted"],
  live: ["live"],
};

/** Stages a client portal may see. Earlier stages are internal pipeline work. */
export const CLIENT_VISIBLE_STAGES: PlacementStage[] = [
  "client_approved",
  "content_writing",
  "submitted",
  "live",
];

/**
 * Whether moving between two stages is permitted.
 *
 * A no-op move (same stage) is always allowed so a drag that lands on the same
 * column does not produce an error for the user.
 */
export function canTransition(from: string, to: string): boolean {
  if (from === to) return true;
  const allowed = ALLOWED_TRANSITIONS[from as PlacementStage];
  if (!allowed) return false;
  return allowed.includes(to as PlacementStage);
}

export function stageIndex(stage: string): number {
  return PLACEMENT_STAGES.indexOf(stage as PlacementStage);
}

/** Reaching these stages records a timestamp the portal and reports rely on. */
export function stageTimestamps(stage: string): Record<string, unknown> {
  const now = new Date().toISOString();
  switch (stage) {
    case "submitted":
      return { submitted_at: now };
    case "live":
      return { live_date: now.slice(0, 10) };
    default:
      return {};
  }
}

/**
 * Whether the operational `status` should follow the pipeline stage.
 *
 * They are different columns, but the two obvious cases must not disagree: a
 * placement at `live` in the pipeline should not be `pending` operationally.
 * Anything else is left alone, because operational status is set by link
 * monitoring, not by workflow.
 */
export function derivedStatusFor(stage: string, currentStatus: string): string | null {
  if (stage === "live" && currentStatus !== "live") return "live";
  if (stage !== "live" && currentStatus === "live") return "pending";
  return null;
}
