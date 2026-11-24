/**
 * CONTENT WORKFLOW — shared vocabulary and transition rules.
 *
 * The draft lifecycle is small enough to be a single table, but the rules about
 * who may move it where are not obvious, so they live here rather than being
 * re-derived by the route, the RLS policy and the UI.
 *
 *   draft ──submit──▶ in_review ──approve──▶ approved ──publish──▶ published
 *                        │
 *                        └──request revision──▶ revision_requested ──resubmit──▶ in_review
 *
 * Two properties are deliberate:
 *
 *   - `approved` is only reachable from `in_review`, never from `draft`. Skipping
 *     review would let a writer approve their own work.
 *   - `revision_requested` is a distinct state from `draft`. "Not yet started" and
 *     "went through review and needs changes" are different situations, and the
 *     queue must be able to tell them apart.
 */

export const DRAFT_STATUSES = [
  "draft",
  "in_review",
  "revision_requested",
  "approved",
  "published",
] as const;

export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Legal moves. Anything absent is refused by the API. */
export const DRAFT_TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  draft: ["in_review"],
  in_review: ["approved", "revision_requested"],
  revision_requested: ["in_review"],
  approved: ["published", "revision_requested"],
  published: [],
};

export function canTransitionDraft(from: string, to: string): boolean {
  const allowed = DRAFT_TRANSITIONS[from as DraftStatus];
  return Boolean(allowed?.includes(to as DraftStatus));
}

/**
 * Which permission a transition requires.
 *
 * Submitting is the writer's act; approving is the reviewer's. Keeping them
 * separate is what stops a writer approving their own draft, which the RLS policy
 * alone cannot express because both roles can write the row.
 */
export type TransitionAuthority = "write" | "approve";

export const DRAFT_TRANSITION_AUTHORITY: Record<string, TransitionAuthority> = {
  in_review: "write", // submit or resubmit
  approved: "approve",
  published: "approve",
  revision_requested: "approve",
};

/** Approving content is a distinct permission from editing it. */
export const DRAFT_APPROVE_PERMISSION = "briefs:approve" as const;

/** Word count as a human would describe it: whitespace-separated tokens. */
export function countWords(body: string): number {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

/** Statuses that still need somebody to do something. */
export const DRAFT_OPEN_STATUSES: DraftStatus[] = ["draft", "revision_requested", "in_review"];

export function isOpenDraftStatus(status: string): boolean {
  return DRAFT_OPEN_STATUSES.includes(status as DraftStatus);
}

/**
 * Whether a client may read this draft.
 *
 * A client sees a draft only once it has been approved or published. Showing work
 * in review would invite feedback on a draft that is about to change, and showing
 * `revision_requested` would expose the agency's internal correction cycle.
 */
export function clientMaySeeDraft(status: string): boolean {
  return status === "approved" || status === "published";
}
