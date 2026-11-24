import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/card";
import { cn, formatRelative } from "@/lib/utils";
import { PortalPageHeading } from "./portal-shell";
import { PORTAL_DRAFT_STATUS, portalErrorMessage, usePortalDrafts } from "./use-portal";

/**
 * CONTENT LIST.
 *
 * `GET /portal/v1/drafts` already returns only `in_review`, `approved` and
 * `published` — a client never sees a draft in `draft` or `revision_requested`,
 * because those are the agency's working states. So the filter here narrows a list
 * that is already correct, and the empty states can be honest about why.
 */

const FILTERS = [
  { key: "all", label: "All" },
  { key: "in_review", label: "Awaiting review" },
  { key: "approved", label: "Approved" },
  { key: "published", label: "Published" },
] as const;

export function PortalDraftsPage() {
  const drafts = usePortalDrafts();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");

  const rows = useMemo(() => {
    const all = drafts.data ?? [];
    const filtered = filter === "all" ? all : all.filter((d) => d.status === filter);
    // Awaiting review first — that is the only group needing action.
    return [...filtered].sort((a, b) => {
      if (a.status === "in_review" && b.status !== "in_review") return -1;
      if (b.status === "in_review" && a.status !== "in_review") return 1;
      return (b.submitted_at ?? "").localeCompare(a.submitted_at ?? "");
    });
  }, [drafts.data, filter]);

  const counts = useMemo(() => {
    const all = drafts.data ?? [];
    return {
      all: all.length,
      in_review: all.filter((d) => d.status === "in_review").length,
      approved: all.filter((d) => d.status === "approved").length,
      published: all.filter((d) => d.status === "published").length,
    };
  }, [drafts.data]);

  if (drafts.isError) {
    return (
      <>
        <PortalPageHeading title="Content" />
        <ErrorState description={portalErrorMessage(drafts.error)} onRetry={() => void drafts.refetch()} />
      </>
    );
  }

  return (
    <>
      <PortalPageHeading
        title="Content"
        description="Articles we have written for your campaigns. Approve them, or ask for changes."
      />

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <div className="inline-flex flex-wrap rounded-lg border border-line bg-surface p-0.5" role="group" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
              className={cn(
                "rounded-md px-2.5 py-1 text-[12.5px] font-medium transition",
                filter === f.key ? "bg-brand-600 text-white" : "text-muted hover:text-foreground",
              )}
            >
              {f.label}
              <span className="ml-1.5 tabular-nums opacity-70">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      </div>

      {drafts.isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <CardContent className="space-y-2 p-4">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-3 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={filter === "all" ? "No content yet" : `Nothing ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase()}`}
          description={
            filter === "in_review"
              ? "When we finish an article it appears here for your approval."
              : "Articles appear here once they have been submitted for review."
          }
        />
      ) : (
        <ul className="space-y-2">
          {rows.map((draft) => {
            const meta = PORTAL_DRAFT_STATUS[draft.status] ?? { label: draft.status, tone: "neutral" as const };
            return (
              <li key={draft.id}>
                <Link
                  to={`/portal/drafts/${draft.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 transition hover:border-line-strong hover:bg-surface-sunken/50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {draft.title ?? "Untitled article"}
                    </p>
                    <p className="mt-0.5 text-[11.5px] text-muted">
                      {draft.word_count} words
                      {draft.submitted_at ? ` · submitted ${formatRelative(draft.submitted_at)}` : ""}
                      {draft.approved_at ? ` · approved ${formatRelative(draft.approved_at)}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    <ArrowRight className="size-4 text-muted" aria-hidden />
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
