import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CircleCheck,
  Clock,
  MessageSquare,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/card";
import { formatRelative } from "@/lib/utils";
import { PortalPageHeading } from "./portal-shell";
import {
  PORTAL_DRAFT_STATUS,
  portalErrorMessage,
  usePortalDraftActions,
  usePortalDrafts,
  type PortalDraft,
} from "./use-portal";

/**
 * DRAFT REVIEW.
 *
 * The client's two options are approve and request changes. There is no edit
 * affordance anywhere, deliberately: `body_md` is not writable from this surface,
 * the route does not exist, and the API would refuse. Showing an editable field that
 * silently fails on save would be worse than not offering one.
 *
 * The body is rendered as pre-wrapped text. It is the agency's markdown, and running
 * it through a renderer here would be an XSS surface on the one screen a client
 * definitely reads.
 */
export function PortalDraftDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const drafts = usePortalDrafts();
  const actions = usePortalDraftActions();

  const [revisionOpen, setRevisionOpen] = useState(false);
  const [note, setNote] = useState("");
  const [approvalNote, setApprovalNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const draft: PortalDraft | undefined = (drafts.data ?? []).find((d) => d.id === id);

  if (drafts.isLoading) {
    return (
      <>
        <PortalPageHeading title="Article" />
        <Card>
          <CardContent className="space-y-3 p-5">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-64 w-full" />
          </CardContent>
        </Card>
      </>
    );
  }

  if (drafts.isError) {
    return (
      <>
        <PortalPageHeading title="Article" />
        <ErrorState description={portalErrorMessage(drafts.error)} onRetry={() => void drafts.refetch()} />
      </>
    );
  }

  // Not in the list means it is not this client's draft, or not in a state they may
  // see — the endpoint already filtered. Say so without distinguishing the two.
  if (!draft) {
    return (
      <>
        <PortalPageHeading title="Article" />
        <EmptyState
          icon={AlertCircle}
          title="Article not available"
          description="This article is not awaiting your review, or it does not belong to your organisation."
          action={
            <Button variant="secondary" size="sm" onClick={() => navigate("/portal/drafts")}>
              Back to content
            </Button>
          }
        />
      </>
    );
  }

  const meta = PORTAL_DRAFT_STATUS[draft.status] ?? { label: draft.status, tone: "neutral" as const };
  const canReview = draft.status === "in_review";

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      await actions.approve.mutateAsync({ draftId: draft.id, note: approvalNote || undefined });
      setDone("Approved. Thank you — we will publish it shortly.");
    } catch (err) {
      setError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const requestRevision = async () => {
    setBusy(true);
    setError(null);
    try {
      await actions.requestRevision.mutateAsync({ draftId: draft.id, note });
      setRevisionOpen(false);
      setDone("Changes requested. Your account manager has been notified.");
    } catch (err) {
      setError(portalErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Link
        to="/portal/drafts"
        className="mb-3 inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        Back to content
      </Link>

      <PortalPageHeading
        title={draft.title ?? "Untitled article"}
        description={`${draft.word_count} words · version ${draft.current_version ?? 1}`}
        actions={<Badge tone={meta.tone}>{meta.label}</Badge>}
      />

      {done && (
        <div
          role="status"
          className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success-soft)]/50 px-3 py-2.5 text-[12.5px] text-[var(--color-success)]"
        >
          <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{done}</p>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50 px-3 py-2.5 text-[12.5px] text-[var(--color-danger)]"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{error}</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
        {/* The article itself. */}
        <Card>
          <CardContent className="p-0">
            <div className="border-b border-line px-5 py-3">
              <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Article</h2>
            </div>
            <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
              <DraftBody text={draft.body_md} />
            </div>
          </CardContent>
        </Card>

        {/* Status, history and the actions. */}
        <div className="space-y-3">
          <Card>
            <CardContent className="p-4">
              <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide text-muted">Status</h2>
              <ol className="space-y-2.5">
                <TimelineItem
                  icon={Clock}
                  label="Submitted for review"
                  value={draft.submitted_at ? formatRelative(draft.submitted_at) : "—"}
                  done={Boolean(draft.submitted_at)}
                />
                <TimelineItem
                  icon={Check}
                  label="Approved"
                  value={draft.approved_at ? formatRelative(draft.approved_at) : "Not yet"}
                  done={Boolean(draft.approved_at)}
                />
              </ol>

              {draft.client_approval_note && (
                <div className="mt-3 rounded-lg border border-line bg-surface-sunken px-3 py-2">
                  <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Your note</p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[12px] text-foreground-soft">
                    {draft.client_approval_note}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>

          {canReview && !done && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Your decision</h2>

                <Field label="Approval note" hint="Optional — visible to your account manager.">
                  <textarea
                    value={approvalNote}
                    onChange={(e) => setApprovalNote(e.target.value)}
                    rows={2}
                    placeholder="Looks good, ship it."
                    className="w-full rounded-md border border-line bg-surface p-2 text-[12.5px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                  />
                </Field>

                <Button size="sm" className="w-full" loading={busy} onClick={() => void approve()}>
                  <Check />
                  Approve article
                </Button>

                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  disabled={busy}
                  onClick={() => setRevisionOpen(true)}
                >
                  <MessageSquare />
                  Request changes
                </Button>
              </CardContent>
            </Card>
          )}

          {!canReview && (
            <Card>
              <CardContent className="p-4">
                <p className="text-[12px] leading-relaxed text-muted">
                  {draft.status === "approved"
                    ? "You have approved this article. It will be published on the agreed schedule."
                    : "This article has been published."}
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <RevisionDialog
        open={revisionOpen}
        onOpenChange={setRevisionOpen}
        value={note}
        onChange={setNote}
        busy={busy}
        onSubmit={requestRevision}
      />
    </>
  );
}

/**
 * Render the draft body.
 *
 * The stored text is markdown. A client is reading this to decide whether to
 * approve it, and raw `##` and `-` markers make that harder. This handles the two
 * constructs an article actually uses — headings and paragraphs — and deliberately
 * does NOT run a markdown parser or `dangerouslySetInnerHTML`: the body is
 * agency-authored text rendered on a customer's screen, so the safe default is to
 * never interpret it as HTML. Inline emphasis and links appear as literal text,
 * which is a cosmetic loss rather than an injection surface.
 */
function DraftBody({ text }: { text: string }) {
  if (!text.trim()) {
    return <p className="text-[13px] text-muted">This draft has no text yet.</p>;
  }

  const blocks = text.split(/\n{2,}/);

  return (
    <div className="space-y-3">
      {blocks.map((block, i) => {
        const trimmed = block.trim();
        if (!trimmed) return null;

        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (heading) {
          const level = (heading[1] ?? "#").length;
          return (
            <p
              key={i}
              className={
                level <= 2
                  ? "text-[15px] font-semibold text-foreground"
                  : "text-[13.5px] font-semibold text-foreground-soft"
              }
            >
              {heading[2]}
            </p>
          );
        }

        // A run of list items stays grouped as a list.
        if (/^[-*]\s+/m.test(trimmed)) {
          const items = trimmed.split("\n").filter((l) => /^[-*]\s+/.test(l.trim()));
          return (
            <ul key={i} className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-foreground-soft">
              {items.map((item, j) => (
                <li key={j}>{item.replace(/^[-*]\s+/, "")}</li>
              ))}
            </ul>
          );
        }

        return (
          <p key={i} className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground-soft">
            {trimmed}
          </p>
        );
      })}
    </div>
  );
}

function TimelineItem({
  icon: Icon,
  label,
  value,
  done,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  done: boolean;
}) {
  return (
    <li className="flex items-start gap-2">
      <span
        className={
          done
            ? "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-success-soft)] text-[var(--color-success)]"
            : "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-muted"
        }
      >
        <Icon className="size-3" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-medium text-foreground-soft">{label}</p>
        <p className="text-[11px] text-muted">{value}</p>
      </div>
    </li>
  );
}

function RevisionDialog({
  open,
  onOpenChange,
  value,
  onChange,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onSubmit: () => Promise<void>;
}) {
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
            Tell us what to change. This goes to the writer, so be specific — "needs work"
            is not something they can act on.
          </Dialog.Description>

          <Field label="What needs to change?">
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              rows={4}
              placeholder="The intro needs a statistic, and the second section drifts off topic."
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
              // The server enforces a minimum length too; disabling here saves a
              // pointless round trip.
              disabled={value.trim().length < 3}
              onClick={() => void onSubmit()}
            >
              Send request
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
