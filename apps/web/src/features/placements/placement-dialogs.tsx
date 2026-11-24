import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  ExternalLink,
  Link2,
  Loader2,
  StickyNote,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Label, Textarea } from "@/components/ui/input";
import { cn, formatRelative, humanize } from "@/lib/utils";
import type { ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";
import {
  canMove,
  getPlacementHistory,
  PLACEMENT_STAGES,
  type BoardPlacement,
  type PlacementDetail,
  type PlacementEvent,
} from "./use-placements";
import { money, shortUrl } from "./kanban-board";

/**
 * MOVE DIALOG.
 *
 * Used both by the drag-and-drop board (as the fallback for keyboard users and
 * for the moves that need extra input) and by the detail panel.
 *
 * The extra fields are shown only when the target stage requires them, because a
 * form that always asks for a live URL is noise for a prospected → pitched move.
 */
export function MoveDialog({
  placement,
  open,
  onOpenChange,
  onConfirm,
}: {
  placement: BoardPlacement | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onConfirm: (toStage: string, extra: { note?: string; clientApprovalNote?: string; liveUrl?: string }) => Promise<void>;
}) {
  const [toStage, setToStage] = useState<string>("");
  const [note, setNote] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [liveUrl, setLiveUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && placement) {
      const allowed = PLACEMENT_STAGES.filter(
        (s) => s.key !== placement.pipeline_stage && canMove(placement.pipeline_stage, s.key),
      );
      setToStage(allowed[0]?.key ?? "");
      setNote("");
      setApprovalNote("");
      setLiveUrl(placement.live_url ?? "");
      setError(null);
    }
  }, [open, placement]);

  const options = useMemo(
    () =>
      placement
        ? PLACEMENT_STAGES.filter((s) => s.key !== placement.pipeline_stage && canMove(placement.pipeline_stage, s.key))
        : [],
    [placement],
  );

  const needsApproval = toStage === "client_approved";
  const needsUrl = toStage === "live";

  const submit = async () => {
    if (!toStage) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(toStage, {
        note: note || undefined,
        clientApprovalNote: needsApproval ? approvalNote : undefined,
        liveUrl: needsUrl ? liveUrl : undefined,
      });
      onOpenChange(false);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <div className="mb-1 flex items-center justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-foreground">Move placement</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 text-[12.5px] text-muted">
            {placement ? shortUrl(placement.target_url) : ""} — currently{" "}
            <span className="font-medium text-foreground-soft">
              {humanize(placement?.pipeline_stage ?? "")}
            </span>
          </Dialog.Description>

          {options.length === 0 ? (
            <p className="rounded-lg border border-line bg-surface-sunken px-3 py-3 text-[12.5px] text-muted">
              This placement is at a final stage. It cannot move further.
            </p>
          ) : (
            <div className="space-y-3">
              <div>
                <Label htmlFor="move-stage">Move to</Label>
                <select
                  id="move-stage"
                  value={toStage}
                  onChange={(e) => setToStage(e.target.value)}
                  className="mt-1 h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                >
                  {options.map((o) => (
                    <option key={o.key} value={o.key}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11.5px] text-muted">
                  {PLACEMENT_STAGES.find((s) => s.key === toStage)?.hint}
                </p>
              </div>

              {needsApproval && (
                <Field
                  label="How did the client approve?"
                  hint="Required. The stage means nothing without a record of who said yes."
                >
                  <Textarea
                    value={approvalNote}
                    onChange={(e) => setApprovalNote(e.target.value)}
                    rows={2}
                    placeholder="Approved by email from Jane on 14 March"
                  />
                </Field>
              )}

              {needsUrl && (
                <Field label="Live URL" hint="Required — link monitoring checks this address.">
                  <Input
                    value={liveUrl}
                    onChange={(e) => setLiveUrl(e.target.value)}
                    placeholder="https://publisher.example/article"
                    type="url"
                  />
                </Field>
              )}

              <Field label="Note (optional)">
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed?" />
              </Field>

              {error && (
                <p role="alert" className="text-[12.5px] text-[var(--color-danger)]">
                  {error}
                </p>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  loading={busy}
                  onClick={submit}
                  disabled={needsApproval ? approvalNote.trim().length < 3 : needsUrl ? !liveUrl.trim() : false}
                >
                  <ArrowRight />
                  Move
                </Button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const EVENT_ICON: Record<string, typeof Check> = {
  created: Link2,
  stage_change: ArrowRight,
  client_approved: CheckCircle2,
  client_rejected: X,
  assignment_change: StickyNote,
  cost_agreed: StickyNote,
  note_added: StickyNote,
  publisher_assigned: Link2,
  archived: Clock,
  restored: Clock,
};

/**
 * DETAIL DRAWER.
 *
 * History is fetched separately from the placement so opening a card is one fast
 * request plus a slower one, rather than blocking the panel on both.
 */
export function PlacementDrawer({
  placementId,
  open,
  onOpenChange,
  onMoveRequest,
}: {
  placementId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onMoveRequest: (p: BoardPlacement) => void;
}) {
  const [detail, setDetail] = useState<PlacementDetail | null>(null);
  const [history, setHistory] = useState<PlacementEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useAccessToken();

  useEffect(() => {
    if (!open || !placementId || !token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const { getPlacement } = await import("./use-placements");
        const [d, h] = await Promise.all([
          getPlacement(placementId, token),
          getPlacementHistory(placementId, token),
        ]);
        if (cancelled) return;
        setDetail(d);
        setHistory(h);
      } catch (err) {
        if (!cancelled) setError((err as ApiError).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, placementId, token]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-line bg-surface shadow-2xl focus:outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-[15px] font-semibold text-foreground">
                {detail ? shortUrl(detail.target_url) : "Placement"}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-muted">
                {detail ? humanize(detail.pipeline_stage) : "Loading"}
                {detail?.campaign?.name ? ` · ${detail.campaign.name}` : ""}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {loading && (
              <div className="flex items-center gap-2 text-[12.5px] text-muted">
                <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
              </div>
            )}

            {error && (
              <p role="alert" className="text-[12.5px] text-[var(--color-danger)]">
                {error}
              </p>
            )}

            {detail && (
              <>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  <Badge tone="brand">{humanize(detail.pipeline_stage)}</Badge>
                  <Badge tone={detail.status === "live" ? "success" : "neutral"}>{humanize(detail.status)}</Badge>
                  {detail.agreed_cost != null && (
                    <Badge tone="neutral">{money(detail.agreed_cost)} negotiated</Badge>
                  )}
                </div>

                <dl className="mb-5 space-y-2.5 text-[12.5px]">
                  <Row label="Target URL">
                    <a
                      href={detail.target_url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex max-w-full items-start gap-1 text-brand-600 hover:underline"
                    >
                      <span className="min-w-0 break-all">{detail.target_url}</span>
                      <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden />
                    </a>
                  </Row>
                  {detail.live_url && (
                    <Row label="Live URL">
                      <a
                        href={detail.live_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex max-w-full items-start gap-1 text-brand-600 hover:underline"
                      >
                        <span className="min-w-0 break-all">{detail.live_url}</span>
                        <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden />
                      </a>
                    </Row>
                  )}
                  {detail.anchor_text && <Row label="Anchor">{detail.anchor_text}</Row>}
                  {detail.anchor_type && <Row label="Anchor type">{humanize(detail.anchor_type)}</Row>}
                  {detail.publisher?.domain && (
                    <Row label="Publisher">
                      {detail.publisher.domain}
                      {detail.publisher.dr != null ? ` · DR ${detail.publisher.dr}` : ""}
                    </Row>
                  )}
                  {detail.assignee?.full_name && <Row label="Assigned to">{detail.assignee.full_name}</Row>}
                  {detail.content_due_date && (
                    <Row label="Content due">{new Date(detail.content_due_date).toLocaleDateString()}</Row>
                  )}
                  {detail.client_approved_at && (
                    <Row label="Client approved">{formatRelative(detail.client_approved_at)}</Row>
                  )}
                </dl>

                {detail.client_approval_note && (
                  <Note tone="success" title="Client approval note">
                    {detail.client_approval_note}
                  </Note>
                )}
                {detail.client_rejected_reason && (
                  <Note tone="danger" title="Client rejected">
                    {detail.client_rejected_reason}
                  </Note>
                )}
                {detail.internal_notes && (
                  <Note tone="neutral" title="Internal note">
                    {detail.internal_notes}
                  </Note>
                )}
                {detail.notes && (
                  <Note tone="neutral" title="Client-facing note">
                    {detail.notes}
                  </Note>
                )}

                <div className="mt-6">
                  <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">History</h3>
                  {history.length === 0 ? (
                    <p className="text-[12px] text-muted">No events recorded yet.</p>
                  ) : (
                    <ol className="space-y-3">
                      {history.map((e) => {
                        const Icon = EVENT_ICON[e.event_type] ?? Clock;
                        return (
                          <li key={e.id} className="flex gap-2.5">
                            <span
                              className={cn(
                                "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-muted",
                                e.event_type === "client_approved" && "bg-[var(--color-success-soft)] text-[var(--color-success)]",
                                e.event_type === "client_rejected" && "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
                              )}
                            >
                              <Icon className="size-3" aria-hidden />
                            </span>
                            <div className="min-w-0">
                              <p className="text-[12.5px] text-foreground-soft">
                                {e.summary ?? humanize(e.event_type)}
                              </p>
                              <p className="text-[11px] text-muted">
                                {e.actor_name ? `${e.actor_name} · ` : ""}
                                {formatRelative(e.created_at)}
                                {e.from_stage && e.to_stage && e.from_stage !== e.to_stage
                                  ? ` · ${humanize(e.from_stage)} → ${humanize(e.to_stage)}`
                                  : ""}
                              </p>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </div>
              </>
            )}
          </div>

          {detail && (
            <div className="border-t border-line px-5 py-3">
              <Button
                size="sm"
                className="w-full"
                onClick={() => {
                  onOpenChange(false);
                  onMoveRequest(detail as unknown as BoardPlacement);
                }}
              >
                <ArrowRight />
                Move to another stage
              </Button>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-foreground-soft">{children}</dd>
    </div>
  );
}

function Note({ tone, title, children }: { tone: "success" | "danger" | "neutral"; title: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "mb-2 rounded-lg border px-3 py-2",
        tone === "success" && "border-[var(--color-success)]/30 bg-[var(--color-success-soft)]/50",
        tone === "danger" && "border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50",
        tone === "neutral" && "border-line bg-surface-sunken",
      )}
    >
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">{title}</p>
      <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground-soft">{children}</p>
    </div>
  );
}
