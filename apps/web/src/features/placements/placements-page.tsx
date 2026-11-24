import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, LayoutGrid, Plus, RefreshCw, Search } from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAccessToken, useAuth } from "@/providers/auth";
import { apiRequest, type ApiError } from "@/lib/api";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { PageHeading } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { cn } from "@/lib/utils";
import {
  createPlacement,
  listCampaignOptions,
  listPublisherOptions,
  listStaffOptions,
  transitionPlacement,
  useBoard,
  type BoardPlacement,
} from "./use-placements";
import { KanbanBoard, OrphanNotice } from "./kanban-board";
import { MoveDialog, PlacementDrawer } from "./placement-dialogs";

/**
 * PLACEMENT PIPELINE PAGE.
 *
 * The board is the primary view because the work is a pipeline: a table hides the
 * fact that eight placements are stuck in content writing, and that is the single
 * most useful thing an account manager can see.
 */
export function PlacementsPage() {
  const token = useAccessToken();
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const canWrite = can("placements:write");

  const [campaignId, setCampaignId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<BoardPlacement | null>(null);

  const board = useBoard({ campaignId: campaignId || undefined });

  const campaigns = useQuery({
    queryKey: ["campaign-options"],
    queryFn: () => listCampaignOptions(token),
    enabled: Boolean(token),
    staleTime: 60_000,
  });

  const publishers = useQuery({
    queryKey: ["publisher-options"],
    queryFn: () => listPublisherOptions(token),
    enabled: Boolean(token) && createOpen,
    staleTime: 60_000,
  });

  const staff = useQuery({
    queryKey: ["staff-options"],
    queryFn: () => listStaffOptions(token),
    enabled: Boolean(token) && createOpen && can("staff:read"),
    staleTime: 60_000,
  });

  /**
   * Client-side search filter.
   *
   * Applied to the loaded board rather than round-tripping: the board is already
   * a bounded set, and filtering server-side would hide a stage's count and make
   * the drag targets jump while typing.
   */
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return board.stages;
    return board.stages.map((s) => ({
      ...s,
      placements: s.placements.filter(
        (p) =>
          p.target_url.toLowerCase().includes(term) ||
          (p.anchor_text ?? "").toLowerCase().includes(term),
      ),
    }));
  }, [board.stages, search]);

  const totalShown = filtered.reduce((n, s) => n + s.placements.length, 0);

  const move = useMutation({
    mutationFn: async ({ id, toStage, extra }: { id: string; toStage: string; extra: Record<string, string | undefined> }) =>
      transitionPlacement(id, toStage, extra, token),
    onSuccess: () => {
      void board.reload();
      void queryClient.invalidateQueries({ queryKey: ["placement"] });
    },
  });

  const [boardError, setBoardError] = useState<string | null>(null);

  const handleMove = async (placement: BoardPlacement, toStage: string) => {
    setBoardError(null);
    try {
      await move.mutateAsync({ id: placement.id, toStage, extra: {} });
    } catch (err) {
      const apiErr = err as ApiError;
      // The server refuses stages that need extra input (approval note, live URL).
      // Rather than surfacing a bare error, open the dialog so the user can
      // supply what is missing — which is what they were trying to do anyway.
      if (apiErr.status === 400 && /approval|live URL|note/i.test(apiErr.message)) {
        setMoveTarget(placement);
        return;
      }
      setBoardError(apiErr.message);
    }
  };

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Placement Pipeline"
          description="Every link in flight, from first pitch to a live URL. Drag a card to move it."
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => void board.reload()} loading={board.loading}>
                <RefreshCw />
                Refresh
              </Button>
              {canWrite && (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  New placement
                </Button>
              )}
            </>
          }
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by target URL or anchor"
              aria-label="Filter placements"
              className="pl-8"
            />
          </div>

          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <span className="whitespace-nowrap">Campaign</span>
            <select
              value={campaignId}
              onChange={(e) => setCampaignId(e.target.value)}
              className="h-9 min-w-0 rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              aria-label="Filter by campaign"
            >
              <option value="">All campaigns</option>
              {(campaigns.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <p className="ml-auto text-[12px] tabular-nums text-muted" aria-live="polite">
            {totalShown} placement{totalShown === 1 ? "" : "s"}
          </p>
        </div>

        {boardError && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-danger)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{boardError}</p>
          </div>
        )}

        {board.error ? (
          <ErrorState description={board.error} onRetry={() => void board.reload()} />
        ) : !board.loading && totalShown === 0 && !search ? (
          <EmptyState
            icon={LayoutGrid}
            title="The pipeline is empty"
            description="Create a placement to start tracking a link from prospecting through to a live URL."
            action={
              canWrite ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  New placement
                </Button>
              ) : undefined
            }
          />
        ) : (
          <div className="-mx-1 px-1">
            <KanbanBoard
              stages={filtered}
              loading={board.loading}
              canWrite={canWrite}
              onOpen={(p) => setDrawerId(p.id)}
              onMove={handleMove}
              onMoveRequest={setMoveTarget}
            />
            <OrphanNotice orphans={board.orphans} />
          </div>
        )}
      </PageStack>

      <PlacementDrawer
        placementId={drawerId}
        open={Boolean(drawerId)}
        onOpenChange={(v) => !v && setDrawerId(null)}
        onMoveRequest={setMoveTarget}
      />

      <MoveDialog
        placement={moveTarget}
        open={Boolean(moveTarget)}
        onOpenChange={(v) => !v && setMoveTarget(null)}
        onConfirm={async (toStage, extra) => {
          if (!moveTarget) return;
          await move.mutateAsync({ id: moveTarget.id, toStage, extra });
        }}
      />

      <CreatePlacementDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        campaigns={campaigns.data ?? []}
        publishers={publishers.data ?? []}
        staff={staff.data ?? []}
        onCreated={() => void board.reload()}
      />
    </PageContainer>
  );
}

function CreatePlacementDialog({
  open,
  onOpenChange,
  campaigns,
  publishers,
  staff,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaigns: Array<{ id: string; name: string }>;
  publishers: Array<{ id: string; domain: string; dr: number | null }>;
  staff: Array<{ id: string; full_name: string | null; email: string }>;
  onCreated: () => void;
}) {
  const token = useAccessToken();
  // Tier-2 authority, checked separately from `placements:write`. The API refuses
  // a cost from a role without it, so the field must not be offered either.
  const { can } = useAuth();
  const canCost = can("costs:write");

  const [form, setForm] = useState({
    campaignId: "",
    targetUrl: "",
    anchorText: "",
    anchorType: "",
    publisherId: "",
    assignedTo: "",
    negotiatedCost: "",
    contentDueDate: "",
    internalNotes: "",
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await createPlacement(
        {
          campaignId: form.campaignId,
          targetUrl: form.targetUrl,
          anchorText: form.anchorText || undefined,
          anchorType: form.anchorType || undefined,
          publisherId: form.publisherId || undefined,
          assignedTo: form.assignedTo || undefined,
          negotiatedCost: form.negotiatedCost ? Number(form.negotiatedCost) : undefined,
          contentDueDate: form.contentDueDate || undefined,
          internalNotes: form.internalNotes || undefined,
          notes: form.notes || undefined,
        },
        token,
      );
      onCreated();
      onOpenChange(false);
      setForm({
        campaignId: "", targetUrl: "", anchorText: "", anchorType: "", publisherId: "",
        assignedTo: "", negotiatedCost: "", contentDueDate: "", internalNotes: "", notes: "",
      });
    } catch (err) {
      const apiErr = err as ApiError;
      setFieldErrors(apiErr.fieldErrors);
      setError(apiErr.message);
    } finally {
      setBusy(false);
    }
  };

  const invalid = !form.campaignId || !form.targetUrl;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl focus:outline-none">
          <div className="shrink-0 px-5 pt-5">
            <Dialog.Title className="text-[15px] font-semibold text-foreground">New placement</Dialog.Title>
            <Dialog.Description className="mb-4 mt-1 text-[12.5px] text-muted">
              Starts in <span className="font-medium text-foreground-soft">Prospected</span>. Move it along the board as
              the work progresses.
            </Dialog.Description>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5">
            <div className="space-y-3 pb-4">
            <Field label="Campaign" hint={fieldErrors.campaignId}>
              <select
                value={form.campaignId}
                onChange={set("campaignId")}
                className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              >
                <option value="">Select a campaign…</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Target URL" hint={fieldErrors.targetUrl ?? "The page on the client's site being linked to."}>
              <Input value={form.targetUrl} onChange={set("targetUrl")} type="url" placeholder="https://client.example/pricing" />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Anchor text">
                <Input value={form.anchorText} onChange={set("anchorText")} placeholder="best analytics tool" />
              </Field>
              <Field label="Anchor type">
                <select
                  value={form.anchorType}
                  onChange={set("anchorType")}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground"
                >
                  <option value="">—</option>
                  <option value="branded">Branded</option>
                  <option value="exact_match">Exact match</option>
                  <option value="partial_match">Partial match</option>
                  <option value="generic">Generic</option>
                  <option value="naked_url">Naked URL</option>
                  <option value="image_alt">Image alt</option>
                </select>
              </Field>
            </div>

            <Field label="Publisher" hint={fieldErrors.publisherId}>
              <select
                value={form.publisherId}
                onChange={set("publisherId")}
                className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground"
              >
                <option value="">Not yet assigned</option>
                {publishers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.domain}
                    {p.dr != null ? ` · DR ${p.dr}` : ""}
                  </option>
                ))}
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Assigned to">
                <select
                  value={form.assignedTo}
                  onChange={set("assignedTo")}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground"
                >
                  <option value="">Unassigned</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name ?? s.email}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Content due">
                <Input value={form.contentDueDate} onChange={set("contentDueDate")} type="date" />
              </Field>
            </div>

            {/* Hidden entirely for roles without `costs:write`. Offering a field
                that will be refused on submit is a worse experience than not
                showing it, and it advertises that a figure exists. */}
            {canCost && (
              <Field label="Negotiated publisher cost" hint="What we pay the publisher. Never shown in the client portal.">
                <Input value={form.negotiatedCost} onChange={set("negotiatedCost")} type="number" min="0" step="0.01" placeholder="425.00" />
              </Field>
            )}

            <Field label="Internal note" hint="Visible to staff only.">
              <Textarea value={form.internalNotes} onChange={set("internalNotes")} rows={2} />
            </Field>

            <Field label="Client-facing note" hint="Shown in the client portal.">
              <Textarea value={form.notes} onChange={set("notes")} rows={2} />
            </Field>

            {error && (
              <p role="alert" className="text-[12.5px] text-[var(--color-danger)]">
                {error}
              </p>
            )}
            </div>
          </div>

          {/* Actions live outside the scroll area so they stay reachable on a
              short viewport — a form whose submit button scrolls away is a dead
              end on a laptop. */}
          <div className="flex shrink-0 justify-end gap-2 border-t border-line px-5 py-3">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" loading={busy} onClick={submit} disabled={invalid}>
              <Plus />
              Create placement
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
