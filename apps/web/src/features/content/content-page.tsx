import { useEffect, useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  Check,
  FileText,
  History,
  Loader2,
  MessageSquare,
  PenLine,
  Send,
  Undo2,
  X,
} from "lucide-react";
import { useAuth } from "@/providers/auth";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { PageHeading } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/states";
import { cn, formatRelative, humanize } from "@/lib/utils";
import {
  DRAFT_STATUS_META,
  draftErrorMessage,
  useBriefs,
  useContentActions,
  useContentSummary,
  useDraft,
  type Brief,
  type Draft,
} from "./use-content";

/**
 * CONTENT MANAGEMENT.
 *
 * Two panes: the queue (what needs doing) and the editor (the draft itself).
 *
 * The editor is deliberately simple — a textarea and a save button that creates a
 * version. A rich-text editor would add a large dependency and a class of
 * paste-handling bugs for content whose destination is a publisher's CMS, which
 * will re-format it anyway. The briefs here are for writers, not typesetters.
 */
export function ContentPage() {
  const { can } = useAuth();
  const summary = useContentSummary();
  const briefs = useBriefs({ mine: !can("briefs:approve") });

  const [selectedBrief, setSelectedBrief] = useState<Brief | null>(null);

  const canApprove = can("briefs:approve");
  const canWrite = can("briefs:write");

  const rows = briefs.data ?? [];

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Content"
          description="Writing assignments, drafts and approvals. Every save keeps a version."
          actions={
            summary.data && (
              // Wraps: three badges plus a heading will not fit at 390px, and a
              // non-wrapping row is what pushed the page wider than the viewport.
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted">
                <Badge tone="warning">{summary.data.byStatus.revision_requested ?? 0} revisions</Badge>
                <Badge tone="info">{summary.data.byStatus.in_review ?? 0} in review</Badge>
                <Badge tone="success">{summary.data.byStatus.approved ?? 0} approved</Badge>
              </div>
            )
          }
        />

        {briefs.isLoading ? (
          <TableSkeleton rows={5} cols={3} />
        ) : briefs.isError ? (
          <ErrorState description={draftErrorMessage(briefs.error)} onRetry={() => void briefs.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={FileText}
            title="Nothing assigned"
            description={
              canWrite && !canApprove
                ? "When an account manager assigns you a brief it appears here."
                : "Create a brief from a placement to start the writing workflow."
            }
          />
        ) : (
          <div className="grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
            <div className="min-w-0 space-y-2">
              {rows.map((brief) => (
                <BriefRow
                  key={brief.id}
                  brief={brief}
                  active={selectedBrief?.id === brief.id}
                  onClick={() => setSelectedBrief(brief)}
                />
              ))}
            </div>

            <div className="min-w-0">
              {selectedBrief ? (
                <DraftPanel briefId={selectedBrief.id} canWrite={canWrite} canApprove={canApprove} />
              ) : (
                <div className="flex h-full min-h-[280px] items-center justify-center rounded-xl border border-dashed border-line px-6 text-center">
                  <p className="max-w-xs text-[13px] text-muted">
                    Select a brief to open its draft, read its version history and move it through review.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </PageStack>
    </PageContainer>
  );
}

function BriefRow({ brief, active, onClick }: { brief: Brief; active: boolean; onClick: () => void }) {
  const status = DRAFT_STATUS_META[brief.draft?.status ?? brief.status] ?? {
    label: humanize(brief.status),
    tone: "neutral" as const,
  };
  const due = brief.due_date ? new Date(brief.due_date) : null;
  const overdue = due && due.getTime() < Date.now() && status.tone !== "success" && status.tone !== "brand";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full min-w-0 rounded-lg border px-3 py-2.5 text-left transition",
        active
          ? "border-brand-400 bg-brand-50/60 dark:bg-brand-900/20"
          : "border-line bg-surface hover:border-line-strong hover:bg-surface-sunken/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-[13px] font-medium text-foreground">
          {brief.draft?.title ?? brief.brief?.slice(0, 60) ?? "Untitled brief"}
        </p>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-muted">
        {due && (
          <span className={cn(overdue && "font-medium text-[var(--color-danger)]")}>
            due {due.toLocaleDateString()}
          </span>
        )}
        {brief.draft && <span>{brief.draft.word_count} words</span>}
        {!brief.draft && <span>no draft yet</span>}
      </p>
    </button>
  );
}

function DraftPanel({ briefId, canWrite, canApprove }: { briefId: string; canWrite: boolean; canApprove: boolean }) {
  // The brief endpoint returns its draft; the draft endpoint returns versions and
  // revisions. Fetching the draft directly is one call and gives everything.
  const briefs = useBriefs();
  const brief = (briefs.data ?? []).find((b) => b.id === briefId) ?? null;
  const draftQuery = useDraft(brief?.draft?.id ?? null);
  const draft = draftQuery.data ?? null;

  const actions = useContentActions();
  const [body, setBody] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [pending, setPending] = useState(false);

  // Sync the editor with the server's text.
  //
  // Keyed on the draft's version, not just its body: after a save the mutation
  // refetches and `current_version` changes, which re-runs this and adopts the
  // saved text. Keying on `draft` alone meant a refetch that returned the same
  // object identity never reached the textarea, and `!dirty` suppressed the update
  // right when it was needed — the editor kept showing pre-save text after saving.
  useEffect(() => {
    if (!draft) return;
    setBody((current) => (current === draft.body_md ? current : draft.body_md));
  }, [draft?.id, draft?.current_version, draft?.body_md]);

  // Reset everything when a different brief is opened. Separate effect so a
  // refetch of the SAME draft does not wipe what is being typed.
  useEffect(() => {
    setDirty(false);
    setBody("");
    setShowHistory(false);
  }, [briefId]);

  const openRevision = draft?.revisions?.find((r) => r.status === "open");

  const run = async (fn: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(draftErrorMessage(err));
    } finally {
      setPending(false);
    }
  };

  if (!brief) {
    return <div className="rounded-xl border border-line bg-surface p-6 text-[13px] text-muted">Loading brief…</div>;
  }

  // No draft yet: offer to start one.
  if (!brief.draft) {
    return (
      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="text-[14px] font-semibold text-foreground">No draft yet</h2>
          <p className="text-[12.5px] text-muted">
            {brief.brief ?? "This brief has no instructions yet."}
          </p>
          {canWrite ? (
            <Button
              size="sm"
              loading={pending}
              onClick={() =>
                void run(() => actions.createDraft.mutateAsync({ briefId: brief.id, bodyMd: "" }))
              }
            >
              <PenLine />
              Start draft
            </Button>
          ) : (
            <p className="text-[12.5px] text-muted">A writer will pick this up.</p>
          )}
          {error && <ErrorLine message={error} />}
        </CardContent>
      </Card>
    );
  }

  const status = DRAFT_STATUS_META[draft?.status ?? brief.draft.status] ?? { label: "Unknown", tone: "neutral" as const };
  const readOnly = !canWrite || draft?.status === "published";

  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-foreground">
              {draft?.title ?? brief.draft.title ?? "Untitled draft"}
            </h2>
            <p className="mt-0.5 text-[12px] text-muted">
              <Badge tone={status.tone}>{status.label}</Badge>
              <span className="ml-2 tabular-nums">
                v{draft?.current_version ?? 1} · {draft?.word_count ?? brief.draft.word_count} words
              </span>
            </p>
          </div>

          <Button variant="ghost" size="sm" onClick={() => setShowHistory((v) => !v)}>
            <History />
            {showHistory ? "Hide history" : "History"}
          </Button>
        </div>

        {openRevision && (
          <div className="rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning-soft)]/60 px-3 py-2">
            <p className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-[var(--color-warning)]">
              <MessageSquare className="size-3" aria-hidden />
              Revision requested
            </p>
            <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-foreground-soft">{openRevision.notes}</p>
          </div>
        )}

        {showHistory && draft && (
          <div className="rounded-lg border border-line bg-surface-sunken/50 p-3">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Versions</p>
            <ul className="space-y-1">
              {draft.versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between gap-2 text-[12px]">
                  <span className="text-foreground-soft">
                    v{v.version}
                    <span className="ml-1.5 text-muted">
                      {v.word_count} words · {humanize(v.reason)} · {formatRelative(v.created_at)}
                    </span>
                  </span>
                  {v.version !== draft.current_version && canWrite && draft.status !== "published" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={pending}
                      onClick={() => void run(() => actions.restoreVersion.mutateAsync({ draftId: draft.id, version: v.version }))}
                    >
                      <Undo2 />
                      Restore
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {draftQuery.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-[12.5px] text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading draft…
          </div>
        ) : (
          <>
            <label className="block">
              <span className="sr-only">Draft body</span>
              <textarea
                value={body}
                onChange={(e) => {
                  setBody(e.target.value);
                  setDirty(true);
                }}
                readOnly={readOnly}
                rows={14}
                spellCheck
                placeholder="Write the article here…"
                className={cn(
                  "w-full resize-y rounded-lg border border-line bg-surface p-3 font-mono text-[12.5px] leading-relaxed text-foreground",
                  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
                  readOnly && "bg-surface-sunken text-muted",
                )}
              />
            </label>

            {error && <ErrorLine message={error} />}

            <div className="flex flex-wrap items-center gap-2">
              {!readOnly && (
                <Button
                  size="sm"
                  variant={dirty ? "primary" : "secondary"}
                  loading={pending}
                  disabled={!dirty}
                  onClick={() =>
                    void run(async () => {
                      await actions.saveVersion.mutateAsync({ draftId: draft!.id, bodyMd: body });
                      setDirty(false);
                    })
                  }
                >
                  <Check />
                  Save version
                </Button>
              )}

              {draft?.status === "draft" && canWrite && (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={pending}
                  onClick={() =>
                    void run(() => actions.transition.mutateAsync({ draftId: draft.id, status: "in_review" }))
                  }
                >
                  <Send />
                  Submit for review
                </Button>
              )}

              {draft?.status === "in_review" && canApprove && (
                <>
                  <Button
                    size="sm"
                    loading={pending}
                    onClick={() =>
                      void run(() => actions.transition.mutateAsync({ draftId: draft.id, status: "approved" }))
                    }
                  >
                    <Check />
                    Approve
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setRevisionOpen(true)}>
                    <MessageSquare />
                    Request changes
                  </Button>
                </>
              )}

              {draft?.status === "approved" && canApprove && (
                <Button
                  size="sm"
                  loading={pending}
                  onClick={() =>
                    void run(() => actions.transition.mutateAsync({ draftId: draft.id, status: "published" }))
                  }
                >
                  <Check />
                  Mark published
                </Button>
              )}

              {draft?.status === "published" && <Badge tone="brand">Published — read only</Badge>}
            </div>

            {draft?.status === "revision_requested" && (
              <p className="text-[12px] text-[var(--color-warning)]">
                Waiting on a revision. Saving a version returns it to review.
              </p>
            )}
          </>
        )}
      </CardContent>

      <RevisionDialog
        open={revisionOpen}
        onOpenChange={setRevisionOpen}
        onSubmit={async (notes) => {
          if (!draft) return;
          await run(() => actions.transition.mutateAsync({ draftId: draft.id, status: "revision_requested", notes }));
          setRevisionOpen(false);
        }}
      />
    </Card>
  );
}

function RevisionDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSubmit: (notes: string) => Promise<void>;
}) {
  const [notes, setNotes] = useState("");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <div className="mb-1 flex items-start justify-between">
            <Dialog.Title className="text-[15px] font-semibold text-foreground">Request changes</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>
          <Dialog.Description className="mb-3 text-[12.5px] text-muted">
            The writer sees this. Be specific — "make it better" is not actionable.
          </Dialog.Description>

          <Field label="What needs to change?">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              className="w-full rounded-md border border-line bg-surface p-2.5 text-[12.5px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
              placeholder="The intro needs a statistic, and the anchor should read 'saas analytics'."
            />
          </Field>

          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={notes.trim().length < 3} onClick={() => void onSubmit(notes)}>
              Send request
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[12.5px] text-[var(--color-danger)]">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      {message}
    </p>
  );
}
