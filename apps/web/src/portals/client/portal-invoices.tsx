import { useQuery } from "@tanstack/react-query";
import { Download, FileText } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Skeleton } from "@/components/ui/card";
import { useAccessToken } from "@/providers/auth";
import { apiRequest } from "@/lib/api";
import { formatInvoiceMoney } from "@/features/invoices/use-invoices";
import { PortalPageHeading } from "./portal-shell";
import { portalErrorMessage } from "./use-portal";

/**
 * CLIENT INVOICES.
 *
 * A client sees their own invoices and nothing else — RLS on `v_invoices` decides
 * that, not this component. The API projection is an allow-list, so cost, margin
 * and internal notes are not merely hidden here, they were never sent.
 *
 * Downloads go through the PORTAL pdf route, because the internal one rejects a
 * client token at the surface boundary.
 */

interface PortalInvoice {
  id: string;
  invoice_number: string;
  effective_status: string;
  currency: string;
  total: string | number;
  paid_amount: string | number;
  balance: string | number;
  due_date: string | null;
  issued_at: string | null;
  period_start: string;
  period_end: string;
  days_overdue: number;
}

const STATUS: Record<string, { label: string; tone: "neutral" | "brand" | "success" | "warning" | "danger" | "outline" | "info" }> = {
  draft: { label: "Draft", tone: "neutral" },
  issued: { label: "Issued", tone: "info" },
  published: { label: "Issued", tone: "info" },
  partially_paid: { label: "Part paid", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  overdue: { label: "Overdue", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "outline" },
};

export function PortalInvoicesPage() {
  const token = useAccessToken();

  const invoices = useQuery({
    queryKey: ["portal", "invoices"],
    queryFn: async () => {
      const res = await apiRequest<PortalInvoice[]>("/portal/v1/invoices", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  const download = async (inv: PortalInvoice) => {
    const res = await fetch(`/portal/v1/invoices/${inv.id}/pdf`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return;

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Invoice-${inv.invoice_number}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  // The API already excludes drafts and cancelled invoices (see the portal
  // invoices route). No client-side filter: a filter here would mask a regression
  // in the API rather than prevent it, so the list renders exactly what was sent.
  const visible = invoices.data ?? [];

  if (invoices.isError) {
    return (
      <>
        <PortalPageHeading title="Invoices" />
        <ErrorState description={portalErrorMessage(invoices.error)} onRetry={() => void invoices.refetch()} />
      </>
    );
  }

  return (
    <>
      <PortalPageHeading
        title="Invoices"
        description="Your invoices, what has been paid, and what is outstanding."
      />

      {invoices.isLoading ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Card key={i}>
              <CardContent className="space-y-2 p-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No invoices yet"
          description="When we bill you for work delivered, the invoice appears here."
        />
      ) : (
        <div className="space-y-2">
          {visible.map((inv) => {
            const meta = STATUS[inv.effective_status] ?? { label: inv.effective_status, tone: "neutral" as const };
            const money = (v: string | number) => formatInvoiceMoney(v, inv.currency);
            const outstanding = Number(inv.balance) > 0;

            return (
              <Card key={inv.id}>
                <CardContent className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-[13px] font-semibold text-foreground">{inv.invoice_number}</p>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                      <p className="mt-0.5 text-[11.5px] text-muted">
                        {new Date(inv.period_start).toLocaleDateString()} –{" "}
                        {new Date(inv.period_end).toLocaleDateString()}
                        {inv.due_date ? ` · due ${new Date(inv.due_date).toLocaleDateString()}` : ""}
                        {inv.days_overdue > 0 && outstanding ? ` · ${inv.days_overdue} days late` : ""}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-3">
                      <div className="text-right">
                        <p className="text-[13px] font-semibold tabular-nums text-foreground">{money(inv.total)}</p>
                        {outstanding && (
                          <p className="text-[11px] tabular-nums text-muted">{money(inv.balance)} outstanding</p>
                        )}
                      </div>
                      <Button variant="secondary" size="sm" onClick={() => void download(inv)}>
                        <Download />
                        PDF
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
