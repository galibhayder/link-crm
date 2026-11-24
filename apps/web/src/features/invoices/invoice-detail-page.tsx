import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  Eye,
  ExternalLink,
  FileText,
  Link2,
  PlusCircle,
  Send,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, PageHeading, Separator, Skeleton } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useAccessToken, useAuth } from "@/providers/auth";
import { cn, formatRelative, humanize } from "@/lib/utils";
import {
  INVOICE_STATUS,
  downloadInvoicePdf,
  formatInvoiceMoney,
  invoiceErrorMessage,
  useInvoice,
  useInvoiceActions,
  useInvoicePayments,
  useInvoicePreview,
} from "./use-invoices";

/**
 * INVOICE DETAIL.
 *
 * The action bar is the feature. Everything a user can do to an invoice is here,
 * and each action's availability is derived from the invoice's actual state and
 * the caller's permissions — a button that 400s is worse than an absent one.
 *
 * PUBLISH IS NEVER AUTOMATIC. It sits behind its own confirmation dialog that
 * says, plainly, that the link becomes publicly reachable. Issuing is internal
 * bookkeeping; publishing is a disclosure decision.
 */
export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const token = useAccessToken();
  const { can } = useAuth();

  const invoice = useInvoice(id);
  const payments = useInvoicePayments(id);
  const actions = useInvoiceActions();

  const [previewOpen, setPreviewOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [shareInfo, setShareInfo] = useState<{ url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (invoice.isLoading) {
    return (
      <PageContainer>
        <PageStack>
          <Skeleton className="h-8 w-56" />
          <Card>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-24 w-full" />
            </CardContent>
          </Card>
        </PageStack>
      </PageContainer>
    );
  }

  if (invoice.isError || !invoice.data) {
    return (
      <PageContainer>
        <PageStack>
          <PageHeading title="Invoice" />
          <ErrorState
            description={invoice.isError ? invoiceErrorMessage(invoice.error) : "This invoice does not exist."}
            onRetry={() => void invoice.refetch()}
          />
        </PageStack>
      </PageContainer>
    );
  }

  const inv = invoice.data;
  const meta = INVOICE_STATUS[inv.effective_status] ?? { label: inv.effective_status, tone: "neutral" as const };
  const money = (v: string | number) => formatInvoiceMoney(v, inv.currency);

  const isDraft = inv.status === "draft";
  const isCancelled = inv.status === "cancelled";
  const hasPayments = Number(inv.paid_amount) > 0;
  const canWrite = can("invoices:write");
  const canShare = can("invoices:share");

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(label);
      await invoice.refetch();
    } catch (err) {
      setError(invoiceErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // A public URL is built on the app origin, so a copied link works for anyone.
  const publicUrl = shareInfo?.url ? `${window.location.origin}${shareInfo.url}` : null;
  const privateUrl = `${window.location.origin}/invoices/${inv.id}`;

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(`${what} copied to the clipboard`);
    } catch {
      setError("Could not access the clipboard. Select the link and copy it manually.");
    }
  };

  return (
    <PageContainer>
      <PageStack>
        <Link
          to="/invoices"
          className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          All invoices
        </Link>

        <PageHeading
          title={inv.invoice_number}
          description={`${inv.client_name ?? "Client"} · ${inv.period_start} to ${inv.period_end}`}
          actions={<Badge tone={meta.tone}>{meta.label}</Badge>}
        />

        {done && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-success)]"
          >
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{done}</p>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-danger)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        {/* ---------- action bar ---------- */}
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 p-3">
            <Button variant="secondary" size="sm" onClick={() => setPreviewOpen(true)}>
              <Eye />
              Preview
            </Button>

            <Button
              variant="secondary"
              size="sm"
              loading={busy}
              onClick={() =>
                void run("PDF downloaded", () => downloadInvoicePdf(inv.id, inv.invoice_number, token))
              }
            >
              <Download />
              Download PDF
            </Button>

            {isDraft && canWrite && (
              <Button
                size="sm"
                loading={busy}
                onClick={() => void run("Invoice issued", () => actions.issue.mutateAsync(inv.id))}
              >
                <Send />
                Issue invoice
              </Button>
            )}

            {!isDraft && !isCancelled && canShare && (
              <>
                <Button
                  variant={inv.published_at ? "secondary" : "primary"}
                  size="sm"
                  onClick={() => setPublishOpen(true)}
                >
                  <ExternalLink />
                  {inv.published_at ? "Republish" : "Publish invoice"}
                </Button>

                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy}
                  onClick={() =>
                    void run("Public link created", async () => {
                      const link = await actions.createShareLink.mutateAsync({ id: inv.id });
                      setShareInfo({ url: link.url });
                      await navigator.clipboard.writeText(`${window.location.origin}${link.url}`).catch(() => {});
                    })
                  }
                >
                  <Link2 />
                  {inv.share?.active ? "Rotate public link" : "Create public link"}
                </Button>
              </>
            )}

            {inv.share?.active && (
              <Button
                variant="ghost"
                size="sm"
                loading={busy}
                onClick={() => void run("Public link revoked", () => actions.revokeShareLink.mutateAsync(inv.id))}
              >
                <X />
                Revoke public link
              </Button>
            )}

            <Button variant="secondary" size="sm" onClick={() => void copy(privateUrl, "Private link")}>
              <Copy />
              Copy private link
            </Button>

            {!isCancelled && canWrite && (
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={() =>
                  void run("Invoice duplicated", async () => {
                    const copy = await actions.duplicate.mutateAsync(inv.id);
                    if (copy?.id) navigate(`/invoices/${copy.id}`);
                  })
                }
              >
                <PlusCircle />
                Duplicate
              </Button>
            )}

            {!isCancelled && !hasPayments && canWrite && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto text-[var(--color-danger)]"
                onClick={() =>
                  void run("Invoice cancelled", () => actions.cancelInvoice.mutateAsync(inv.id))
                }
              >
                <Trash2 />
                Cancel invoice
              </Button>
            )}
          </CardContent>
        </Card>

        {/* ---------- share status ---------- */}
        <SharePanel
          invoice={inv}
          publicUrl={publicUrl}
          onCopy={() => publicUrl && void copy(publicUrl, "Public link")}
          canShare={canShare}
        />

        {/*
          `min-w-0` on the grid columns is load-bearing.
          
          A grid item defaults to `min-width: auto`, which means it refuses to
          shrink below its content — so the 480px-wide line-items table pushed the
          column wider than the viewport and the whole PAGE scrolled sideways,
          defeating the `overflow-x-auto` around the table. Without the inner
          scroll container the table's minimum width escapes to the page.
        */}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* ---------- document ---------- */}
          <Card className="min-w-0">
            <CardContent className="min-w-0 p-0">
              <div className="border-b border-line px-5 py-3">
                <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">Line items</h2>
              </div>

              {(inv.line_items ?? []).length === 0 ? (
                <p className="px-5 py-8 text-center text-[12.5px] text-muted">This invoice has no line items.</p>
              ) : (
                <div className="w-full overflow-x-auto">
                  <table className="w-full min-w-[440px] text-left text-[12.5px]">
                    <thead className="border-b border-line bg-surface-sunken/40">
                      <tr className="text-[11px] uppercase tracking-wide text-muted">
                        <th className="px-5 py-2 font-medium">Description</th>
                        <th className="px-3 py-2 text-right font-medium">Qty</th>
                        <th className="px-3 py-2 text-right font-medium">Unit</th>
                        <th className="px-5 py-2 text-right font-medium">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {(inv.line_items ?? []).map((line, i) => (
                        <tr key={line.id ?? i}>
                          <td className="px-5 py-2 text-foreground-soft">{line.description}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">{Number(line.quantity)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted">
                            {money(line.unit_price)}
                          </td>
                          <td className="px-5 py-2 text-right tabular-nums text-foreground-soft">
                            {money(line.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="border-t border-line px-5 py-3">
                <dl className="ml-auto max-w-xs space-y-1.5 text-[12.5px]">
                  <Row label="Subtotal" value={money(inv.subtotal)} />
                  {Number(inv.discount_amount) > 0 && (
                    <Row label="Discount" value={`−${money(inv.discount_amount)}`} />
                  )}
                  {Number(inv.tax_amount) > 0 && (
                    <Row label={`Tax (${Number(inv.tax_rate)}%)`} value={money(inv.tax_amount)} />
                  )}
                  <Separator />
                  <Row label="Total" value={money(inv.total)} strong />
                  {Number(inv.paid_amount) > 0 && (
                    <Row label="Payments received" value={`−${money(inv.paid_amount)}`} />
                  )}
                  {!isDraft && (
                    <Row
                      label="Balance due"
                      value={money(inv.balance)}
                      strong
                      tone={Number(inv.balance) > 0 && inv.effective_status === "overdue" ? "danger" : undefined}
                    />
                  )}
                </dl>
              </div>

              {(inv.notes || inv.payment_instructions) && (
                <div className="space-y-3 border-t border-line px-5 py-3">
                  {inv.payment_instructions && (
                    <div>
                      <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">
                        Payment instructions
                      </p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-foreground-soft">
                        {inv.payment_instructions}
                      </p>
                    </div>
                  )}
                  {inv.notes && (
                    <div>
                      <p className="text-[10.5px] font-medium uppercase tracking-wide text-muted">Notes</p>
                      <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] text-foreground-soft">{inv.notes}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* ---------- payments ---------- */}
          <div className="min-w-0 space-y-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <CardTitle>Payments</CardTitle>
                {!isDraft && !isCancelled && can("payments:write") && (
                  <Button size="sm" variant="secondary" onClick={() => setPaymentOpen(true)}>
                    Record
                  </Button>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                {payments.isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : (payments.data ?? []).length === 0 ? (
                  <p className="text-[12px] text-muted">No payments recorded.</p>
                ) : (
                  <ul className="space-y-2">
                    {(payments.data ?? []).map((p) => (
                      <li key={p.id} className="flex items-start justify-between gap-2 text-[12px]">
                        <div className="min-w-0">
                          <p className="font-medium tabular-nums text-foreground-soft">
                            {formatInvoiceMoney(p.amount, p.currency)}
                          </p>
                          <p className="text-[11px] text-muted">
                            {humanize(p.method)} · {formatRelative(p.received_at)}
                            {p.reference ? ` · ${p.reference}` : ""}
                          </p>
                        </div>
                        {can("payments:write") && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Reverse this payment"
                            loading={busy}
                            onClick={() =>
                              void run("Payment reversed", () => actions.reversePayment.mutateAsync(p.id))
                            }
                          >
                            <Undo2 />
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5 pt-0 text-[12px]">
                <Row label="Issued" value={inv.issued_at ? new Date(inv.issued_at).toLocaleDateString() : "Not yet"} />
                <Row label="Due" value={inv.due_date ? new Date(inv.due_date).toLocaleDateString() : "—"} />
                <Row label="Currency" value={inv.currency} />
                <Row label="Version" value={`v${inv.snapshot_version}`} />
                {inv.agency_partner_name && <Row label="Partner" value={inv.agency_partner_name} />}
              </CardContent>
            </Card>
          </div>
        </div>
      </PageStack>

      <PreviewDialog open={previewOpen} onOpenChange={setPreviewOpen} invoiceId={inv.id} />

      <ConfirmDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        title="Publish this invoice?"
        body="Publishing allows anyone holding the public link to view this invoice without signing in. Internal costs, writer payouts and margins are never included."
        confirmLabel="Publish"
        busy={busy}
        onConfirm={async () => {
          await run("Invoice published", async () => {
            await actions.publish.mutateAsync(inv.id);
            const link = await actions.createShareLink.mutateAsync({ id: inv.id });
            setShareInfo({ url: link.url });
            setPublishOpen(false);
          });
        }}
      />

      <PaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        balance={Number(inv.balance)}
        currency={inv.currency}
        busy={busy}
        onSubmit={async (amount, method, reference) => {
          await run("Payment recorded", () =>
            actions.recordPayment.mutateAsync({ invoiceId: inv.id, amount, method, reference }),
          );
          setPaymentOpen(false);
        }}
      />
    </PageContainer>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "danger";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={cn("text-muted", strong && "font-medium text-foreground")}>{label}</dt>
      <dd
        className={cn(
          "tabular-nums",
          strong ? "font-semibold text-foreground" : "text-foreground-soft",
          tone === "danger" && "text-[var(--color-danger)]",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * Share state, stated explicitly.
 *
 * "Is this invoice public?" must never be inferred from the status badge: an
 * invoice can be issued, paid and still public. This panel answers the question
 * directly, including when a link expires and when it was last opened.
 */
function SharePanel({
  invoice,
  publicUrl,
  onCopy,
  canShare,
}: {
  invoice: { effective_status: string; published_at: string | null; share?: { active: boolean; expires_at: string | null; links: Array<{ revoked_at: string | null; access_count: number; last_accessed_at: string | null }> } };
  publicUrl: string | null;
  onCopy: () => void;
  canShare: boolean;
}) {
  const share = invoice.share;
  const active = share?.active ?? false;
  const revoked = (share?.links ?? []).filter((l) => l.revoked_at).length;
  const totalAccess = (share?.links ?? []).reduce((s, l) => s + (l.access_count ?? 0), 0);

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              active ? "bg-[var(--color-success)]" : "bg-[var(--color-muted, #9ca3af)]",
            )}
            aria-hidden
          />
          <p className="text-[12.5px] font-medium text-foreground">
            {active ? "Public link active" : "Private only"}
          </p>
        </div>

        <p className="text-[12px] text-muted">
          {active
            ? share?.expires_at
              ? `Anyone with the link can view it until ${new Date(share.expires_at).toLocaleDateString()}.`
              : "Anyone with the link can view it. No expiry set."
            : invoice.published_at
              ? "Published, but the link has been revoked."
              : "Only signed-in staff and the client can see this invoice."}
        </p>

        {active && publicUrl && (
          <div className="flex w-full items-center gap-1.5 sm:ml-auto sm:w-auto">
            <code className="max-w-[260px] truncate rounded border border-line bg-surface-sunken px-2 py-1 text-[11px] text-muted">
              {publicUrl}
            </code>
            <Button variant="ghost" size="sm" onClick={onCopy}>
              <Copy />
              Copy
            </Button>
          </div>
        )}

        {(revoked > 0 || totalAccess > 0) && (
          <p className="w-full text-[11px] text-muted">
            {totalAccess} view{totalAccess === 1 ? "" : "s"} recorded
            {revoked > 0 ? ` · ${revoked} previous link${revoked === 1 ? "" : "s"} revoked` : ""}
            {!canShare ? " · you can view but not manage sharing" : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Preview.
 *
 * Renders the SAME document definition the API turns into a PDF, laid out in HTML.
 * A separate hand-built preview would drift from the download within a release.
 */
function PreviewDialog({
  open,
  onOpenChange,
  invoiceId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  invoiceId: string;
}) {
  const preview = useInvoicePreview(invoiceId, open);
  const doc = preview.data;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-line bg-surface shadow-xl focus:outline-none">
          <div className="flex items-center justify-between border-b border-line px-5 py-3">
            <Dialog.Title className="text-[14px] font-semibold text-foreground">Invoice preview</Dialog.Title>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close preview">
                <X />
              </Button>
            </Dialog.Close>
          </div>

          <div className="overflow-y-auto px-5 py-4">
            {preview.isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : !doc ? (
              <p className="py-8 text-center text-[12.5px] text-muted">Preview unavailable.</p>
            ) : (
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[15px] font-semibold" style={{ color: doc.branding.brandColor ?? undefined }}>
                      {doc.branding.agencyName}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-wide text-muted">
                      {INVOICE_STATUS[doc.status]?.label ?? doc.status}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] uppercase tracking-wide text-muted">Invoice</p>
                    <p className="text-[15px] font-semibold text-foreground">{doc.invoiceNumber}</p>
                  </div>
                </div>

                <div className="flex justify-between gap-4 text-[12px]">
                  <div>
                    <p className="text-[10.5px] uppercase tracking-wide text-muted">Bill to</p>
                    <p className="font-medium text-foreground-soft">{doc.billTo.name}</p>
                  </div>
                  <div className="text-right text-[12px] text-muted">
                    <p>
                      Issued{" "}
                      {doc.issuedAt ? new Date(doc.issuedAt).toLocaleDateString() : "—"}
                    </p>
                    <p>Due {doc.dueDate ? new Date(doc.dueDate).toLocaleDateString() : "—"}</p>
                  </div>
                </div>

                <table className="w-full text-left text-[12px]">
                  <thead className="border-b border-line">
                    <tr className="text-[10.5px] uppercase tracking-wide text-muted">
                      <th className="py-1.5 font-medium">Description</th>
                      <th className="py-1.5 text-right font-medium">Qty</th>
                      <th className="py-1.5 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {doc.lines.map((l, i) => (
                      <tr key={i}>
                        <td className="py-1.5 text-foreground-soft">{l.description}</td>
                        <td className="py-1.5 text-right tabular-nums text-muted">{l.quantity}</td>
                        <td className="py-1.5 text-right tabular-nums text-foreground-soft">
                          {formatInvoiceMoney(l.amount, doc.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <dl className="ml-auto max-w-[220px] space-y-1 text-[12px]">
                  <Row label="Subtotal" value={formatInvoiceMoney(doc.subtotal, doc.currency)} />
                  {doc.discountAmount > 0 && (
                    <Row label="Discount" value={`−${formatInvoiceMoney(doc.discountAmount, doc.currency)}`} />
                  )}
                  {doc.taxAmount > 0 && (
                    <Row label={`Tax (${doc.taxRate}%)`} value={formatInvoiceMoney(doc.taxAmount, doc.currency)} />
                  )}
                  <Row label="Total" value={formatInvoiceMoney(doc.total, doc.currency)} strong />
                  {doc.paidAmount > 0 && (
                    <Row label="Balance" value={formatInvoiceMoney(doc.balance, doc.currency)} strong />
                  )}
                </dl>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-line px-5 py-3">
            <p className="text-[11px] text-muted">
              This is what the PDF contains.
            </p>
            <Dialog.Close asChild>
              <Button variant="secondary" size="sm">
                Close
              </Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <Dialog.Title className="text-[15px] font-semibold text-foreground">{title}</Dialog.Title>
          <Dialog.Description className="mt-2 text-[12.5px] leading-relaxed text-muted">{body}</Dialog.Description>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" loading={busy} onClick={() => void onConfirm()}>
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaymentDialog({
  open,
  onOpenChange,
  balance,
  currency,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  balance: number;
  currency: string;
  busy: boolean;
  onSubmit: (amount: number, method: string, reference?: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("bank_transfer");
  const [reference, setReference] = useState("");

  // Defaults to the full balance, because that is what is usually being paid.
  const effective = amount === "" ? balance : Number(amount);
  const valid = Number.isFinite(effective) && effective > 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <Dialog.Title className="text-[15px] font-semibold text-foreground">Record a payment</Dialog.Title>
          <Dialog.Description className="mt-1 text-[12.5px] text-muted">
            Balance outstanding: {formatInvoiceMoney(balance, currency)}
          </Dialog.Description>

          <div className="mt-4 space-y-3">
            <Field label="Amount" hint="Leave blank to record the full balance.">
              <Input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={String(balance)}
              />
            </Field>

            <Field label="Method">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                className="flex h-9 w-full rounded-md border border-line bg-surface px-2 text-sm text-foreground"
              >
                <option value="bank_transfer">Bank transfer</option>
                <option value="card">Card</option>
                <option value="paypal">PayPal</option>
                <option value="wise">Wise</option>
                <option value="other">Other</option>
              </select>
            </Field>

            <Field label="Reference" hint="Transaction id, so it can be matched to the bank.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="TX-1234" />
            </Field>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              loading={busy}
              disabled={!valid}
              onClick={() => void onSubmit(effective, method, reference || undefined)}
            >
              Record payment
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
