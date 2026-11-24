import { Link } from "react-router-dom";
import { ArrowRight, CircleCheck, FileText, Link2, Megaphone, PenLine } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/card";
import { formatRelative, humanize } from "@/lib/utils";
import { PortalPageHeading } from "./portal-shell";
import {
  PORTAL_DRAFT_STATUS,
  portalErrorMessage,
  usePortalDrafts,
  usePortalOverview,
  usePortalPlacements,
} from "./use-portal";

/**
 * CLIENT DASHBOARD.
 *
 * The review queue comes FIRST, above the numbers. Everything else on this page is
 * reassurance; the queue is the only part that needs the client to do something, and
 * putting it below a row of statistics buries the one actionable thing.
 */
export function PortalHomePage() {
  const overview = usePortalOverview();
  const drafts = usePortalDrafts();
  const placements = usePortalPlacements();

  const awaiting = (drafts.data ?? []).filter((d) => d.status === "in_review");
  const recent = (placements.data ?? []).slice(0, 6);

  if (overview.isError) {
    return (
      <>
        <PortalPageHeading title="Overview" />
        <ErrorState
          description={portalErrorMessage(overview.error)}
          onRetry={() => void overview.refetch()}
        />
      </>
    );
  }

  return (
    <>
      <PortalPageHeading
        title="Overview"
        description="Your campaigns, the links we have placed, and the content waiting for your review."
      />

      {/* The actionable part first. */}
      <section aria-labelledby="review-heading" className="mb-6">
        <h2 id="review-heading" className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-foreground">
          <PenLine className="size-4 text-[var(--color-warning)]" aria-hidden />
          Awaiting your review
          {awaiting.length > 0 && (
            <span className="rounded-full bg-[var(--color-warning-soft)] px-1.5 text-[11px] font-semibold text-[var(--color-warning)]">
              {awaiting.length}
            </span>
          )}
        </h2>

        {drafts.isLoading ? (
          <Card>
            <CardContent className="space-y-2 p-4">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ) : awaiting.length === 0 ? (
          <Card>
            <CardContent className="flex items-center gap-3 p-4">
              <CircleCheck className="size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
              <p className="text-[12.5px] text-muted">
                Nothing is waiting on you. When we finish a draft it appears here for approval.
              </p>
            </CardContent>
          </Card>
        ) : (
          <ul className="space-y-2">
            {awaiting.map((draft) => (
              <li key={draft.id}>
                <Link
                  to={`/portal/drafts/${draft.id}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-4 py-3 transition hover:border-line-strong hover:bg-surface-sunken/50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-foreground">
                      {draft.title ?? "Untitled article"}
                    </p>
                    <p className="text-[11.5px] text-muted">
                      {draft.word_count} words
                      {draft.submitted_at ? ` · submitted ${formatRelative(draft.submitted_at)}` : ""}
                    </p>
                  </div>
                  <ArrowRight className="size-4 shrink-0 text-muted" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Then the reassurance numbers. */}
      <section aria-labelledby="stats-heading" className="mb-6">
        <h2 id="stats-heading" className="sr-only">
          At a glance
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            icon={Link2}
            label="Live links"
            value={overview.data?.livePlacements}
            loading={overview.isLoading}
          />
          <StatTile
            icon={Megaphone}
            label="Campaigns"
            value={overview.data?.campaigns.length}
            loading={overview.isLoading}
          />
          <StatTile
            icon={FileText}
            label="Total placements"
            value={overview.data?.totalPlacements}
            loading={overview.isLoading}
          />
          <StatTile
            icon={PenLine}
            label="Awaiting review"
            value={awaiting.length}
            loading={drafts.isLoading}
            tone="warning"
          />
        </div>
      </section>

      <section aria-labelledby="recent-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="recent-heading" className="text-[13px] font-semibold text-foreground">
            Recent links
          </h2>
          <Link
            to="/portal/campaigns"
            className="inline-flex items-center gap-1 text-[12px] font-medium text-brand-600 hover:underline"
          >
            All campaigns
            <ArrowRight className="size-3" aria-hidden />
          </Link>
        </div>

        {placements.isError ? (
          <ErrorState
            description={portalErrorMessage(placements.error)}
            onRetry={() => void placements.refetch()}
          />
        ) : placements.isLoading ? (
          <Card>
            <CardContent className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </CardContent>
          </Card>
        ) : recent.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="No links yet"
            description="Links appear here once a placement goes live."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[12.5px]">
                <thead className="border-b border-line bg-surface-sunken/60">
                  <tr className="text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-4 py-2 font-medium">Target page</th>
                    <th className="px-4 py-2 font-medium">Anchor</th>
                    <th className="px-4 py-2 font-medium">Stage</th>
                    <th className="px-4 py-2 font-medium">Live since</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {recent.map((p) => (
                    <tr key={p.id}>
                      <td className="max-w-[240px] truncate px-4 py-2 text-foreground-soft" title={p.target_url}>
                        {p.target_url}
                      </td>
                      <td className="max-w-[160px] truncate px-4 py-2 text-muted" title={p.anchor_text ?? ""}>
                        {p.anchor_text ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={p.pipeline_stage === "live" ? "success" : "neutral"}>
                          {humanize(p.pipeline_stage)}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-muted">
                        {p.live_date ? new Date(p.live_date).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  loading,
  tone = "neutral",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | undefined;
  loading: boolean;
  tone?: "neutral" | "warning";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-1 flex items-center gap-1.5 text-muted">
          <Icon className="size-3.5" />
          <span className="text-[11.5px] font-medium">{label}</span>
        </div>
        {loading ? (
          <Skeleton className="h-7 w-12" />
        ) : (
          <p
            className={
              tone === "warning" && (value ?? 0) > 0
                ? "text-2xl font-semibold tabular-nums text-[var(--color-warning)]"
                : "text-2xl font-semibold tabular-nums text-foreground"
            }
          >
            {value ?? 0}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export { PORTAL_DRAFT_STATUS };
