import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FileText, Plus, Search } from "lucide-react";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, PageHeading, Skeleton } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAuth } from "@/providers/auth";
import { useOptionalUiConfig } from "@/providers/ui-config";
import { cn } from "@/lib/utils";
import {
  type InvoiceSummary,
  INVOICE_STATUS,
  formatInvoiceMoney,
  invoiceErrorMessage,
  useInvoices,
} from "./use-invoices";

/**
 * COLUMN REGISTRY.
 *
 * The Admin panel can choose and order the invoice columns, so the table is built
 * from this list rather than hand-written JSX. Two properties follow:
 *
 *   - the keys match `MODULE_COLUMNS["/invoices"]` in @crm/shared, so a config can
 *     only name a column that exists here;
 *   - a renderer lives beside its header, so a column cannot be added to the
 *     picker without deciding what it shows.
 *
 * The defaults are the original six, so an unconfigured organisation sees exactly
 * the table it saw before this phase.
 */
type ColumnKey = "invoice_number" | "client_name" | "effective_status" | "total" | "balance" | "due_date";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  align?: "right";
  render: (inv: InvoiceSummary, meta: { label: string; tone: BadgeTone }) => React.ReactNode;
}

type BadgeTone = "neutral" | "brand" | "success" | "warning" | "danger" | "info" | "outline";

const COLUMNS: ColumnDef[] = [
  {
    key: "invoice_number",
    label: "Invoice",
    render: (inv) => (
      <Link to={`/invoices/${inv.id}`} className="whitespace-nowrap font-medium text-brand-600 hover:underline">
        {inv.invoice_number}
      </Link>
    ),
  },
  {
    key: "client_name",
    label: "Client",
    render: (inv) => (
      <span className="block max-w-[200px] truncate text-foreground-soft">
        {inv.client_name ?? inv.agency_partner_name ?? "—"}
      </span>
    ),
  },
  {
    key: "effective_status",
    label: "Status",
    render: (_inv, meta) => <Badge tone={meta.tone}>{meta.label}</Badge>,
  },
  {
    key: "total",
    label: "Total",
    align: "right",
    render: (inv) => <span className="text-foreground-soft">{formatInvoiceMoney(inv.total, inv.currency)}</span>,
  },
  {
    key: "balance",
    label: "Balance",
    align: "right",
    render: (inv) => (
      <span
        className={
          Number(inv.balance) > 0 && inv.effective_status === "overdue"
            ? "font-medium text-[var(--color-danger)]"
            : "text-foreground-soft"
        }
      >
        {formatInvoiceMoney(inv.balance, inv.currency)}
      </span>
    ),
  },
  {
    key: "due_date",
    label: "Due",
    render: (inv) => (
      <span className="whitespace-nowrap text-muted">
        {inv.due_date ? new Date(inv.due_date).toLocaleDateString() : "—"}
        {inv.days_overdue > 0 && Number(inv.balance) > 0 && (
          <span className="ml-1.5 text-[11px] text-[var(--color-danger)]">{inv.days_overdue}d late</span>
        )}
      </span>
    ),
  },
];

const DEFAULT_COLUMNS: ColumnKey[] = COLUMNS.map((c) => c.key);

/**
 * INVOICE LIST.
 *
 * Filters run client-side over a page of invoices rather than round-tripping for
 * every keystroke. The list is capped at 100 by the API, and an agency has tens of
 * invoices, not tens of thousands — a server-side search would be complexity with
 * no benefit at this size, and would make typing feel laggy.
 */
export function InvoicesPage() {
  const { can } = useAuth();
  const invoices = useInvoices();
  const ui = useOptionalUiConfig();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");

  const rows = invoices.data ?? [];

  // Configured columns, in the configured order. Falls back to the defaults when
  // no config exists, and ignores any key the registry does not know.
  const visibleColumns = useMemo<ColumnDef[]>(() => {
    const configured = ui?.config.tables?.["/invoices"]?.columns as ColumnKey[] | undefined;
    if (!configured || configured.length === 0) return COLUMNS;

    const ordered = configured
      .map((key) => COLUMNS.find((c) => c.key === key))
      .filter((c): c is ColumnDef => Boolean(c));

    // A config naming only unknown keys would render an empty table, so fall back
    // rather than showing a header-less shell.
    return ordered.length > 0 ? ordered : COLUMNS;
  }, [ui?.config.tables]);

  const counts = useMemo(() => {
    const by = (s: string) => rows.filter((r) => r.effective_status === s).length;
    return {
      all: rows.length,
      draft: by("draft"),
      issued: by("issued") + by("published"),
      paid: by("paid"),
      partially_paid: by("partially_paid"),
      overdue: by("overdue"),
    };
  }, [rows]);

  /**
   * Outstanding, PER CURRENCY.
   *
   * Summing across currencies and formatting with `rows[0].currency` produced a
   * single confident-looking number that was simply wrong the moment an agency
   * billed in two currencies — USD 500 + EUR 400 does not equal USD 900. There are
   * no FX rates here, so the honest presentation is one figure per code.
   */
  const outstandingByCurrency = useMemo(() => {
    const totals: Record<string, number> = {};
    for (const r of rows) {
      if (!["issued", "published", "partially_paid", "overdue"].includes(r.effective_status)) continue;
      const balance = Number(r.balance ?? 0);
      if (balance <= 0) continue;
      totals[r.currency] = (totals[r.currency] ?? 0) + balance;
    }
    return totals;
  }, [rows]);

  const outstandingEntries = Object.entries(outstandingByCurrency);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all") {
        // "Issued" covers published too — a client does not distinguish them.
        const bucket = r.effective_status === "published" ? "issued" : r.effective_status;
        if (bucket !== filter) return false;
      }
      if (!q) return true;
      return (
        r.invoice_number.toLowerCase().includes(q) ||
        (r.client_name ?? "").toLowerCase().includes(q)
      );
    });
  }, [rows, query, filter]);

  const FILTERS = [
    { key: "all", label: "All", count: counts.all },
    { key: "draft", label: "Draft", count: counts.draft },
    { key: "issued", label: "Issued", count: counts.issued },
    { key: "partially_paid", label: "Part paid", count: counts.partially_paid },
    { key: "overdue", label: "Overdue", count: counts.overdue },
    { key: "paid", label: "Paid", count: counts.paid },
  ];

  if (invoices.isError) {
    return (
      <PageContainer>
        <PageStack>
          <PageHeading title="Invoices" />
          <ErrorState description={invoiceErrorMessage(invoices.error)} onRetry={() => void invoices.refetch()} />
        </PageStack>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Invoices"
          description="Client invoices, their payment state, and what is outstanding."
          actions={
            can("invoices:write") ? (
              <Button size="sm" asChild>
                <Link to="/invoices/new">
                  <Plus />
                  New invoice
                </Link>
              </Button>
            ) : undefined
          }
        />

        {outstandingEntries.length > 0 && (
          <Card>
            <CardContent className="flex flex-wrap items-baseline gap-x-6 gap-y-2 p-4">
              <span className="text-[12px] font-medium uppercase tracking-wide text-muted">Outstanding</span>
              {outstandingEntries.map(([currency, total]) => (
                <span key={currency} className="flex items-baseline gap-2">
                  <span className="text-xl font-semibold tabular-nums text-foreground">
                    {formatInvoiceMoney(total, currency)}
                  </span>
                  {outstandingEntries.length > 1 && (
                    <span className="text-[11px] uppercase tracking-wide text-muted">{currency}</span>
                  )}
                </span>
              ))}
              <span className="text-[12px] text-muted">
                across{" "}
                {rows.filter((r) => Number(r.balance) > 0 && r.effective_status !== "cancelled").length}{" "}
                invoices
              </span>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted"
              aria-hidden
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search number or client…"
              className="pl-8"
              aria-label="Search invoices"
            />
          </div>

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
                <span className="ml-1.5 tabular-nums opacity-70">{f.count}</span>
              </button>
            ))}
          </div>
        </div>

        {invoices.isLoading ? (
          <Card>
            <CardContent className="space-y-3 p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </CardContent>
          </Card>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={rows.length === 0 ? "No invoices yet" : "Nothing matches that filter"}
            description={
              rows.length === 0
                ? "Create an invoice to bill a client for the links you have placed."
                : "Try a different status, or clear the search."
            }
            action={
              rows.length === 0 && can("invoices:write") ? (
                <Button size="sm" asChild>
                  <Link to="/invoices/new">
                    <Plus />
                    New invoice
                  </Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-[12.5px]">
                  <thead className="border-b border-line bg-surface-sunken/60">
                    <tr className="text-[11px] uppercase tracking-wide text-muted">
                      {visibleColumns.map((col) => (
                        <th
                          key={col.key}
                          className={cn("px-4 py-2 font-medium", col.align === "right" && "text-right")}
                        >
                          {col.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {filtered.map((inv) => {
                      const meta = INVOICE_STATUS[inv.effective_status] ?? {
                        label: inv.effective_status,
                        tone: "neutral" as const,
                      };
                      return (
                        <tr key={inv.id} className="transition hover:bg-surface-sunken/50">
                          {visibleColumns.map((col) => (
                            <td
                              key={col.key}
                              className={cn(
                                "px-4 py-2.5",
                                col.align === "right" && "whitespace-nowrap text-right tabular-nums",
                              )}
                            >
                              {col.render(inv, meta)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}
      </PageStack>
    </PageContainer>
  );
}
