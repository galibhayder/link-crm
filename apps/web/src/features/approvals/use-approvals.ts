import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";

/**
 * APPROVAL QUEUES.
 *
 * Four queries, each pointed at an endpoint that already exists. Nothing new is
 * invented here: the account manager's job is to act on records other modules
 * already own, and a bespoke "approvals" endpoint would be a second source of truth
 * for the same state.
 *
 * Note which endpoints are used for the actions:
 *
 *   placements → `client-decision`, NOT `/transition`
 *
 * account_manager holds `placements:approve` but not `placements:write`. Recording a
 * client decision is exactly the authority that role has; the transition endpoint
 * would 403. Using the right endpoint is what makes the permission split work rather
 * than fight itself.
 */

export interface ApprovalPlacement {
  id: string;
  campaign_id: string;
  target_url: string;
  anchor_text: string | null;
  anchor_type: string | null;
  pipeline_stage: string;
  client_approval_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalDraft {
  id: string;
  brief_id: string;
  placement_id: string;
  title: string | null;
  body_md: string;
  word_count: number;
  status: string;
  submitted_at: string | null;
  current_version: number | null;
}

export interface ApprovalProspect {
  id: string;
  domain: string;
  stage: string;
  priority: string;
  dr: number | null;
  price: number | null;
  campaign_id: string;
}

export interface ApprovalPublisher {
  id: string;
  domain: string;
  dr: number | null;
  monthly_traffic: number | null;
  spam_score: number | null;
  status: string;
  niche: string[] | null;
}

export const APPROVAL_KEYS = {
  placements: ["approvals", "placements"] as const,
  drafts: ["approvals", "drafts"] as const,
  prospects: ["approvals", "prospects"] as const,
  publishers: ["approvals", "publishers"] as const,
};

export function usePlacementApprovals() {
  const token = useAccessToken();
  return useQuery({
    queryKey: APPROVAL_KEYS.placements,
    queryFn: async () => {
      const res = await apiRequest<ApprovalPlacement[]>(
        `/api/v1/placements${buildQuery({ pipelineStage: "pitched", limit: 50, order: "asc", sort: "updated_at" })}`,
        { token },
      );
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function useDraftApprovals() {
  const token = useAccessToken();
  return useQuery({
    queryKey: APPROVAL_KEYS.drafts,
    queryFn: async () => {
      const res = await apiRequest<ApprovalDraft[]>(
        `/api/v1/content/drafts${buildQuery({ status: "in_review", limit: 50 })}`,
        { token },
      );
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function useProspectReviews() {
  const token = useAccessToken();
  return useQuery({
    queryKey: APPROVAL_KEYS.prospects,
    queryFn: async () => {
      const res = await apiRequest<ApprovalProspect[]>(
        `/api/v1/prospects${buildQuery({ priority: "high", limit: 50 })}`,
        { token },
      );
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function usePublisherReviews() {
  const token = useAccessToken();
  return useQuery({
    queryKey: APPROVAL_KEYS.publishers,
    queryFn: async () => {
      const res = await apiRequest<ApprovalPublisher[]>(
        `/api/v1/publishers${buildQuery({ status: "active", limit: 50, sort: "dr" })}`,
        { token },
      );
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function useApprovalActions() {
  const token = useAccessToken();
  const qc = useQueryClient();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["approvals"] });
  };

  /** Approve or reject a client's anchor decision on a placement. */
  const decidePlacement = useMutation({
    mutationFn: async (input: { placementId: string; decision: "approve" | "reject"; note: string }) => {
      const res = await apiRequest(`/api/v1/placements/${input.placementId}/client-decision`, {
        method: "POST",
        body: { decision: input.decision, note: input.note },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  /** Approve a draft, or send it back — the existing content workflow. */
  const transitionDraft = useMutation({
    mutationFn: async (input: {
      draftId: string;
      status: "approved" | "revision_requested";
      notes?: string;
    }) => {
      const res = await apiRequest(`/api/v1/content/drafts/${input.draftId}/transition`, {
        method: "POST",
        body: { status: input.status, notes: input.notes },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  /** Move a prospect through its pipeline. `reason` is required for lost stages. */
  const setProspectStage = useMutation({
    mutationFn: async (input: { prospectId: string; stage: string; reason?: string }) => {
      const res = await apiRequest(`/api/v1/prospects/${input.prospectId}/stage`, {
        method: "PATCH",
        body: { stage: input.stage, reason: input.reason },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  /** Pause or blacklist a publisher after review. */
  const setPublisherStatus = useMutation({
    mutationFn: async (input: { publisherId: string; status: "active" | "paused" | "blacklisted" }) => {
      const res = await apiRequest(`/api/v1/publishers/${input.publisherId}`, {
        method: "PATCH",
        body: { status: input.status },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  return { decidePlacement, transitionDraft, setProspectStage, setPublisherStatus };
}

export function approvalErrorMessage(err: unknown): string {
  return (err as ApiError)?.message ?? "Something went wrong";
}
