import { useQuery } from "@tanstack/react-query";
import { BarChart3, FileSpreadsheet, FileText, Globe2, Link2, ShieldCheck } from "lucide-react";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, PageHeading, Skeleton } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAccessToken, useAuth } from "@/providers/auth";
import { apiRequest } from "@/lib/api";
import { downloadReportExport, invoiceErrorMessage } from "@/features/invoices/use-invoices";

/**
 * REPORTS HUB.
 *
 * Every report is a table with a CSV and an Excel button, plus a PDF where one
 * exists. Each card declares its audience, because the difference between the
 * client report and the internal one is the whole point of the section — and a
 * reader should be able to tell which they are looking at without opening it.
 *
 * The export buttons are gated on the SAME permission as the data they export,
 * so a visible button always works. A button that 403s is a bug report waiting to
 * happen.
 */

type Permission = ReturnType<typeof useAuth>["can"] extends (p: infer P) => boolean ? P : never;

export function ReportsPage() {
  const { can } = useAuth();
  const token = useAccessToken();

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Reports"
          description="Delivery, financial and operational reporting. Each report is available as CSV and Excel; the financial reports add a PDF."
        />

        <div className="grid gap-3 md:grid-cols-2">
          <ReportCard
            icon={BarChart3}
            title="Client campaign report"
            audience="Client-safe"
            description="Campaigns, delivery against target, and live link counts. Contains no cost, payout or margin."
            permission="reports:read"
            can={can}
            csvPath="/portal/v1/reports/campaigns/export"
            xlsxPath="/portal/v1/reports/campaigns/export"
            filename="Campaign Report"
            token={token}
          />

          {can("reports:margins") && (
            <ReportCard
              icon={BarChart3}
              title="Internal campaign report"
              audience="Owner only"
              description="Per-campaign revenue, publisher cost, writer payouts, other expenses, gross profit and margin."
              permission="reports:margins"
              can={can}
              csvPath="/api/v1/reports/campaigns/export"
              xlsxPath="/api/v1/reports/campaigns/export"
              filename="Campaign Profitability"
              token={token}
            />
          )}

          {can("reports:margins") && (
            <ReportCard
              icon={FileText}
              title="Financial report"
              audience="Owner only"
              description="Billed, collected, outstanding receivables, payables and margin, one row per currency."
              permission="reports:margins"
              can={can}
              csvPath="/api/v1/reports/financial/export"
              xlsxPath="/api/v1/reports/financial/export"
              filename="Financial Summary"
              token={token}
            />
          )}

          <ReportCard
            icon={Globe2}
            title="Publisher report"
            audience="Internal"
            description="The publisher database with domain metrics. Never includes what a client is charged."
            permission="publishers:read"
            can={can}
            csvPath="/api/v1/reports/publishers"
            xlsxPath="/api/v1/reports/publishers"
            filename="Publishers"
            token={token}
          />

          <ReportCard
            icon={Link2}
            title="Placement report"
            audience="Internal"
            description="Every placement with anchor, stage and live status. Excludes wholesale cost."
            permission="placements:read"
            can={can}
            csvPath="/api/v1/reports/placements"
            xlsxPath="/api/v1/reports/placements"
            filename="Placements"
            token={token}
          />

          {can("audit:read") && <DatabaseReport />}
        </div>

        <Card>
          <CardContent className="p-4">
            <p className="text-[12px] leading-relaxed text-muted">
              Exports are generated from the same query as the screen, so a spreadsheet cannot
              show a field the page hides. Every export is recorded in the audit log with who ran it.
            </p>
          </CardContent>
        </Card>
      </PageStack>
    </PageContainer>
  );
}

function ReportCard({
  icon: Icon,
  title,
  audience,
  description,
  permission,
  can,
  csvPath,
  xlsxPath,
  filename,
  token,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  audience: string;
  description: string;
  permission: Permission;
  can: (p: Permission) => boolean;
  csvPath: string;
  xlsxPath: string;
  filename: string;
  token: string | null;
}) {
  if (!can(permission)) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-muted">
            <Icon className="size-3.5" aria-hidden />
          </span>
          <div>
            <CardTitle className="text-[13.5px]">{title}</CardTitle>
            <Badge tone={audience === "Owner only" ? "warning" : audience === "Client-safe" ? "success" : "neutral"}>
              {audience}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <p className="text-[12px] leading-relaxed text-muted">{description}</p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void downloadReportExport(csvPath, filename, token, "csv")}
          >
            <FileText />
            CSV
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void downloadReportExport(xlsxPath, filename, token, "xlsx")}
          >
            <FileSpreadsheet />
            Excel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * ADMIN DATABASE REPORT.
 *
 * Row counts and recent job runs. This is the report an operator reads when
 * something is wrong, so it shows health rather than business figures — and it is
 * the only report that is safe to paste into a support thread.
 */
function DatabaseReport() {
  const token = useAccessToken();

  const report = useQuery({
    queryKey: ["reports", "database"],
    queryFn: async () => {
      const res = await apiRequest<{
        tables: Array<{ table: string; rows: number }>;
        recentJobs: Array<{ job_name: string; status: string; started_at: string }>;
      }>("/api/v1/reports/database", { token });
      return res.data;
    },
    enabled: Boolean(token),
  });

  if (report.isError) {
    return (
      <Card>
        <CardContent className="p-4">
          <ErrorState description={invoiceErrorMessage(report.error)} onRetry={() => void report.refetch()} />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="md:col-span-2">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <ShieldCheck className="size-4 text-muted" aria-hidden />
        <CardTitle className="text-[13.5px]">Admin database report</CardTitle>
        <Badge tone="warning">Owner only</Badge>
      </CardHeader>
      <CardContent className="pt-0">
        {report.isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : !report.data ? (
          <EmptyState title="No data" description="The report could not be loaded." />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Row counts</p>
              <ul className="divide-y divide-line">
                {report.data.tables.map((t) => (
                  <li key={t.table} className="flex items-baseline justify-between py-1 text-[12px]">
                    <span className="text-foreground-soft">{t.table.replace(/_/g, " ")}</span>
                    <span className="tabular-nums text-muted">{t.rows.toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Recent jobs</p>
              {(report.data.recentJobs ?? []).length === 0 ? (
                <p className="text-[12px] text-muted">No job runs recorded.</p>
              ) : (
                <ul className="divide-y divide-line">
                  {report.data.recentJobs.slice(0, 8).map((j, i) => (
                    <li key={i} className="flex items-baseline justify-between gap-2 py-1 text-[12px]">
                      <span className="truncate text-foreground-soft">{j.job_name}</span>
                      <Badge tone={j.status === "ok" ? "success" : j.status === "error" ? "danger" : "neutral"}>
                        {j.status}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
