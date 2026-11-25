import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowUpRight, Building2, Link2, Target, Users } from "lucide-react";
import { DASHBOARD_WIDGET_IDS } from "@crm/shared";
import { useAccessToken, useAuth } from "@/providers/auth";
import { ReviewQueueCount } from "@/features/placements/link-review-page";
import { useOptionalUiConfig } from "@/providers/ui-config";
import { apiGet, API_BASE } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeading,
} from "@/components/ui/card";
import { ErrorState, MetricSkeletonGrid } from "@/components/ui/states";
import { PageContainer, PageStack } from "@/components/layout/app-shell";

interface DashboardSummary {
  activeClients: number;
  activeCampaigns: number;
  totalProspects: number;
  livePlacements: number;
}

interface HealthResponse {
  status: string;
  database: string;
  latencyMs: number;
}

/** Health pill — polls readiness so a broken database is visible immediately. */
export function useSystemHealth() {
  return useQuery({
    queryKey: ["health", "ready"],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/health/ready`);
      if (!res.ok) throw new Error("unhealthy");
      return ((await res.json()) as { data: HealthResponse }).data;
    },
    refetchInterval: 30_000,
    retry: 1,
    staleTime: 15_000,
  });
}

export function HealthIndicator() {
  const { data, isError, isLoading } = useSystemHealth();

  if (isLoading) return <Badge tone="neutral">Checking system…</Badge>;

  if (isError || data?.database !== "reachable") {
    return (
      <Badge tone="danger" dot>
        API unavailable
      </Badge>
    );
  }

  return (
    <Badge tone="success" dot>
      All systems operational · {data.latencyMs}ms
    </Badge>
  );
}

export function DashboardPage() {
  const token = useAccessToken();
  const { can } = useAuth();
  const health = useSystemHealth();

  const summary = useQuery({
    queryKey: ["reports", "dashboard"],
    queryFn: () => apiGet<DashboardSummary>("/api/v1/reports/dashboard", token),
    enabled: Boolean(token),
  });

  // Derived from real signals — never a hardcoded "Online".
  const reachedApi = summary.isSuccess || health.isSuccess;
  const apiState: HealthState = health.isError && summary.isError ? "offline" : reachedApi ? "online" : "unknown";
  const dbState: HealthState = health.isError
    ? "offline"
    : health.data?.database === "reachable"
      ? "online"
      : health.isLoading
        ? "unknown"
        : "degraded";
  const authState: HealthState = token ? "online" : "unknown";

  /**
   * DASHBOARD LAYOUT FROM CONFIG.
   *
   * The Admin panel lets an owner hide and reorder the three blocks. Without this,
   * those settings were stored and returned and then ignored — the switches did
   * nothing, which is worse than not offering them.
   *
   * Defaults are "all three, in declaration order", so an organisation with no
   * configuration sees exactly what it saw before this phase.
   */
  const ui = useOptionalUiConfig();
  const dashboardConfig = ui?.config.dashboard ?? {};
  const hiddenWidgets = new Set(dashboardConfig.hidden ?? []);

  const shownWidgets = useMemo(() => {
    // The config's order/hidden arrays are `string[]` (an org may have stored an id
    // that has since been removed), so they are narrowed against the registry
    // rather than trusted. A stale id is dropped, not rendered.
    const isKnown = (w: string): w is (typeof DASHBOARD_WIDGET_IDS)[number] =>
      (DASHBOARD_WIDGET_IDS as readonly string[]).includes(w);

    const order = (dashboardConfig.order ?? []).filter(isKnown);
    // Configured order first, then anything not mentioned — so a newly added
    // widget is not silently dropped from everyone's dashboard.
    const ordered = [...order, ...DASHBOARD_WIDGET_IDS.filter((w) => !order.includes(w))];
    return ordered.filter((w) => !hiddenWidgets.has(w));
  }, [dashboardConfig.order, dashboardConfig.hidden]);

  const metrics = [
    {
      label: "Active clients",
      value: summary.data?.activeClients,
      icon: Building2,
      hint: "Clients with a current engagement",
    },
    {
      label: "Active campaigns",
      value: summary.data?.activeCampaigns,
      icon: Target,
      hint: "Campaigns currently running",
    },
    {
      label: "Prospects",
      value: summary.data?.totalProspects,
      icon: Users,
      hint: "Sites in the outreach pipeline",
    },
    {
      label: "Live placements",
      value: summary.data?.livePlacements,
      icon: Link2,
      hint: "Links confirmed live",
    },
  ];

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Dashboard"
          description="A live view of your agency's pipeline, delivery and financial health."
          actions={
            <div className="flex items-center gap-2">
              {/* Discoverable without remembering the URL — but only for roles that
                  can act on it. Rendering it unconditionally would make every other
                  role's dashboard fire a request that 403s. */}
              {can("placements:check") && <ReviewQueueCount />}
              <HealthIndicator />
            </div>
          }
        />

        {shownWidgets.includes("metrics") &&
          (summary.isLoading ? (
            <MetricSkeletonGrid count={4} />
          ) : summary.isError ? (
            <ErrorState
              title="Couldn't load dashboard figures"
              description="The API rejected the request. If this persists, check that the server is running and your session is still valid."
              onRetry={() => void summary.refetch()}
            />
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {metrics.map((metric) => {
                const Icon = metric.icon;
                return (
                  <Card key={metric.label} className="group relative overflow-hidden p-5">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-[12.5px] font-medium text-muted">{metric.label}</p>
                        <p className="mt-2 text-[26px] font-semibold leading-none tracking-tight text-foreground tabular-nums">
                          {formatNumber(metric.value)}
                        </p>
                      </div>
                      <div className="flex size-9 items-center justify-center rounded-md bg-surface-sunken text-muted-strong transition-colors group-hover:bg-brand-50 group-hover:text-brand-600 dark:group-hover:bg-brand-900/40 dark:group-hover:text-brand-300">
                        <Icon className="size-[18px]" aria-hidden />
                      </div>
                    </div>
                    <p className="mt-3 text-[11.5px] leading-relaxed text-muted">{metric.hint}</p>
                  </Card>
                );
              })}
            </div>
          ))}

        {(shownWidgets.includes("gettingStarted") || shownWidgets.includes("health")) && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {shownWidgets.includes("gettingStarted") && (
              <Card className={shownWidgets.includes("health") ? "lg:col-span-2" : "lg:col-span-3"}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Getting started</CardTitle>
                      <CardDescription>
                        Phase 1 delivers the foundation. Modules arrive in the next phases.
                      </CardDescription>
                    </div>
                    <Activity className="size-4 text-muted" aria-hidden />
                  </div>
                </CardHeader>
                <CardContent>
                  <ol className="flex flex-col gap-3">
                    {[
                      {
                        title: "Foundation",
                        body: "Monorepo, design system, authentication, role-aware navigation and health checks.",
                        state: "done" as const,
                      },
                      {
                        title: "Clients & campaigns",
                        body: "Client records with billing profiles, campaigns, monthly targets and assignments.",
                        state: "next" as const,
                      },
                      {
                        title: "Outreach & placement pipeline",
                        body: "Publisher database, prospect stages, touchpoint history and link monitoring.",
                        state: "planned" as const,
                      },
                      {
                        title: "Billing, margins & portals",
                        body: "Invoices, payments, profitability reporting, then the client and publisher portals.",
                        state: "planned" as const,
                      },
                    ].map((step, i) => (
                      <li key={step.title} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span
                            className={
                              "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold " +
                              (step.state === "done"
                                ? "bg-[var(--color-success-soft)] text-[var(--color-success)]"
                                : step.state === "next"
                                  ? "bg-brand-100 text-brand-700 dark:bg-brand-900/50 dark:text-brand-300"
                                  : "bg-surface-sunken text-muted")
                            }
                          >
                            {i + 1}
                          </span>
                          {i < 3 && <span className="mt-1 h-full w-px bg-line" aria-hidden />}
                        </div>
                        <div className="pb-1">
                          <p className="text-[13.5px] font-medium text-foreground">
                            {step.title}
                            {step.state === "done" && (
                              <span className="ml-2 align-middle">
                                <Badge tone="success">Complete</Badge>
                              </span>
                            )}
                            {step.state === "next" && (
                              <span className="ml-2 align-middle">
                                <Badge tone="brand">Up next</Badge>
                              </span>
                            )}
                          </p>
                          <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted">{step.body}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </CardContent>
              </Card>
            )}

            {shownWidgets.includes("health") && (
              <Card className={shownWidgets.includes("gettingStarted") ? "" : "lg:col-span-3"}>
                <CardHeader>
                  <CardTitle>System</CardTitle>
                  <CardDescription>Live status of the services this app depends on.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <HealthRow
                    name="API"
                    detail="Express on :3000"
                    state={apiState}
                    latencyMs={health.data?.latencyMs}
                  />
                  <HealthRow name="Database" detail="Supabase Postgres" state={dbState} />
                  <HealthRow name="Auth" detail="Supabase Auth" state={authState} />
                  <div className="mt-1 rounded-md bg-surface-sunken p-3">
                    <p className="text-[11.5px] leading-relaxed text-muted">
                      Row Level Security is enabled and forced on every table. Permissions are enforced in
                      Postgres, not only in this interface.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </PageStack>
    </PageContainer>
  );
}

type HealthState = "online" | "degraded" | "offline" | "unknown";

/**
 * Reports the ACTUAL state rather than a hardcoded "Online".
 *
 * A status card that always says Online is worse than no status card: it teaches
 * people to trust a lie. Auth is derived from the session, not guessed.
 */
function HealthRow({
  name,
  detail,
  state,
  latencyMs,
}: {
  name: string;
  detail: string;
  state: HealthState;
  latencyMs?: number;
}) {
  const tone =
    state === "online" ? "success" : state === "degraded" ? "warning" : state === "offline" ? "danger" : "neutral";

  const label =
    state === "online"
      ? latencyMs !== undefined
        ? `Online · ${latencyMs}ms`
        : "Online"
      : state === "degraded"
        ? "Degraded"
        : state === "offline"
          ? "Offline"
          : "Unknown";

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium text-foreground">{name}</p>
        <p className="truncate text-[11px] text-muted">{detail}</p>
      </div>
      <Badge tone={tone} dot>
        {label}
      </Badge>
    </div>
  );
}

/** Placeholder used by every module route until its phase lands. */
export function ModulePlaceholder({
  title,
  description,
  icon: Icon = ArrowUpRight,
}: {
  title: string;
  description: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <PageContainer>
      <PageStack>
        <PageHeading title={title} description={description} />
        <Card>
          <CardContent className="pt-5">
            <div className="flex flex-col items-center justify-center py-14 text-center">
              <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-surface-sunken text-muted">
                <Icon className="size-5" aria-hidden />
              </div>
              <p className="text-[14px] font-medium text-foreground">{title} is coming in a later phase</p>
              <p className="mt-1 max-w-md text-[13px] leading-relaxed text-muted">
                Phase 1 establishes the foundation. The database schema, permissions and API for this
                module already exist — only the interface is pending.
              </p>
              <Badge tone="brand" className="mt-4">
                Planned
              </Badge>
            </div>
          </CardContent>
        </Card>
      </PageStack>
    </PageContainer>
  );
}
