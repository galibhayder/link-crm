import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, PageHeading } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { ErrorState } from "@/components/ui/states";
import { useAccessToken } from "@/providers/auth";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { formatInvoiceMoney, invoiceErrorMessage } from "./use-invoices";

/**
 * NEW INVOICE.
 *
 * The list of inputs is deliberately short. An invoice is a document with a
 * client, a period, a tax rate and some lines — everything else (number, totals,
 * due date) is derived by the server, and letting a user type those in is how
 * invoices disagree with their own line items.
 *
 * Totals are shown live as a PREVIEW, computed the same way the database does
 * (discount before tax). They are not submitted; the server recomputes.
 */

interface LineDraft {
  description: string;
  quantity: string;
  unitPrice: string;
}

interface ClientOption {
  id: string;
  name: string;
}

const emptyLine = (): LineDraft => ({ description: "", quantity: "1", unitPrice: "" });

export function InvoiceEditorPage() {
  const navigate = useNavigate();
  const token = useAccessToken();

  const [clientId, setClientId] = useState("");
  const [periodStart, setPeriodStart] = useState(firstOfMonth());
  const [periodEnd, setPeriodEnd] = useState(lastOfMonth());
  const [dueDate, setDueDate] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [taxRate, setTaxRate] = useState("0");
  const [discount, setDiscount] = useState("0");
  const [notes, setNotes] = useState("");
  const [paymentInstructions, setPaymentInstructions] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);

  const clients = useQuery({
    queryKey: ["clients", "options"],
    queryFn: async () => {
      const res = await apiRequest<ClientOption[]>(`/api/v1/clients${buildQuery({ limit: 100 })}`, { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  // Mirrors `recompute_invoice_totals`: discount is clamped, tax applies to the
  // discounted base. If this ever diverges, the totals here are a preview and the
  // saved invoice wins — but a discrepancy would still be a bug worth catching.
  const subtotal = lines.reduce((sum, l) => {
    const q = Number(l.quantity) || 0;
    const p = Number(l.unitPrice) || 0;
    return sum + Math.round(q * p * 100) / 100;
  }, 0);
  const discountValue = Math.min(Math.max(Number(discount) || 0, 0), subtotal);
  const taxable = subtotal - discountValue;
  const taxAmount = Math.round(taxable * (Number(taxRate) || 0)) / 100;
  const total = Math.round((taxable + taxAmount) * 100) / 100;

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest<{ id: string }>("/api/v1/invoices", {
        method: "POST",
        body: {
          clientId,
          periodStart,
          periodEnd,
          taxRate: Number(taxRate) || 0,
          discountAmount: Number(discount) || 0,
          currency,
          dueDate: dueDate || undefined,
          notes: notes || undefined,
          paymentInstructions: paymentInstructions || undefined,
          lineItems: lines
            .filter((l) => l.description.trim())
            .map((l) => ({
              description: l.description.trim(),
              quantity: Number(l.quantity) || 1,
              unitPrice: Number(l.unitPrice) || 0,
            })),
        },
        token,
      });
      return res.data;
    },
    onSuccess: (data) => {
      if (data?.id) navigate(`/invoices/${data.id}`);
    },
    onError: (err) => setError((err as ApiError)?.message ?? "Could not create the invoice"),
  });

  const valid =
    Boolean(clientId) &&
    lines.some((l) => l.description.trim() && Number(l.unitPrice) > 0) &&
    !create.isPending;

  if (clients.isError) {
    return (
      <PageContainer>
        <PageStack>
          <PageHeading title="New invoice" />
          <ErrorState description={invoiceErrorMessage(clients.error)} onRetry={() => void clients.refetch()} />
        </PageStack>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="New invoice"
          description="The invoice number, totals and due date are assigned when you save."
        />

        {error && (
          <div
            role="alert"
            className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-danger)]"
          >
            {error}
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Billing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <Field label="Client">
                  <select
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className="flex h-9 w-full rounded-md border border-line bg-surface px-2 text-sm text-foreground"
                  >
                    <option value="">Select a client…</option>
                    {(clients.data ?? []).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Period start">
                    <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
                  </Field>
                  <Field label="Period end">
                    <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
                  </Field>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Due date" hint="Blank uses the client's terms.">
                    <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                  </Field>
                  <Field label="Currency">
                    <Input
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                      maxLength={3}
                      placeholder="USD"
                    />
                  </Field>
                  <Field label="Tax rate %">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={taxRate}
                      onChange={(e) => setTaxRate(e.target.value)}
                    />
                  </Field>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>Line items</CardTitle>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setLines((prev) => [...prev, emptyLine()])}
                >
                  <Plus />
                  Add line
                </Button>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                {lines.map((line, index) => (
                  <div key={index} className="flex flex-wrap items-end gap-2">
                    <div className="min-w-[160px] flex-1">
                      <Input
                        value={line.description}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, description: e.target.value } : l)),
                          )
                        }
                        placeholder="Guest post on example.test"
                        aria-label={`Description for line ${index + 1}`}
                      />
                    </div>
                    <div className="w-16">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.quantity}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, quantity: e.target.value } : l)),
                          )
                        }
                        aria-label={`Quantity for line ${index + 1}`}
                      />
                    </div>
                    <div className="w-28">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={line.unitPrice}
                        onChange={(e) =>
                          setLines((prev) =>
                            prev.map((l, i) => (i === index ? { ...l, unitPrice: e.target.value } : l)),
                          )
                        }
                        placeholder="0.00"
                        aria-label={`Unit price for line ${index + 1}`}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove line ${index + 1}`}
                      disabled={lines.length === 1}
                      onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 pt-0">
                <Field label="Payment instructions" hint="Shown to the client on the invoice.">
                  <textarea
                    value={paymentInstructions}
                    onChange={(e) => setPaymentInstructions(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-line bg-surface p-2 text-[12.5px] text-foreground"
                  />
                </Field>
                <Field label="Internal notes">
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className="w-full rounded-md border border-line bg-surface p-2 text-[12.5px] text-foreground"
                  />
                </Field>
              </CardContent>
            </Card>
          </div>

          {/* ---------- live totals ---------- */}
          <div className="space-y-3">
            <Card>
              <CardHeader>
                <CardTitle>Totals</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0 text-[12.5px]">
                <TotalRow label="Subtotal" value={formatInvoiceMoney(subtotal, currency)} />
                <Field label="Discount">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={discount}
                    onChange={(e) => setDiscount(e.target.value)}
                  />
                </Field>
                <TotalRow label={`Tax (${Number(taxRate) || 0}%)`} value={formatInvoiceMoney(taxAmount, currency)} />
                <div className="border-t border-line pt-2">
                  <TotalRow label="Total" value={formatInvoiceMoney(total, currency)} strong />
                </div>
                <p className="pt-1 text-[11px] leading-relaxed text-muted">
                  Tax is applied after the discount. The server recalculates these figures when
                  the invoice is saved.
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-2 p-3.5">
                <Button className="w-full" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
                  Create draft invoice
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
                  onClick={() => navigate("/invoices")}
                >
                  Cancel
                </Button>
                {!clientId && <Badge tone="neutral">Select a client to continue</Badge>}
              </CardContent>
            </Card>
          </div>
        </div>
      </PageStack>
    </PageContainer>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? "font-medium text-foreground" : "text-muted"}>{label}</span>
      <span className={strong ? "font-semibold tabular-nums text-foreground" : "tabular-nums text-foreground-soft"}>
        {value}
      </span>
    </div>
  );
}

function firstOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}

function lastOfMonth(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
}
