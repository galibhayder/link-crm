import { useQuery } from "@tanstack/react-query";
import { CreditCard } from "lucide-react";
import { Link } from "react-router-dom";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, PageHeading, Skeleton } from "@/components/ui/card";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAccessToken } from "@/providers/auth";
import { apiRequest, buildQuery } from "@/lib/api";
import { humanize } from "@/lib/utils";
import { formatInvoiceMoney, invoiceErrorMessage } from "@/features/invoices/use-invoices";

/**
 * PAYMENTS LEDGER.
 *
 * A chronological list of money received, with a link back to the invoice it
 * settled. Read-only: recording happens on the invoice, where the balance being
 * paid against is visible. A standalone "record payment" form here would need an
 * invoice picker and would let someone pay an invoice they never looked at.
 */

interface PaymentRow {
  id: string;
  amount: string | number;
  currency: string;
  method: string;
  reference: string | null;
  received_at: string;
  invoice?: { id: string; invoice_number: string; total: string | number } | null;
}

export function PaymentsPage() {
  const token = useAccessToken();

  const payments = useQuery({
    queryKey: ["payments", "list"],
    queryFn: async () => {
      const res = await apiRequest<PaymentRow[]>(`/api/v1/payments${buildQuery({ limit: 100 })}`, { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  if (payments.isError) {
    return (
      <PageContainer>
        <PageStack>
          <PageHeading title="Payments" />
          <ErrorState description={invoiceErrorMessage(payments.error)} onRetry={() => void payments.refetch()} />
        </PageStack>
      </PageContainer>
    );
  }

  const rows = payments.data ?? [];
  const totalByCurrency = rows.reduce<Record<string, number>>((acc, p) => {
    acc[p.currency] = (acc[p.currency] ?? 0) + Number(p.amount);
    return acc;
  }, {});

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Payments"
          description="Money received, newest first. Payments are recorded on the invoice they settle."
        />

        {Object.keys(totalByCurrency).length > 0 && (
          <div className="flex flex-wrap gap-3">
            {Object.entries(totalByCurrency).map(([currency, total]) => (
              <Card key={currency}>
                <CardContent className="p-3.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted">Collected ({currency})</p>
                  <p className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                    {formatInvoiceMoney(total, currency)}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {payments.isLoading ? (
          <Card>
            <CardContent className="space-y-2 p-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </CardContent>
          </Card>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={CreditCard}
            title="No payments recorded"
            description="Record a payment from an invoice, and it appears here."
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-[12.5px]">
                  <thead className="border-b border-line bg-surface-sunken/60">
                    <tr className="text-[11px] uppercase tracking-wide text-muted">
                      <th className="px-4 py-2 font-medium">Received</th>
                      <th className="px-4 py-2 font-medium">Invoice</th>
                      <th className="px-4 py-2 font-medium">Method</th>
                      <th className="px-4 py-2 font-medium">Reference</th>
                      <th className="px-4 py-2 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((p) => (
                      <tr key={p.id}>
                        <td className="whitespace-nowrap px-4 py-2 text-muted">
                          {new Date(p.received_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-2">
                          {p.invoice ? (
                            <Link
                              to={`/invoices/${p.invoice.id}`}
                              className="font-medium text-brand-600 hover:underline"
                            >
                              {p.invoice.invoice_number}
                            </Link>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <Badge tone="neutral">{humanize(p.method)}</Badge>
                        </td>
                        <td className="max-w-[180px] truncate px-4 py-2 text-muted">{p.reference ?? "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums font-medium text-foreground-soft">
                          {formatInvoiceMoney(p.amount, p.currency)}
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
    </PageContainer>
  );
}
