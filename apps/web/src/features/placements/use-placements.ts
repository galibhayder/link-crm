import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";

/**
 * PIPELINE STAGES — the six columns, shared by the board and the detail panel.
 *
 * Kept as a literal as well as fetched from the server: the UI must render
 * something before the request lands, and a spinner on every column header is
 * worse than rendering the known stages and correcting them when the server
 * answers.
 */
export const PLACEMENT_STAGES = [
  { key: "prospected", label: "Prospected", hint: "Identified, not yet approached" },
  { key: "pitched", label: "Pitched", hint: "Approached the publisher" },
  { key: "client_approved", label: "Client Approved", hint: "Anchor and target signed off" },
  { key: "content_writing", label: "Content Writing", hint: "Draft in progress" },
  { key: "submitted", label: "Submitted", hint: "Sent to publisher" },
  { key: "live", label: "Live", hint: "Link published" },
] as const;

export type PlacementStageKey = (typeof PLACEMENT_STAGES)[number]["key"];

/**
 * Which moves the board permits.
 *
 * Mirrors `apps/api/src/modules/placements/pipeline.ts`. Duplicated deliberately:
 * the UI needs to know a drop is illegal BEFORE it animates, and asking the server
 * on every drag-over would be unusable. The server remains authoritative — a
 * disagreement here produces a rejected request, not a bad write.
 */
const ALLOWED: Record<PlacementStageKey, PlacementStageKey[]> = {
  prospected: ["pitched", "prospected"],
  pitched: ["client_approved", "prospected", "pitched"],
  client_approved: ["content_writing", "pitched", "client_approved"],
  content_writing: ["submitted", "client_approved", "content_writing"],
  submitted: ["live", "content_writing", "submitted"],
  live: ["live"],
};

export function canMove(from: string, to: string): boolean {
  if (from === to) return true;
  const allowed = ALLOWED[from as PlacementStageKey];
  return Boolean(allowed?.includes(to as PlacementStageKey));
}

export interface BoardPlacement {
  id: string;
  campaign_id: string;
  publisher_id: string | null;
  target_url: string;
  anchor_text: string | null;
  anchor_type: string | null;
  live_url: string | null;
  pipeline_stage: string;
  status: string;
  assigned_to: string | null;
  content_assignee: string | null;
  content_due_date: string | null;
  /**
   * Present only for callers that may see tier-2 money.
   *
   * There is no `negotiated_cost` on the placement row any more: it was moved to
   * `placement_costs` because the column leaked wholesale cost to the account
   * manager and content writer. The API joins the agreed figure in for roles that
   * hold `costs:read`, so this is absent — not null — for everyone else.
   */
  agreed_cost?: number | null;
  client_approved_at: string | null;
  live_date: string | null;
  updated_at: string;
}

export interface BoardStage {
  key: string;
  label: string;
  sort_order?: number;
  placements: BoardPlacement[];
}

interface BoardResponse {
  stages: BoardStage[];
  orphans: BoardPlacement[];
}

interface ListEnvelope<T> {
  data: T;
  meta?: { total?: number };
}

/**
 * Board data.
 *
 * One request for the whole board rather than one per column: the columns are
 * rendered together, and six parallel requests would flicker as they resolve at
 * different times.
 */
export function useBoard(params: { campaignId?: string; assignedTo?: string } = {}) {
  // The token comes from the caller's session. Without it the request would be
  // anonymous, and before this was wired up the board fired immediately on mount
  // and got a 401 on every hard refresh of a deep link.
  const token = useAccessToken();

  const [stages, setStages] = useState<BoardStage[]>(() =>
    PLACEMENT_STAGES.map((s) => ({ key: s.key, label: s.label, placements: [] })),
  );
  const [orphans, setOrphans] = useState<BoardPlacement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(
    () => buildQuery({ campaignId: params.campaignId, assignedTo: params.assignedTo }),
    [params.campaignId, params.assignedTo],
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      // Nothing to fetch until the session is known. Staying in `loading` is
      // correct here: the alternative is a flash of "empty pipeline" that looks
      // like the board has no data.
      if (!token) return;

      setLoading(true);
      try {
        const res = await apiRequest<BoardResponse>(`/api/v1/placements/board${query}`, { signal, token });
        const next = res.data?.stages ?? [];

        // Merge with the known stage list so a stage the server omitted still
        // renders as an empty column rather than disappearing from the board.
        const merged = PLACEMENT_STAGES.map((s) => {
          const fromServer = next.find((n) => n.key === s.key);
          return {
            key: s.key,
            label: fromServer?.label ?? s.label,
            placements: fromServer?.placements ?? [],
          };
        });

        setStages(merged);
        setOrphans(res.data?.orphans ?? []);
        setError(null);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setError((err as ApiError).message);
      } finally {
        setLoading(false);
      }
    },
    [query, token],
  );

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, token]);

  return { stages, orphans, loading, error, reload: () => load() };
}

export interface PlacementDetail extends BoardPlacement {
  notes: string | null;
  internal_notes: string | null;
  client_approval_note: string | null;
  client_rejected_reason: string | null;
  submitted_at: string | null;
  target_url: string;
  campaign?: { id: string; name: string; client_id: string } | null;
  publisher?: { id: string; domain: string; dr: number | null; monthly_traffic: number | null } | null;
  assignee?: { id: string; full_name: string | null; email: string } | null;
}

export interface PlacementEvent {
  id: string;
  event_type: string;
  from_stage: string | null;
  to_stage: string | null;
  actor_id: string | null;
  actor_name: string | null;
  summary: string | null;
  detail: Record<string, unknown>;
  created_at: string;
}

export async function getPlacement(id: string, token?: string | null): Promise<PlacementDetail> {
  const res = await apiRequest<PlacementDetail>(`/api/v1/placements/${id}`, { token });
  return res.data;
}

export async function getPlacementHistory(id: string, token?: string | null): Promise<PlacementEvent[]> {
  const res = await apiRequest<PlacementEvent[]>(`/api/v1/placements/${id}/history`, { token });
  return res.data ?? [];
}

/**
 * Move a placement to another stage.
 *
 * Client approval requires a note, and going live requires a URL — both are
 * enforced server-side, so the caller supplies them when relevant.
 */
export async function transitionPlacement(
  id: string,
  toStage: string,
  extra: { note?: string; clientApprovalNote?: string; liveUrl?: string } = {},
  token?: string | null,
): Promise<PlacementDetail> {
  const res = await apiRequest<PlacementDetail>(`/api/v1/placements/${id}/transition`, {
    method: "POST",
    body: { toStage, ...extra },
    token,
  });
  return res.data;
}

export async function clientDecision(
  id: string,
  decision: "approve" | "reject",
  note: string,
  token?: string | null,
): Promise<PlacementDetail> {
  const res = await apiRequest<PlacementDetail>(`/api/v1/placements/${id}/client-decision`, {
    method: "POST",
    body: { decision, note },
    token,
  });
  return res.data;
}

export interface CreatePlacementInput {
  campaignId: string;
  targetUrl: string;
  anchorText?: string;
  anchorType?: string;
  publisherId?: string;
  assignedTo?: string;
  negotiatedCost?: number;
  contentDueDate?: string;
  internalNotes?: string;
  notes?: string;
}

export async function createPlacement(
  input: CreatePlacementInput,
  token?: string | null,
): Promise<PlacementDetail> {
  const res = await apiRequest<PlacementDetail>("/api/v1/placements", { method: "POST", body: input, token });
  return res.data;
}

export async function updatePlacement(
  id: string,
  patch: Record<string, unknown>,
  token?: string | null,
): Promise<PlacementDetail> {
  const res = await apiRequest<PlacementDetail>(`/api/v1/placements/${id}`, { method: "PATCH", body: patch, token });
  return res.data;
}

export async function archivePlacement(id: string, token?: string | null): Promise<void> {
  await apiRequest(`/api/v1/placements/${id}`, { method: "DELETE", token });
}

export interface CampaignOption {
  id: string;
  name: string;
  client_id: string;
}

export async function listCampaignOptions(token?: string | null): Promise<CampaignOption[]> {
  const res = await apiRequest<CampaignOption[]>("/api/v1/campaigns?limit=200", { token });
  return res.data ?? [];
}

export interface PublisherOption {
  id: string;
  domain: string;
  dr: number | null;
}

export async function listPublisherOptions(token?: string | null): Promise<PublisherOption[]> {
  const res = await apiRequest<PublisherOption[]>("/api/v1/publishers?limit=200", { token });
  return res.data ?? [];
}

export interface StaffOption {
  id: string;
  full_name: string | null;
  email: string;
  role: string;
}

export async function listStaffOptions(token?: string | null): Promise<StaffOption[]> {
  const res = await apiRequest<StaffOption[]>("/api/v1/staff?limit=200", { token });
  return res.data ?? [];
}

export type { ListEnvelope };
