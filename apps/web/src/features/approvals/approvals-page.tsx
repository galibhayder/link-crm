import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, Check, ExternalLink, FileText, Globe2, Link2, MessageSquare, ThumbsDown, Users, X } from "lucide-react";
import { useAuth } from "@/providers/auth";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { PageHeading } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/states";
import { cn, formatRelative, humanize } from "@/lib/utils";
import {
  approvalErrorMessage,
  useApprovalActions,
  useDraftApprovals,
  usePlacementApprovals,
  useProspectReviews,
  usePublisherReviews,
} from "./use-approvals";

/**
 * APPROVAL QUEUE.
 *
 * One screen, four tabs — the account manager's question is "what needs my decision
 * today", not "let me browse placements". Each tab maps to an existing endpoint and
 * each action uses the endpoint that role is actually permitted to call.
 *
 * A REJECTION IS NOT A STAGE MOVE. Rejecting a placement uses `client-decision`,
 * which records who decided and why; it does not skip the pipeline. The same is true
 * of a draft: "request changes" is a transition to `revision_requested` with a note,
 * not a silent status write.
 */

type TabKey = "placements" | "content" | "prospects" | "publishers";

export function ApprovalsPage() {
  const [tab, setTab] = useState<TabKey>("placements");
  const [decision, setDecision] = useState<{ kind: "placement" | "draft"; id: string; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const placements = usePlacementApprovals();
  const drafts = useDraftApprovals();
  const prospects = useProspectReviews();
  const publishers = usePublisherReviews();
  const actions = useApprovalActions();

  const counts = {
    placements: placements.data?.length ?? 0,
    content: drafts.data?.length ?? 0,
    prospects: prospects.data?.length ?? 0,
    publishers: publishers.data?.length ?? 0,
  };

  const total = counts.placements + counts.content;

  const TABS: Array<{ key: TabKey; label: string; icon: typeof Link2; count: number }> = [
    { key: "placements", label: "Placements", icon: Link2, count: counts.placements },
    { key: "content", label: "Content", icon: FileText, count: counts.content },
    { key: "prospects", label: "Prospects", icon: Users, count: counts.prospects },
    { key: "publishers", label: "Publishers", icon: Globe2, count: counts.publishers },
  ];

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Approvals"
          description="What needs your decision. Approving here records who decided and why, in the existing history for each record."
          actions={
            <Badge tone={total > 0 ? "warning" : "success"}>
              {total} awaiting you
            </Badge>
          }
        />

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-danger)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Approval type">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12.5px] font-medium transition",
                tab === t.key
                  ? "border-brand-400 bg-brand-600/10 text-brand-700 dark:text-brand-300"
                  : "border-line bg-surface text-muted hover:text-foreground",
              )}
            >
              <t.icon className="size-3.5" aria-hidden />
              {t.label}
              <span className="tabular-nums opacity-70">{t.count}</span>
            </button>
          ))}
        </div>

        {tab === "placements" && (
          <Section
            loading={placements.isLoading}
            error={placements.isError ? approvalErrorMessage(placements.error) : null}
            onRetry={() => void placements.refetch()}
            empty={
              <EmptyState
                icon={Link2}
                title="No placements waiting"
                description="Placements appear here once they reach the pitched stage and need a client decision."
              />
            }
            rows={placements.data ?? []}
            render={(rows) => (
              <ul className="divide-y divide-line">
                {rows.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground" title={p.target_url}>
                        {p.target_url}
                      </p>
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        {p.anchor_text ? `“${p.anchor_text}”` : "no anchor yet"}
                        {p.anchor_type ? ` · ${humanize(p.anchor_type)}` : ""}
                        {` · waiting ${formatRelative(p.updated_at)}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge tone="neutral">{humanize(p.pipeline_stage)}</Badge>
                      <Button
                        size="sm"
                        onClick={() => setDecision({ kind: "placement", id: p.id, label: p.target_url })}
                      >
                        <Check />
                        Decide
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          />
        )}

        {tab === "content" && (
          <Section
            loading={drafts.isLoading}
            error={drafts.isError ? approvalErrorMessage(drafts.error) : null}
            onRetry={() => void drafts.refetch()}
            empty={
              <EmptyState
                icon={FileText}
                title="No drafts waiting"
                description="Drafts appear here when a writer submits them for review."
              />
            }
            rows={drafts.data ?? []}
            render={(rows) => (
              <ul className="divide-y divide-line">
                {rows.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">
                        {d.title ?? "Untitled article"}
                      </p>
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        {d.word_count} words
                        {d.submitted_at ? ` · submitted ${formatRelative(d.submitted_at)}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        onClick={() => setDecision({ kind: "draft", id: d.id, label: d.title ?? "Untitled article" })}
                      >
                        <Check />
                        Review
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          />
        )}

        {tab === "prospects" && (
          <Section
            loading={prospects.isLoading}
            error={prospects.isError ? approvalErrorMessage(prospects.error) : null}
            onRetry={() => void prospects.refetch()}
            empty={
              <EmptyState
                icon={Users}
                title="No high-priority prospects"
                description="Prospects flagged high priority by the research team appear here."
              />
            }
            rows={prospects.data ?? []}
            render={(rows) => (
              <ul className="divide-y divide-line">
                {rows.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">{p.domain}</p>
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        {humanize(p.stage)}
                        {p.dr != null ? ` · DR ${p.dr}` : ""}
                        {p.price != null ? ` · $${p.price}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={actions.setProspectStage.isPending}
                        onClick={() =>
                          void actions.setProspectStage
                            .mutateAsync({ prospectId: p.id, stage: "pitched" })
                            .catch((err) => setError(approvalErrorMessage(err)))
                        }
                      >
                        Advance to pitched
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          />
        )}

        {tab === "publishers" && (
          <Section
            loading={publishers.isLoading}
            error={publishers.isError ? approvalErrorMessage(publishers.error) : null}
            onRetry={() => void publishers.refetch()}
            empty={
              <EmptyState
                icon={Globe2}
                title="No active publishers"
                description="Active publishers awaiting review appear here."
              />
            }
            rows={publishers.data ?? []}
            render={(rows) => (
              <ul className="divide-y divide-line">
                {rows.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-medium text-foreground">{p.domain}</p>
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        {p.dr != null ? `DR ${p.dr}` : "DR —"}
                        {p.monthly_traffic != null ? ` · ${p.monthly_traffic.toLocaleString()} traffic` : ""}
                        {p.spam_score != null ? ` · spam ${p.spam_score}` : ""}
                        {p.niche?.length ? ` · ${p.niche.join(", ")}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={actions.setPublisherStatus.isPending}
                        onClick={() =>
                          void actions.setPublisherStatus
                            .mutateAsync({ publisherId: p.id, status: "paused" })
                            .catch((err) => setError(approvalErrorMessage(err)))
                        }
                      >
                        Pause
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-[var(--color-danger)]"
                        loading={actions.setPublisherStatus.isPending}
                        onClick={() =>
                          void actions.setPublisherStatus
                            .mutateAsync({ publisherId: p.id, status: "blacklisted" })
                            .catch((err) => setError(approvalErrorMessage(err)))
                        }
                      >
                        <ThumbsDown />
                        Blacklist
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          />
        )}
      </PageStack>

      <DecisionDialog
        target={decision}
        onOpenChange={(v) => !v && setDecision(null)}
        onPlacement={async (id, decision, note) => {
          await actions.decidePlacement.mutateAsync({ placementId: id, decision, note });
        }}
        onDraft={async (id, status, notes) => {
          await actions.transitionDraft.mutateAsync({ draftId: id, status, notes });
        }}
        onError={setError}
      />
    </PageContainer>
  );
}

/** Loading / error / empty / rows, so each tab does not repeat the four states. */
function Section<T>({
  loading,
  error,
  onRetry,
  empty,
  rows,
  render,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  empty: React.ReactNode;
  rows: T[];
  render: (rows: T[]) => React.ReactNode;
}) {
  if (loading) return <TableSkeleton rows={4} cols={3} />;
  if (error) return <ErrorState description={error} onRetry={onRetry} />;
  if (rows.length === 0) return <>{empty}</>;
  return <Card><CardContent className="p-0">{render(rows)}</CardContent></Card>;
}

/**
 * One dialog for both decision types.
 *
 * Approve and reject are mutually exclusive here rather than two buttons on the row,
 * because a rejection REQUIRES a reason — putting it behind a dialog is what makes
 * that requirement obvious instead of an error message after the fact.
 */
function DecisionDialog({
  target,
  onOpenChange,
  onPlacement,
  onDraft,
  onError,
}: {
  target: { kind: "placement" | "draft"; id: string; label: string } | null;
  onOpenChange: (v: boolean) => void;
  onPlacement: (id: string, decision: "approve" | "reject", note: string) => Promise<void>;
  onDraft: (id: string, status: "approved" | "revision_requested", notes?: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [mode, setMode] = useState<"approve" | "reject">("approve");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const needsNote = mode === "reject" || target?.kind === "draft";

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      if (target.kind === "placement") {
        await onPlacement(target.id, mode, note);
      } else {
        await onDraft(target.id, mode === "approve" ? "approved" : "revision_requested", note || undefined);
      }
      onOpenChange(false);
      setNote("");
      setMode("approve");
    } catch (err) {
      onError(approvalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={Boolean(target)} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <div className="mb-1 flex items-start justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-foreground">
              {target?.kind === "draft" ? "Review draft" : "Client decision"}
            </Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-4 truncate text-[12.5px] text-muted">
            {target?.label}
          </Dialog.Description>

          <div className="mb-3 grid grid-cols-2 gap-2">
            <Button
              variant={mode === "approve" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setMode("approve")}
            >
              <Check />
              {target?.kind === "draft" ? "Approve" : "Client approved"}
            </Button>
            <Button
              variant={mode === "reject" ? "danger" : "secondary"}
              size="sm"
              onClick={() => setMode("reject")}
            >
              <MessageSquare />
              {target?.kind === "draft" ? "Request changes" : "Client rejected"}
            </Button>
          </div>

          <Field
            label={needsNote ? "Reason (required)" : "Note (optional)"}
            hint={
              mode === "reject"
                ? "Recorded on the placement, so nobody has to guess later."
                : target?.kind === "draft"
                  ? "The writer sees this."
                  : "Who decided, and when."
            }
          >
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-line bg-surface p-2.5 text-[12.5px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            />
          </Field>

          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              loading={busy}
              disabled={needsNote && note.trim().length < 3}
              onClick={() => void submit()}
            >
              Confirm
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
