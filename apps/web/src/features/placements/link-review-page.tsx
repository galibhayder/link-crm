import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Check, ExternalLink, ScanSearch, X } from "lucide-react";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, PageHeading } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/states";
import { formatRelative } from "@/lib/utils";
import {
  reviewErrorMessage,
  reviewExplain,
  useResolveReview,
  useReviewQueue,
  type ReviewItem,
  type ReviewResolution,
} from "./use-link-reviews";

/**
 * LINK REVIEWS.
 *
 * The job of this page is one question, answered once per row: open the URL and
 * say whether the link is there. Everything else — how the verdict was reached,
 * which heuristic fired, what the check row contains — is context for that
 * decision and belongs behind it, not in front.
 *
 * WHY THIS PAGE EXISTS: `needs_manual_review` replaced a false `link_missing`. A
 * client-rendered page returns a shell, so "no anchor in the HTML" was never
 * evidence that the link was gone — only that it could not be read. Flagging it
 * honestly is worth nothing if nobody can clear the flag.
 */
export function LinkReviewPage() {
  const queue = useReviewQueue();
  const resolve = useResolveReview();

  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{ item: ReviewItem; resolution: ReviewResolution } | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rows = queue.data ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.client_name.toLowerCase().includes(q) ||
        r.campaign_name.toLowerCase().includes(q) ||
        (r.live_url ?? "").toLowerCase().includes(q) ||
        (r.anchor_text ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  function open(item: ReviewItem, resolution: ReviewResolution) {
    setError(null);
    setNote("");
    setPending({ item, resolution });
  }

  async function confirm() {
    if (!pending) return;
    setError(null);
    try {
      await resolve.mutateAsync({
        placementId: pending.item.placement_id,
        checkId: pending.item.check_id,
        resolution: pending.resolution,
        note: note.trim() || undefined,
      });
      setPending(null);
      setNote("");
    } catch (err) {
      // Kept in the dialog: closing it would throw away the reviewer's note.
      setError(reviewErrorMessage(err));
    }
  }

  const isMissing = pending?.resolution === "missing";

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Link reviews"
          description="Pages that could not be verified automatically. Open the link, confirm it is there, and clear it."
        />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1 sm:max-w-xs">
            <ScanSearch
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search client, campaign or URL…"
              className="pl-8"
              aria-label="Search link reviews"
            />
          </div>
          <p className="text-[12px] tabular-nums text-muted sm:ml-auto" aria-live="polite">
            {filtered.length} awaiting review
          </p>
        </div>

        {queue.isLoading ? (
          <TableSkeleton rows={5} cols={4} />
        ) : queue.isError ? (
          <ErrorState
            title="Couldn't load the review queue"
            description={reviewErrorMessage(queue.error)}
            onRetry={() => void queue.refetch()}
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Check}
            title={rows.length === 0 ? "Nothing needs review" : "Nothing matches that search"}
            description={
              rows.length === 0
                ? "Every link could be verified automatically. Pages that need a human eye appear here after a scheduled check."
                : "Try a different client, campaign or URL."
            }
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-[12.5px]">
                  <thead className="border-b border-line bg-surface-sunken/60">
                    <tr className="text-[11px] uppercase tracking-wide text-muted">
                      <th className="px-4 py-2 font-medium">Client / campaign</th>
                      <th className="px-4 py-2 font-medium">Page to check</th>
                      <th className="px-4 py-2 font-medium">Why</th>
                      <th className="px-4 py-2 font-medium">Waiting</th>
                      <th className="px-4 py-2 text-right font-medium">Decision</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {filtered.map((item) => (
                      <tr key={item.check_id} className="transition hover:bg-surface-sunken/50">
                        <td className="px-4 py-3">
                          <p className="font-medium text-foreground">{item.client_name}</p>
                          <p className="mt-0.5 text-[11.5px] text-muted">{item.campaign_name}</p>
                        </td>
                        <td className="max-w-[280px] px-4 py-3">
                          {/* The live URL is the task. An anchor, not text, so it opens
                              in a new tab and the reviewer keeps this page. */}
                          <a
                            href={item.live_url ?? item.target_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline"
                          >
                            <span className="max-w-[220px] truncate">
                              {item.live_url ?? item.target_url}
                            </span>
                            <ExternalLink className="size-3 shrink-0" aria-hidden />
                          </a>
                          {item.anchor_text && (
                            <p className="mt-0.5 text-[11.5px] text-muted">
                              Looking for: <span className="text-foreground-soft">{item.anchor_text}</span>
                            </p>
                          )}
                        </td>
                        <td className="max-w-[260px] px-4 py-3 text-[11.5px] leading-relaxed text-muted">
                          {reviewExplain(item)}
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 text-muted">
                          {formatRelative(item.checked_at)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex justify-end gap-1">
                            <Button size="sm" variant="secondary" onClick={() => open(item, "present")}>
                              Link is there
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => open(item, "missing")}>
                              Missing
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </PageStack>

      <Dialog.Root open={Boolean(pending)} onOpenChange={(open) => !open && setPending(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
            <div className="flex items-start justify-between gap-3">
              <div>
                <Dialog.Title className="text-[15px] font-semibold text-foreground">
                  {isMissing ? "Confirm the link is missing" : "Confirm the link is there"}
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-[12.5px] leading-relaxed text-muted">
                  {isMissing
                    ? "This records the date the absence was seen. It does not remove the placement — you still decide that on the board."
                    : "This clears the review. The queue will not ask again unless a future check finds the page unreadable."}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <X />
                </Button>
              </Dialog.Close>
            </div>

            {pending && (
              <div className="mt-4">
                <a
                  href={pending.item.live_url ?? pending.item.target_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 break-all text-[12px] text-brand-600 hover:underline"
                >
                  {pending.item.live_url ?? pending.item.target_url}
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                </a>

                <div className="mt-3">
                  <Field label="Note (optional)" hint="What you saw. Useful when the page changes again.">
                    <Input
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Link present in the article body"
                    />
                  </Field>
                </div>

                {isMissing && (
                  <div className="mt-3 flex items-start gap-2 rounded-md border border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)]/50 p-2.5">
                    <AlertTriangle
                      className="mt-0.5 size-3.5 shrink-0 text-[var(--color-warning)]"
                      aria-hidden
                    />
                    <p className="text-[11.5px] leading-relaxed text-foreground-soft">
                      The placement stays {pending.item.placement_status}. Move it to Removed yourself if the
                      client should be told.
                    </p>
                  </div>
                )}

                {error && (
                  <p role="alert" className="mt-3 text-[12.5px] text-[var(--color-danger)]">
                    {error}
                  </p>
                )}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant={isMissing ? "danger" : "primary"}
                loading={resolve.isPending}
                onClick={() => void confirm()}
              >
                {isMissing ? "Yes, it's missing" : "Yes, it's there"}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </PageContainer>
  );
}

/**
 * A count for the dashboard, so the queue is discoverable without remembering it.
 */
export function ReviewQueueCount() {
  const queue = useReviewQueue();
  const count = queue.data?.length ?? 0;
  if (count === 0) return null;
  return <Badge tone="warning">{count} link review{count === 1 ? "" : "s"}</Badge>;
}
