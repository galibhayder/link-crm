import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownRight,
  ArrowUpRight,
  Banknote,
  Download,
  Percent,
  PlusCircle,
  TrendingUp,
  Wallet,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, PageHeading, Skeleton } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAccessToken, useAuth } from "@/providers/auth";
import { apiRequest, buildQuery } from "@/lib/api";
import { cn } from "@/lib/utils";
import { downloadReportExport, formatInvoiceMoney, invoiceErrorMessage } from "@/features/invoices/use-invoices";

/**
 * FINANCIALS — owner only.
 *
 * Every figure here is margin-adjacent, so the route is behind `reports:margins`
 * and the API enforces the same permission. The page is reachable by URL only for
 * someone who holds it.
 *
 * Each card states what it measures. "Outstanding AR" and "publisher costs
 * outstanding" are deliberately separate: a business can look profitable and still
 * run out of cash, and merging the two hides exactly that.
 */

interface SummaryRow {
  currency: string;
  billed: string | number;
  collected: string | number;
  outstanding_ar: string | number;
  publisher_costs_outstanding: string | number;
  writer_payouts_outstanding: string | number;
  revenue: string | number;
  publisher_cost: string | number;
  writer_payouts: string | number;
  other_expenses: string | number;
  gross_profit: string | number;
  margin_pct: string | number | null;
}

interface CampaignRow {
  campaign_id: string;
  campaign_name: string;
  client_name: string;
  currency: string;
  revenue: string | number;
  publisher_cost: string | number;
  writer_payouts: string | number;
  other_expenses: string | number;
  gross_profit: string | number;
  margin_pct: string | number | null;
  priced_placements: number;
  unpriced_placements: number;
  multi_currency: boolean;
}

export function FinancePage() {
  const token = useAccessToken();
  const { can } = useAuth();

  const summary = useQuery({
    queryKey: ["finance", "summary"],
    queryFn: async () => {
      const res = await apiRequest<SummaryRow[]>("/api/v1/reports/financial", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  const campaigns = useQuery({
    queryKey: ["finance", "campaigns"],
    queryFn: async () => {
      const res = await apiRequest<CampaignRow[]>("/api/v1/reports/campaigns", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  if (summary.isError) {
    return (
      <PageContainer>
        <PageStack>
          <PageHeading title="Financials" />
          <ErrorState description={invoiceErrorMessage(summary.error)} onRetry={() => void summary.refetch()} />
        </PageStack>
      </PageContainer>
    );
  }

  const rows = summary.data ?? [];

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Financials"
          description="Revenue, cost, margin and what is owed in each direction. Visible to owners only."
        />

        {summary.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-4">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="mt-2 h-7 w-24" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={TrendingUp}
            title="No financial activity yet"
            description="Create an invoice or record a placement cost, and the figures appear here."
          />
        ) : (
          rows.map((row) => {
            const money = (v: string | number) => formatInvoiceMoney(v, row.currency);
            return (
              <div key={row.currency} className="space-y-3">
                {rows.length > 1 && (
                  <div className="flex items-center gap-2">
                    <h2 className="text-[13px] font-semibold text-foreground">{row.currency}</h2>
                    <Badge tone="outline">one row per currency</Badge>
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric
                    icon={Banknote}
                    label="Billed"
                    value={money(row.billed)}
                    hint={`${money(row.collected)} collected`}
                  />
                  <Metric
                    icon={ArrowDownRight}
                    label="Outstanding AR"
                    value={money(row.outstanding_ar)}
                    hint="Clients owe us"
                    tone={Number(row.outstanding_ar) > 0 ? "warn" : undefined}
                  />
                  <Metric
                    icon={ArrowUpRight}
                    label="Costs outstanding"
                    value={money(row.publisher_costs_outstanding)}
                    hint="We owe publishers"
                  />
                  <Metric
                    icon={Wallet}
                    label="Payouts outstanding"
                    value={money(row.writer_payouts_outstanding)}
                    hint="We owe writers"
                  />
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric icon={TrendingUp} label="Revenue" value={money(row.revenue)} />
                  <Metric icon={ArrowDownRight} label="Publisher cost" value={money(row.publisher_cost)} />
                  <Metric
                    icon={Percent}
                    label="Gross profit"
                    value={money(row.gross_profit)}
                    hint={row.margin_pct === null ? "no revenue to measure" : `${Number(row.margin_pct).toFixed(2)}% margin`}
                    tone={Number(row.gross_profit) < 0 ? "danger" : "good"}
                  />
                  <Metric
                    icon={Percent}
                    label="Margin"
                    value={row.margin_pct === null ? "—" : `${Number(row.margin_pct).toFixed(2)}%`}
                  />
                </div>
              </div>
            );
          })
        )}

        {/* ---------- per-campaign ---------- */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>Campaign profitability</CardTitle>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void downloadReportExport("/api/v1/reports/campaigns/export", "Campaign Profitability", token, "csv")
              }
            >
              <Download />
              CSV
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            {campaigns.isLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : (campaigns.data ?? []).length === 0 ? (
              <p className="px-4 py-8 text-center text-[12.5px] text-muted">
                No campaigns with pricing or costs yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-[12.5px]">
                  <thead className="border-b border-line bg-surface-sunken/50">
                    <tr className="text-[11px] uppercase tracking-wide text-muted">
                      <th className="px-4 py-2 font-medium">Campaign</th>
                      <th className="px-4 py-2 text-right font-medium">Revenue</th>
                      <th className="px-4 py-2 text-right font-medium">Publisher</th>
                      <th className="px-4 py-2 text-right font-medium">Payouts</th>
                      <th className="px-4 py-2 text-right font-medium">Expenses</th>
                      <th className="px-4 py-2 text-right font-medium">Profit</th>
                      <th className="px-4 py-2 text-right font-medium">Margin</th>
                      <th className="px-4 py-2 font-medium">Priced</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {(campaigns.data ?? []).map((c) => {
                      const money = (v: string | number) => formatInvoiceMoney(v, c.currency);
                      return (
                        <tr key={`${c.campaign_id}-${c.currency}`}>
                          <td className="max-w-[220px] px-4 py-2">
                            <p className="truncate font-medium text-foreground">{c.campaign_name}</p>
                            <p className="truncate text-[11px] text-muted">
                              {c.client_name}
                              {c.multi_currency ? " · multiple currencies" : ""}
                            </p>
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-foreground-soft">{money(c.revenue)}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted">{money(c.publisher_cost)}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted">{money(c.writer_payouts)}</td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted">{money(c.other_expenses)}</td>
                          <td
                            className={cn(
                              "px-4 py-2 text-right tabular-nums font-medium",
                              Number(c.gross_profit) < 0 ? "text-[var(--color-danger)]" : "text-foreground",
                            )}
                          >
                            {money(c.gross_profit)}
                          </td>
                          <td className="px-4 py-2 text-right tabular-nums text-muted">
                            {c.margin_pct === null ? "—" : `${Number(c.margin_pct).toFixed(1)}%`}
                          </td>
                          <td className="px-4 py-2 text-muted">
                            {c.priced_placements}
                            {c.unpriced_placements > 0 && (
                              <span className="ml-1 text-[11px] text-[var(--color-warning)]">
                                +{c.unpriced_placements} unpriced
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {can("payouts:write") && <CostsSection />}
      </PageStack>
    </PageContainer>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  tone?: "good" | "warn" | "danger";
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-1 flex items-center gap-1.5 text-muted">
          <Icon className="size-3.5" aria-hidden />
          <span className="text-[11.5px] font-medium">{label}</span>
        </div>
        <p
          className={cn(
            "text-xl font-semibold tabular-nums",
            tone === "good" && "text-[var(--color-success)]",
            tone === "warn" && "text-[var(--color-warning)]",
            tone === "danger" && "text-[var(--color-danger)]",
            !tone && "text-foreground",
          )}
        >
          {value}
        </p>
        {hint && <p className="mt-0.5 text-[11px] text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/**
 * Payouts and expenses.
 *
 * Only rendered for a role holding `payouts:write` (owner). The API refuses
 * everyone else regardless — this just avoids showing a form that would 403.
 */
function CostsSection() {
  const token = useAccessToken();
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);

  const payouts = useQuery({
    queryKey: ["finance", "payouts"],
    queryFn: async () => {
      const res = await apiRequest<Array<Record<string, unknown>>>(
        `/api/v1/payouts${buildQuery({ limit: 20 })}`,
        { token },
      );
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  const expenses = useQuery({
    queryKey: ["finance", "expenses"],
    queryFn: async () => {
      const res = await apiRequest<Array<Record<string, unknown>>>(
        `/api/v1/expenses${buildQuery({ limit: 20 })}`,
        { token },
      );
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Writer payouts</CardTitle>
          <Button variant="secondary" size="sm" onClick={() => setPayoutOpen(true)}>
            <PlusCircle />
            Add
          </Button>
        </CardHeader>
        <CardContent className="pt-0">
          {payouts.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (payouts.data ?? []).length === 0 ? (
            <p className="text-[12px] text-muted">No payouts recorded.</p>
          ) : (
            <ul className="divide-y divide-line">
              {(payouts.data ?? []).slice(0, 8).map((p) => (
                <li key={String(p.id)} className="flex items-baseline justify-between gap-2 py-1.5 text-[12px]">
                  <span className="min-w-0 truncate text-foreground-soft">
                    {String(p.description ?? p.fee_type ?? "Payout")}
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge tone={p.status === "paid" ? "success" : p.status === "approved" ? "info" : "neutral"}>
                      {String(p.status)}
                    </Badge>
                    <span className="tabular-nums text-muted">
                      {formatInvoiceMoney(Number(p.amount), String(p.currency))}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle>Campaign expenses</CardTitle>
          <Button variant="secondary" size="sm" onClick={() => setExpenseOpen(true)}>
            <PlusCircle />
            Add
          </Button>
        </CardHeader>
        <CardContent className="pt-0">
          {expenses.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (expenses.data ?? []).length === 0 ? (
            <p className="text-[12px] text-muted">No other expenses recorded.</p>
          ) : (
            <ul className="divide-y divide-line">
              {(expenses.data ?? []).slice(0, 8).map((e) => (
                <li key={String(e.id)} className="flex items-baseline justify-between gap-2 py-1.5 text-[12px]">
                  <span className="min-w-0 truncate text-foreground-soft">{String(e.description)}</span>
                  <span className="shrink-0 tabular-nums text-muted">
                    {formatInvoiceMoney(Number(e.amount), String(e.currency))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CostDialog
        open={payoutOpen}
        onOpenChange={setPayoutOpen}
        title="Record a writer payout"
        endpoint="/api/v1/payouts"
        // The campaign is REQUIRED here, not optional.
        //
        // `v_campaign_profitability` groups payouts by `campaign_id`, so a payout
        // saved without one is invisible to the very report this page shows — the
        // money would be spent and never counted. The API allows a null campaign
        // (a bonus can be unattributable), but the form does not offer that, because
        // it silently breaks the number the page exists to display.
        fields={["amount", "campaignId", "description"]}
        requireCampaign
        onSaved={() => void payouts.refetch()}
      />
      <CostDialog
        open={expenseOpen}
        onOpenChange={setExpenseOpen}
        title="Record a campaign expense"
        endpoint="/api/v1/expenses"
        fields={["amount", "campaignId", "description"]}
        onSaved={() => void expenses.refetch()}
      />
    </div>
  );
}

function CostDialog({
  open,
  onOpenChange,
  title,
  endpoint,
  fields,
  requireCampaign = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  endpoint: string;
  fields: Array<"amount" | "description" | "campaignId">;
  requireCampaign?: boolean;
  onSaved: () => void;
}) {
  const token = useAccessToken();
  const [values, setValues] = useState<Record<string, string>>({ amount: "", description: "", campaignId: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const campaigns = useQuery({
    queryKey: ["campaigns", "options"],
    queryFn: async () => {
      const res = await apiRequest<Array<{ id: string; name: string }>>(`/api/v1/campaigns${buildQuery({ limit: 100 })}`, {
        token,
      });
      return res.data ?? [];
    },
    enabled: open && fields.includes("campaignId"),
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        amount: Number(values.amount) || 0,
        description: values.description || undefined,
      };
      if (fields.includes("campaignId")) body.campaignId = values.campaignId;

      await apiRequest(endpoint, { method: "POST", body, token });
      onOpenChange(false);
      setValues({ amount: "", description: "", campaignId: "" });
      onSaved();
    } catch (err) {
      setError((err as { message?: string })?.message ?? "Could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <Dialog.Title className="text-[15px] font-semibold text-foreground">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-[12px] text-muted">
            Internal only — never shown to a client.
          </Dialog.Description>

          <div className="mt-3 space-y-3">
            {fields.includes("campaignId") && (
              <Field label="Campaign">
                <select
                  value={values.campaignId}
                  onChange={(e) => setValues((v) => ({ ...v, campaignId: e.target.value }))}
                  className="flex h-9 w-full rounded-md border border-line bg-surface px-2 text-sm text-foreground"
                >
                  <option value="">Select…</option>
                  {(campaigns.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Amount">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={values.amount}
                onChange={(e) => setValues((v) => ({ ...v, amount: e.target.value }))}
              />
            </Field>

            <Field label="Description">
              <Input
                value={values.description}
                onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
              />
            </Field>

            {error && <p className="text-[12px] text-[var(--color-danger)]">{error}</p>}
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              loading={busy}
              disabled={!Number(values.amount) || (requireCampaign && !values.campaignId)}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
