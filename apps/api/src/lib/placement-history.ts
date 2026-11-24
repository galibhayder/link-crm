import type { Request } from "express";
import { admin } from "../integrations/supabase.js";
import { logger } from "./logger.js";

/**
 * PLACEMENT HISTORY.
 *
 * Written with service_role because `placement_events` has no INSERT policy for
 * any end-user role — history must not be forgeable, and "who moved this to
 * submitted and when" is exactly what an audit asks for.
 *
 * The write is awaited by the caller so a stage change is not reported as
 * successful before its history exists, but a failure never fails the operation:
 * losing a history row is bad, refusing a legitimate stage change is worse. The
 * failure is logged at error level so the gap is visible.
 */

export type PlacementEventType =
  | "created"
  | "stage_change"
  | "assignment_change"
  | "client_approved"
  | "client_rejected"
  | "cost_agreed"
  | "note_added"
  | "publisher_assigned"
  | "archived"
  | "restored";

export interface PlacementEvent {
  organizationId: string;
  placementId: string;
  eventType: PlacementEventType;
  fromStage?: string | null;
  toStage?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  summary?: string | null;
  detail?: Record<string, unknown>;
}

export async function recordPlacementEvent(event: PlacementEvent): Promise<void> {
  try {
    const { error } = await admin().from("placement_events").insert({
      organization_id: event.organizationId,
      placement_id: event.placementId,
      event_type: event.eventType,
      from_stage: event.fromStage ?? null,
      to_stage: event.toStage ?? null,
      actor_id: event.actorId ?? null,
      actor_name: event.actorName ?? null,
      summary: event.summary ?? null,
      detail: event.detail ?? {},
    });

    if (error) {
      logger.error(
        { err: { code: error.code, message: error.message }, event, severity: "history_gap" },
        "PLACEMENT EVENT REJECTED — the change has no history row",
      );
    }
  } catch (err) {
    logger.error({ err, event, severity: "history_gap" }, "PLACEMENT EVENT THREW");
  }
}

/** Convenience wrapper that fills the actor from the request. */
export function recordFromRequest(
  req: Request,
  event: Omit<PlacementEvent, "organizationId" | "actorId">,
): Promise<void> {
  return recordPlacementEvent({
    ...event,
    organizationId: req.auth?.orgId ?? "",
    actorId: req.auth?.userId ?? null,
  });
}
