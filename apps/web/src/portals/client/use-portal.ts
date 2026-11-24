import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, type ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";

/**
 * CLIENT PORTAL DATA.
 *
 * Every read goes through `/portal/v1`, which is the surface a `client_user` is
 * allowed on. Nothing here touches `/api/v1` — that would 403, and relying on the
 * rejection rather than the correct endpoint would be using a security control as a
 * feature flag.
 *
 * The portal endpoints already limit what they select, so there is no filtering to
 * do here: `internal_notes`, cost, assignee and writer data are never sent.
 */

export interface PortalClient {
  id: string;
  name: string;
  domain: string | null;
  status: string;
}

export interface PortalCampaign {
  id: string;
  name: string;
  status: string;
  monthly_link_target: number | null;
}

export interface PortalPlacement {
  id: string;
  campaign_id: string;
  target_url: string;
  anchor_text: string | null;
  anchor_type: string | null;
  live_url: string | null;
  link_type: string | null;
  status: string;
  pipeline_stage: string;
  live_date: string | null;
  index_status: string | null;
  client_approved_at: string | null;
  notes: string | null;
}

export interface PortalDraft {
  id: string;
  placement_id: string;
  title: string | null;
  body_md: string;
  word_count: number;
  status: "in_review" | "approved" | "published";
  current_version: number | null;
  submitted_at: string | null;
  approved_at: string | null;
  client_approval_note: string | null;
}

export interface PortalOverview {
  clients: PortalClient[];
  campaigns: PortalCampaign[];
  livePlacements: number;
  totalPlacements: number;
}

export const PORTAL_KEYS = {
  overview: ["portal", "overview"] as const,
  placements: ["portal", "placements"] as const,
  campaigns: ["portal", "campaigns"] as const,
  drafts: ["portal", "drafts"] as const,
  draft: (id: string) => ["portal", "draft", id] as const,
};

export function usePortalOverview() {
  const token = useAccessToken();
  return useQuery({
    queryKey: PORTAL_KEYS.overview,
    queryFn: async () => {
      const res = await apiRequest<PortalOverview>("/portal/v1/overview", { token });
      return res.data;
    },
    enabled: Boolean(token),
  });
}

export function usePortalCampaigns() {
  const token = useAccessToken();
  return useQuery({
    queryKey: PORTAL_KEYS.campaigns,
    queryFn: async () => {
      const res = await apiRequest<PortalCampaign[]>("/portal/v1/campaigns", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function usePortalPlacements() {
  const token = useAccessToken();
  return useQuery({
    queryKey: PORTAL_KEYS.placements,
    queryFn: async () => {
      const res = await apiRequest<PortalPlacement[]>("/portal/v1/placements", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function usePortalDrafts() {
  const token = useAccessToken();
  return useQuery({
    queryKey: PORTAL_KEYS.drafts,
    queryFn: async () => {
      const res = await apiRequest<PortalDraft[]>("/portal/v1/drafts", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

/**
 * Approve and request changes.
 *
 * Both go through SECURITY DEFINER functions on the server: the client has no write
 * policy on `content_drafts`, and one broad enough to approve would also let them
 * rewrite the text. The UI therefore has no "edit" affordance at all — there is no
 * route behind it.
 */
export function usePortalDraftActions() {
  const token = useAccessToken();
  const qc = useQueryClient();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["portal"] });
  };

  const approve = useMutation({
    mutationFn: async (input: { draftId: string; note?: string }) => {
      const res = await apiRequest<{ id: string; status: string; approved_at: string }>(
        `/portal/v1/drafts/${input.draftId}/approve`,
        { method: "POST", body: { note: input.note }, token },
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  const requestRevision = useMutation({
    mutationFn: async (input: { draftId: string; note: string }) => {
      const res = await apiRequest<{ id: string; status: string }>(
        `/portal/v1/drafts/${input.draftId}/revision`,
        { method: "POST", body: { note: input.note }, token },
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  return { approve, requestRevision };
}

export function portalErrorMessage(err: unknown): string {
  return (err as ApiError)?.message ?? "Something went wrong";
}

/** Status → label and tone, shared by the list and the detail drawer. */
export const PORTAL_DRAFT_STATUS: Record<string, { label: string; tone: "info" | "success" | "brand" | "warning" }> = {
  in_review: { label: "Awaiting your review", tone: "info" },
  approved: { label: "Approved", tone: "success" },
  published: { label: "Published", tone: "brand" },
  revision_requested: { label: "Changes requested", tone: "warning" },
};
