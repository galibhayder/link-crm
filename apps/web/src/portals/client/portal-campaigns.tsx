import { useMemo } from "react";
import { ExternalLink, Globe2, Megaphone } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/card";
import { humanize } from "@/lib/utils";
import { PortalPageHeading } from "./portal-shell";
import {
  portalErrorMessage,
  usePortalCampaigns,
  usePortalPlacements,
  type PortalPlacement,
} from "./use-portal";

/**
 * CAMPAIGNS AND THEIR PLACEMENTS.
 *
 * Grouped rather than two separate lists, because the useful question is "what is
 * happening in this campaign", not "show me every placement in the account".
 *
 * Every field shown comes from `v_portal_placements`, which does not include cost,
 * assignee, supplier identity or internal notes. The UI cannot reveal what the
 * endpoint never sends.
 */
export function PortalCampaignsPage() {
  const campaigns = usePortalCampaigns();
  const placements = usePortalPlacements();

  const byCampaign = useMemo(() => {
    const map = new Map<string, PortalPlacement[]>();
    for (const p of placements.data ?? []) {
      const list = map.get(p.campaign_id);
      if (list) list.push(p);
      else map.set(p.campaign_id, [p]);
    }
    return map;
  }, [placements.data]);

  const isLoading = campaigns.isLoading || placements.isLoading;

  if (campaigns.isError) {
    return (
      <>
        <PortalPageHeading title="Campaigns" />
        <ErrorState
          description={portalErrorMessage(campaigns.error)}
          onRetry={() => void campaigns.refetch()}
        />
      </>
    );
  }

  return (
    <>
      <PortalPageHeading
        title="Campaigns"
        description="Each campaign and the links we are building for it."
      />

      {isLoading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-16 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (campaigns.data ?? []).length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Your account manager will set these up. They appear here as soon as they exist."
        />
      ) : (
        <div className="space-y-4">
          {(campaigns.data ?? []).map((campaign) => {
            const rows = byCampaign.get(campaign.id) ?? [];
            const live = rows.filter((r) => r.pipeline_stage === "live").length;

            return (
              <Card key={campaign.id}>
                <CardContent className="p-0">
                  <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-3.5">
                    <div className="min-w-0">
                      <h2 className="truncate text-[14px] font-semibold text-foreground">{campaign.name}</h2>
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        {rows.length} placement{rows.length === 1 ? "" : "s"} · {live} live
                        {campaign.monthly_link_target
                          ? ` · target ${campaign.monthly_link_target}/month`
                          : ""}
                      </p>
                    </div>
                    <Badge tone={campaign.status === "active" ? "success" : "neutral"}>
                      {humanize(campaign.status)}
                    </Badge>
                  </div>

                  {rows.length === 0 ? (
                    <p className="px-5 py-6 text-center text-[12.5px] text-muted">
                      No placements in this campaign yet.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-left text-[12.5px]">
                        <thead className="border-b border-line bg-surface-sunken/40">
                          <tr className="text-[11px] uppercase tracking-wide text-muted">
                            <th className="px-5 py-2 font-medium">Target page</th>
                            <th className="px-4 py-2 font-medium">Anchor</th>
                            <th className="px-4 py-2 font-medium">Stage</th>
                            <th className="px-4 py-2 font-medium">Indexed</th>
                            <th className="px-4 py-2 font-medium">Live link</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {rows.map((p) => (
                            <tr key={p.id}>
                              <td
                                className="max-w-[260px] truncate px-5 py-2 text-foreground-soft"
                                title={p.target_url}
                              >
                                {p.target_url}
                              </td>
                              <td
                                className="max-w-[160px] truncate px-4 py-2 text-muted"
                                title={p.anchor_text ?? ""}
                              >
                                {p.anchor_text ?? "—"}
                              </td>
                              <td className="px-4 py-2">
                                <Badge tone={p.pipeline_stage === "live" ? "success" : "neutral"}>
                                  {humanize(p.pipeline_stage)}
                                </Badge>
                              </td>
                              <td className="px-4 py-2 text-muted">
                                {p.index_status === "indexed" ? (
                                  <span className="text-[var(--color-success)]">indexed</span>
                                ) : p.index_status === "not_indexed" ? (
                                  "not indexed"
                                ) : (
                                  "—"
                                )}
                              </td>
                              <td className="px-4 py-2">
                                {p.live_url ? (
                                  <a
                                    href={p.live_url}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                                  >
                                    View
                                    <ExternalLink className="size-3" aria-hidden />
                                  </a>
                                ) : (
                                  <span className="text-muted">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-muted">
        <Globe2 className="mt-0.5 size-3 shrink-0" aria-hidden />
        Placements appear once they reach client approval. Earlier stages are our internal
        pipeline and are not shown here.
      </p>
    </>
  );
}
