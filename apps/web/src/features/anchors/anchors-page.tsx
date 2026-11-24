import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  BellOff,
  CheckCircle2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useAccessToken, useAuth } from "@/providers/auth";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { PageHeading } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { ANCHOR_COLORS, ChartLegend, DonutChart, ShareBar, type Slice } from "@/components/ui/charts";
import { cn } from "@/lib/utils";

/**
 * ANCHOR ANALYTICS.
 *
 * The brief asks for the distribution to be "interactive" and the alerts to be
 * "configurable". Both are here: a donut for the shape at a glance, per-category
 * bars that show the healthy range behind each share, and alert rules the account
 * manager can set.
 *
 * The charts are SVG components in `components/ui/charts` — see the note there on
 * why there is no charting dependency.
 */

interface DistributionGroup {
  group: string;
  linkCount: number;
  share: number;
  target: { min: number; max: number } | null;
}

interface Distribution {
  scope: "campaign" | "client";
  scopeId: string;
  /** Classified links: the denominator for every share. */
  totalLinks: number;
  raw: Array<{ anchor_type: string; link_count: number; share: number }>;
  groups: DistributionGroup[];
  unclassified: number;
  /** Every live link, classified or not. */
  trackedLinks: number;
}

interface AnchorAlert {
  id: string;
  campaign_id: string | null;
  client_id: string | null;
  anchor_category: string;
  max_share: number;
  min_share: number | null;
  min_links: number;
  enabled: boolean;
}

interface Breach {
  category: string;
  share: number;
  linkCount: number;
  kind: "above_max" | "below_min";
  threshold: number;
  source: "configured" | "default";
  severity: "warning" | "critical";
}

interface Evaluation {
  scope: string;
  totalLinks: number;
  breaches: Breach[];
  healthy: boolean;
}

const GROUP_LABELS: Record<string, string> = {
  branded: "Branded",
  exact_match: "Exact match",
  partial_match: "Partial match",
  generic_or_naked: "Generic / Naked URL",
  unclassified: "Unclassified",
};

export function AnchorsPage() {
  const token = useAccessToken();
  const { can } = useAuth();
  const qc = useQueryClient();

  const [scope, setScope] = useState<"campaign" | "client">("campaign");
  const [campaignId, setCampaignId] = useState("");
  const [clientId, setClientId] = useState("");
  const [alertOpen, setAlertOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const campaigns = useQuery({
    queryKey: ["campaign-options"],
    queryFn: async () => {
      const res = await apiRequest<Array<{ id: string; name: string }>>("/api/v1/campaigns?limit=200", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
    staleTime: 60_000,
  });

  const clients = useQuery({
    queryKey: ["client-options"],
    queryFn: async () => {
      const res = await apiRequest<Array<{ id: string; name: string }>>("/api/v1/clients?limit=200", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
    staleTime: 60_000,
  });

  // Default to the first option so the page is not empty on arrival.
  const activeCampaign = campaignId || campaigns.data?.[0]?.id || "";
  const activeClient = clientId || clients.data?.[0]?.id || "";
  const scopeId = scope === "campaign" ? activeCampaign : activeClient;

  const scopeQuery = buildQuery({
    campaignId: scope === "campaign" ? scopeId : undefined,
    clientId: scope === "client" ? scopeId : undefined,
  });

  const distribution = useQuery({
    queryKey: ["anchors", "distribution", scope, scopeId],
    queryFn: async () => {
      const res = await apiRequest<Distribution>(
        `/api/v1/anchors/distribution${buildQuery({
          scope,
          campaignId: scope === "campaign" ? scopeId : undefined,
          clientId: scope === "client" ? scopeId : undefined,
        })}`,
        { token },
      );
      return res.data;
    },
    enabled: Boolean(token && scopeId),
  });

  const alerts = useQuery({
    queryKey: ["anchors", "alerts", scope, scopeId],
    queryFn: async () => {
      const res = await apiRequest<AnchorAlert[]>(`/api/v1/anchors/alerts${scopeQuery}`, { token });
      return res.data ?? [];
    },
    enabled: Boolean(token && scopeId),
  });

  const evaluation = useQuery({
    queryKey: ["anchors", "evaluate", scope, scopeId],
    queryFn: async () => {
      const res = await apiRequest<Evaluation>(`/api/v1/anchors/alerts/evaluate${scopeQuery}`, { token });
      return res.data;
    },
    enabled: Boolean(token && scopeId),
  });

  const backfill = useMutation({
    mutationFn: async () => {
      await apiRequest("/api/v1/anchors/backfill", {
        method: "POST",
        body: { campaignId: scope === "campaign" ? scopeId : undefined, limit: 200 },
        token,
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["anchors"] }),
    onError: (err) => setError((err as ApiError).message),
  });

  // The API already returns only the four classified groups, with unclassified
  // reported separately and excluded from the shares. Adding it here would double
  // count it in the ring.
  const slices: Slice[] = useMemo(
    () =>
      (distribution.data?.groups ?? []).map((g) => ({
        label: GROUP_LABELS[g.group] ?? g.group,
        value: g.linkCount,
        color: ANCHOR_COLORS[g.group] ?? "var(--color-line-strong)",
      })),
    [distribution.data],
  );

  const total = distribution.data?.totalLinks ?? 0;

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Anchor analytics"
          description="How your anchor text is distributed, and whether it is drifting out of a healthy range."
          actions={
            <>
              <Button
                variant="secondary"
                size="sm"
                loading={backfill.isPending}
                onClick={() => backfill.mutate()}
                title="Classify placements that have no anchor category yet"
              >
                <Sparkles />
                Classify
              </Button>
              <Button size="sm" onClick={() => setAlertOpen(true)} disabled={!can("settings:manage")}>
                <Plus />
                New alert
              </Button>
            </>
          }
        />

        {/* Scope: the brief asks for both campaign and client views. */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="inline-flex rounded-lg border border-line bg-surface p-0.5"
            role="group"
            aria-label="Distribution scope"
          >
            {(["campaign", "client"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                aria-pressed={scope === s}
                className={cn(
                  "rounded-md px-3 py-1 text-[12.5px] font-medium capitalize transition",
                  scope === s ? "bg-brand-600 text-white" : "text-muted hover:text-foreground",
                )}
              >
                By {s}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <span className="sr-only">{scope === "campaign" ? "Campaign" : "Client"}</span>
            <select
              value={scope === "campaign" ? activeCampaign : activeClient}
              onChange={(e) => (scope === "campaign" ? setCampaignId(e.target.value) : setClientId(e.target.value))}
              className="h-10 rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            >
              {(scope === "campaign" ? campaigns.data ?? [] : clients.data ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>

          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              void distribution.refetch();
              void evaluation.refetch();
            }}
            loading={distribution.isFetching}
          >
            <RefreshCw />
            Refresh
          </Button>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-danger)]"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        {distribution.isError ? (
          <ErrorState
            description={(distribution.error as ApiError)?.message}
            onRetry={() => void distribution.refetch()}
          />
        ) : distribution.isLoading ? (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <Card><CardContent className="h-64 animate-pulse p-5" /></Card>
            <Card><CardContent className="h-64 animate-pulse p-5" /></Card>
          </div>
        ) : total === 0 ? (
          <EmptyState
            icon={BarChart3}
            title="No live links to analyse yet"
            description="Anchor distribution counts live placements. Once links go live, or once existing anchors are classified, the breakdown appears here."
            action={
              <Button size="sm" variant="secondary" loading={backfill.isPending} onClick={() => backfill.mutate()}>
                <Sparkles />
                Classify existing anchors
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <Card>
              <CardContent className="flex flex-col items-center gap-4 p-5">
                <DonutChart slices={slices} total={total} centreLabel="live links" />
                <div className="w-full">
                  <ChartLegend slices={slices} total={total} />
                </div>
                {(distribution.data?.unclassified ?? 0) > 0 && (
                  <p className="w-full text-[11.5px] leading-relaxed text-muted">
                    {distribution.data?.unclassified} of {distribution.data?.trackedLinks} live links are
                    unclassified and excluded from these shares. Run <strong>Classify</strong> to include them.
                  </p>
                )}
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardContent className="space-y-4 p-5">
                  <h2 className="text-[13px] font-semibold text-foreground">Share against the healthy range</h2>
                  {(distribution.data?.groups ?? []).map((g) => (
                    <ShareBar
                      key={g.group}
                      label={GROUP_LABELS[g.group] ?? g.group}
                      share={g.share}
                      value={g.linkCount}
                      target={g.target}
                    />
                  ))}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-5">
                  <div className="mb-3 flex items-center gap-2">
                    {evaluation.data?.healthy ? (
                      <CheckCircle2 className="size-4 text-[var(--color-success)]" aria-hidden />
                    ) : (
                      <AlertTriangle className="size-4 text-[var(--color-danger)]" aria-hidden />
                    )}
                    <h2 className="text-[13px] font-semibold text-foreground">
                      {evaluation.data?.healthy
                        ? "No alerts firing"
                        : `${evaluation.data?.breaches.length ?? 0} alert(s) firing`}
                    </h2>
                  </div>

                  {(evaluation.data?.breaches ?? []).length === 0 ? (
                    <p className="text-[12.5px] text-muted">
                      Every category is inside its configured or default range.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {evaluation.data?.breaches.map((b) => (
                        <li
                          key={`${b.category}-${b.kind}`}
                          className={cn(
                            "flex items-start gap-2 rounded-lg border px-3 py-2",
                            b.severity === "critical"
                              ? "border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/40"
                              : "border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)]/40",
                          )}
                        >
                          <AlertTriangle
                            className={cn(
                              "mt-0.5 size-3.5 shrink-0",
                              b.severity === "critical"
                                ? "text-[var(--color-danger)]"
                                : "text-[var(--color-warning)]",
                            )}
                            aria-hidden
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[12.5px] font-medium text-foreground">
                              {GROUP_LABELS[b.category] ?? b.category}{" "}
                              {b.kind === "above_max" ? "is above" : "is below"}{" "}
                              {(b.threshold * 100).toFixed(0)}%
                            </p>
                            <p className="text-[11.5px] text-muted">
                              currently {(b.share * 100).toFixed(1)}% across {b.linkCount} links ·{" "}
                              {b.source === "configured" ? "your configured threshold" : "default threshold"}
                            </p>
                          </div>
                          <Badge tone={b.severity === "critical" ? "danger" : "warning"}>{b.severity}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        <Card>
          <CardContent className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                <Bell className="size-4 text-muted" aria-hidden />
                Monitoring alerts
              </h2>
              <p className="text-[11.5px] text-muted">Applied to the selected {scope}</p>
            </div>

            {(alerts.data ?? []).length === 0 ? (
              <p className="text-[12.5px] text-muted">
                No alerts configured for this {scope}. Default thresholds still apply when you evaluate.
              </p>
            ) : (
              <ul className="divide-y divide-line">
                {alerts.data?.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-medium text-foreground">
                        {GROUP_LABELS[a.anchor_category] ?? a.anchor_category}
                      </p>
                      <p className="text-[11.5px] text-muted">
                        max {(Number(a.max_share) * 100).toFixed(0)}%
                        {a.min_share != null && ` · min ${(Number(a.min_share) * 100).toFixed(0)}%`}
                        {` · needs ${a.min_links}+ links`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {a.enabled ? (
                        <Badge tone="success" dot>
                          on
                        </Badge>
                      ) : (
                        <Badge tone="outline" dot>
                          off
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={a.enabled ? "Disable alert" : "Enable alert"}
                        onClick={() =>
                          void apiRequest(`/api/v1/anchors/alerts/${a.id}`, {
                            method: "PATCH",
                            body: { enabled: !a.enabled },
                            token,
                          }).then(() => qc.invalidateQueries({ queryKey: ["anchors"] }))
                        }
                      >
                        {a.enabled ? <BellOff /> : <Bell />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete alert"
                        onClick={() =>
                          void apiRequest(`/api/v1/anchors/alerts/${a.id}`, { method: "DELETE", token }).then(() =>
                            qc.invalidateQueries({ queryKey: ["anchors"] }),
                          )
                        }
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </PageStack>

      <AlertDialog
        open={alertOpen}
        onOpenChange={setAlertOpen}
        scope={scope}
        scopeId={scopeId}
        onCreated={() => {
          void qc.invalidateQueries({ queryKey: ["anchors"] });
          setAlertOpen(false);
        }}
      />
    </PageContainer>
  );
}

function AlertDialog({
  open,
  onOpenChange,
  scope,
  scopeId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scope: "campaign" | "client";
  scopeId: string;
  onCreated: () => void;
}) {
  const token = useAccessToken();
  const [category, setCategory] = useState("exact_match");
  const [maxShare, setMaxShare] = useState("15");
  const [minShare, setMinShare] = useState("");
  const [minLinks, setMinLinks] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/v1/anchors/alerts", {
        method: "POST",
        body: {
          campaignId: scope === "campaign" ? scopeId : null,
          clientId: scope === "client" ? scopeId : null,
          anchorCategory: category,
          // The UI works in whole percent; the API stores a 0..1 fraction.
          maxShare: Number(maxShare) / 100,
          minShare: minShare ? Number(minShare) / 100 : null,
          minLinks: Number(minLinks),
        },
        token,
      });
      onCreated();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <Dialog.Title className="text-[15px] font-semibold text-foreground">New anchor alert</Dialog.Title>
          <Dialog.Description className="mb-3 mt-1 text-[12.5px] text-muted">
            Fires when the share for this category leaves the range. Ratios below the link floor are ignored.
          </Dialog.Description>

          <div className="space-y-3">
            <Field label="Category">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground"
              >
                <option value="branded">Branded</option>
                <option value="exact_match">Exact match</option>
                <option value="partial_match">Partial match</option>
                <option value="generic">Generic</option>
                <option value="naked_url">Naked URL</option>
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Max share (%)">
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={maxShare}
                  onChange={(e) => setMaxShare(e.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px]"
                />
              </Field>
              <Field label="Min share (%)" hint="Optional">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={minShare}
                  onChange={(e) => setMinShare(e.target.value)}
                  className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px]"
                />
              </Field>
            </div>

            <Field label="Minimum links" hint="Below this, the ratio is noise.">
              <input
                type="number"
                min="0"
                value={minLinks}
                onChange={(e) => setMinLinks(e.target.value)}
                className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px]"
              />
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
              <Button size="sm" loading={busy} onClick={submit}>
                Create alert
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
