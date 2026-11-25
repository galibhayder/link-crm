import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, type ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";

/**
 * LINKS AWAITING A HUMAN DECISION.
 *
 * Verification fetches the publisher page and reads the server HTML. When the page
 * is rendered by JavaScript there is nothing to read, so instead of guessing it
 * returns `needs_manual_review` and this queue asks someone to open the page.
 *
 * The API decides what belongs here (`v_link_review_queue`), including the subtle
 * part: only the LATEST check counts, and a placement already adjudicated is
 * excluded. The client does not re-derive any of that.
 */
export interface ReviewItem {
  check_id: string;
  organization_id: string;
  placement_id: string;
  checked_at: string;
  verdict: "needs_manual_review";
  failure_reason: string | null;
  http_status: number | null;
  http_final_url: string | null;
  elapsed_ms: number | null;
  live_url: string | null;
  target_url: string;
  anchor_text: string | null;
  anchor_type: string | null;
  campaign_id: string;
  campaign_name: string;
  client_id: string;
  client_name: string;
  placement_status: string;
  pipeline_stage: string | null;
  last_checked_at: string | null;
}

export type ReviewResolution = "present" | "missing";

export const REVIEW_KEYS = {
  queue: () => ["link-reviews", "queue"] as const,
};

export function useReviewQueue() {
  const token = useAccessToken();

  return useQuery({
    queryKey: REVIEW_KEYS.queue(),
    queryFn: async () => {
      const res = await apiRequest<ReviewItem[]>("/api/v1/placements/review-queue", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function useResolveReview() {
  const token = useAccessToken();
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: { placementId: string; checkId: string; resolution: ReviewResolution; note?: string }) => {
      const res = await apiRequest(`/api/v1/placements/${input.placementId}/review`, {
        method: "POST",
        token,
        body: {
          resolution: input.resolution,
          checkId: input.checkId,
          ...(input.note ? { note: input.note } : {}),
        },
      });
      return res.data;
    },
    onSuccess: () => {
      // The queue changed, and the placement's review state changed with it.
      void qc.invalidateQueries({ queryKey: ["link-reviews"] });
      void qc.invalidateQueries({ queryKey: ["placements"] });
    },
  });
}

export function reviewErrorMessage(err: unknown): string {
  return (err as ApiError)?.message ?? "Something went wrong";
}

/**
 * Why the automatic check gave up.
 *
 * The database stores a precise operator-facing explanation — "Page looks
 * client-rendered (empty <div id=\"root\"> ...) with only 312 characters of server
 * HTML". That is the right text for a check row and the wrong text for a queue
 * row: the reviewer's question is "what do I do", not "which heuristic fired".
 */
export function reviewExplain(item: Pick<ReviewItem, "failure_reason">): string {
  const reason = item.failure_reason ?? "";
  if (/client-rendered|javascript|shell/i.test(reason)) {
    return "The page is built by JavaScript, so its HTML contains no links to read. Open it in a browser to see the real page.";
  }
  return reason || "Verification could not judge this page.";
}
