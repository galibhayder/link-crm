import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";

/**
 * CONTENT DATA.
 *
 * All calls take the token explicitly. A hook that fires without one gets a 401
 * and — before that was fixed in Phase 4 — signed the user out on every page load.
 */

export interface Brief {
  id: string;
  placement_id: string;
  assigned_to: string | null;
  brief: string | null;
  status: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  draft?: Draft | null;
}

export interface Draft {
  id: string;
  brief_id: string;
  placement_id: string;
  title: string | null;
  body_md: string;
  word_count: number;
  status: "draft" | "in_review" | "revision_requested" | "approved" | "published";
  current_version: number | null;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DraftVersion {
  id: string;
  version: number;
  title: string | null;
  word_count: number;
  reason: string;
  created_by: string | null;
  created_at: string;
}

export interface RevisionRequest {
  id: string;
  notes: string;
  status: "open" | "resolved" | "withdrawn";
  requested_by: string | null;
  created_at: string;
  resolved_at: string | null;
  resolved_by_version: number | null;
}

export interface ContentSummary {
  byStatus: Record<string, number>;
  open: number;
  total: number;
  canApprove: boolean;
}

export const CONTENT_KEYS = {
  briefs: (params?: Record<string, unknown>) => ["content", "briefs", params ?? {}] as const,
  draft: (id: string) => ["content", "draft", id] as const,
  queue: ["content", "queue"] as const,
  summary: ["content", "summary"] as const,
};

export function useBriefs(params: { mine?: boolean; status?: string; placementId?: string } = {}) {
  const token = useAccessToken();
  return useQuery({
    queryKey: CONTENT_KEYS.briefs(params),
    queryFn: async () => {
      const res = await apiRequest<Brief[]>(`/api/v1/content/briefs${buildQuery({ limit: 50, ...params })}`, { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function useDraft(id: string | null) {
  const token = useAccessToken();
  return useQuery({
    queryKey: CONTENT_KEYS.draft(id ?? "none"),
    queryFn: async () => {
      const res = await apiRequest<Draft & { versions: DraftVersion[]; revisions: RevisionRequest[] }>(
        `/api/v1/content/drafts/${id}`,
        { token },
      );
      return res.data;
    },
    enabled: Boolean(token && id),
  });
}

export function useContentSummary() {
  const token = useAccessToken();
  return useQuery({
    queryKey: CONTENT_KEYS.summary,
    queryFn: async () => {
      const res = await apiRequest<ContentSummary>("/api/v1/content/summary", { token });
      return res.data;
    },
    enabled: Boolean(token),
  });
}

export function useMyQueue() {
  const token = useAccessToken();
  return useQuery({
    queryKey: CONTENT_KEYS.queue,
    queryFn: async () => {
      const res = await apiRequest<Brief[]>("/api/v1/content/my-queue", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function useContentActions() {
  const token = useAccessToken();
  const qc = useQueryClient();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["content"] });
  };

  const createDraft = useMutation({
    mutationFn: async (input: { briefId: string; title?: string; bodyMd?: string }) => {
      const res = await apiRequest<Draft>("/api/v1/content/drafts", { method: "POST", body: input, token });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const saveVersion = useMutation({
    mutationFn: async (input: { draftId: string; bodyMd: string; title?: string }) => {
      const res = await apiRequest<Draft>(`/api/v1/content/drafts/${input.draftId}/versions`, {
        method: "POST",
        body: { bodyMd: input.bodyMd, title: input.title },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const transition = useMutation({
    mutationFn: async (input: { draftId: string; status: string; notes?: string }) => {
      const res = await apiRequest<Draft>(`/api/v1/content/drafts/${input.draftId}/transition`, {
        method: "POST",
        body: { status: input.status, notes: input.notes },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const createBrief = useMutation({
    mutationFn: async (input: { placementId: string; assignedTo?: string; brief?: string; dueDate?: string }) => {
      const res = await apiRequest<Brief>("/api/v1/content/briefs", { method: "POST", body: input, token });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const restoreVersion = useMutation({
    mutationFn: async (input: { draftId: string; version: number }) => {
      const res = await apiRequest<Draft>(`/api/v1/content/drafts/${input.draftId}/restore/${input.version}`, {
        method: "POST",
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  return { createDraft, saveVersion, transition, createBrief, restoreVersion };
}

export function draftErrorMessage(err: unknown): string {
  return (err as ApiError)?.message ?? "Something went wrong";
}

/** Status → tone and label, shared by the queue and the draft panel. */
export const DRAFT_STATUS_META: Record<
  string,
  { label: string; tone: "neutral" | "brand" | "success" | "warning" | "danger" | "info" | "outline" }
> = {
  draft: { label: "Draft", tone: "neutral" },
  in_review: { label: "In review", tone: "info" },
  revision_requested: { label: "Revision requested", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  published: { label: "Published", tone: "brand" },
};
