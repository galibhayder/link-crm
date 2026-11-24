import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { AlertCircle, Download, FileText } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { formatInvoiceMoney } from "@/features/invoices/use-invoices";
import { INVOICE_STATUS } from "@/features/invoices/use-invoices";

/**
 * PUBLIC INVOICE PAGE — /i/:token
 *
 * Reached by anyone with a link, with no account. Three things matter:
 *
 *   1. It never mounts the CRM shell. A recipient must not see a sidebar, a
 *      search box, or anything that implies they have an account here.
 *   2. It asks the API for the SANITIZED payload. The projection is built
 *      server-side from the frozen snapshot, so internal costs cannot leak
 *      through this screen even if this file is wrong.
 *   3. It is marked noindex, both in the head and by the API's response header.
 *      An invoice URL in a search index would be a disclosure.
 *
 * The PDF is fetched without a token — the public PDF route accepts the same
 * token as the page, which is why the URL is the credential and nothing else.
 */

interface PublicInvoice {
  invoiceNumber: string;
  status: string;
  issuedAt: string | null;
  dueDate: string | null;
  expiresAt: string | null;
  currency: string;
  lines: Array<{ description: string; quantity: number; unitPrice: number; amount: number }>;
  subtotal: number;
  discountAmount: number;
  taxRate: number;
  taxAmount: number;
  total: number;
  paidAmount: number;
  balance: number;
  notes: string | null;
  paymentInstructions: string | null;
  billTo: { name: string; address: Record<string, unknown> | null; taxId: string | null };
  branding: {
    agencyName: string;
    agencyEmail: string | null;
    agencyPhone: string | null;
    agencyAddress: string | null;
    brandColor: string | null;
  };
}

export function PublicInvoicePage() {
  const { token } = useParams<{ token: string }>();
  const [downloading, setDownloading] = useState(false);

  // Belt and braces: the API sends X-Robots-Tag, and the page sets the meta tag.
  // A crawler that ignores one may honour the other.
  useEffect(() => {
    const tag = document.createElement("meta");
    tag.name = "robots";
    tag.content = "noindex, nofollow, noarchive";
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);

  const invoice = useQuery({
    queryKey: ["public-invoice", token],
    queryFn: async () => {
      const res = await fetch(`/public/v1/invoices/${encodeURIComponent(token ?? "")}`);
      if (res.status === 404) throw new Error("not_found");
      if (!res.ok) throw new Error("failed");
      const body = (await res.json()) as { data: PublicInvoice };
      return body.data;
    },
    enabled: Boolean(token),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const res = await fetch(`/public/v1/invoices/${encodeURIComponent(token ?? "")}/pdf`);
      if (!res.ok) throw new Error("failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Invoice-${invoice.data?.invoiceNumber ?? "invoice"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      // Nothing useful to say beyond "try again"; the link may have expired.
      invoice.refetch();
    } finally {
      setDownloading(false);
    }
  };

  if (invoice.isLoading) {
    return (
      <Shell>
        <p className="text-[13px] text-muted">Loading invoice…</p>
      </Shell>
    );
  }

  // A 404 is deliberate and unhelpful on purpose: it does not distinguish an
  // unknown token from a revoked or expired one.
  if (invoice.isError || !invoice.data) {
    return (
      <Shell>
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <AlertCircle className="size-8 text-muted" aria-hidden />
          <h1 className="text-[16px] font-semibold text-foreground">This invoice link is not available</h1>
          <p className="max-w-sm text-[13px] leading-relaxed text-muted">
            The link may have been revoked, may have expired, or may be incorrect. Ask the agency
            that sent it for a new one.
          </p>
        </div>
      </Shell>
    );
  }

  const inv = invoice.data;
  const meta = INVOICE_STATUS[inv.status] ?? { label: inv.status, tone: "neutral" as const };
  const money = (v: number) => formatInvoiceMoney(v, inv.currency);
  const addressLines = extractAddress(inv.billTo.address);

  return (
    <Shell brandColor={inv.branding.brandColor}>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[18px] font-semibold" style={{ color: inv.branding.brandColor ?? undefined }}>
            {inv.branding.agencyName}
          </p>
          {inv.branding.agencyEmail && <p className="text-[12px] text-muted">{inv.branding.agencyEmail}</p>}
          {inv.branding.agencyPhone && <p className="text-[12px] text-muted">{inv.branding.agencyPhone}</p>}
          {inv.branding.agencyAddress && (
            <p className="whitespace-pre-wrap text-[12px] text-muted">{inv.branding.agencyAddress}</p>
          )}
        </div>

        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-muted">Invoice</p>
          <p className="text-[20px] font-semibold text-foreground">{inv.invoiceNumber}</p>
          <span className="mt-1 inline-block rounded border border-line px-2 py-0.5 text-[11px] font-medium text-muted">
            {meta.label}
          </span>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap justify-between gap-4 border-y border-line py-4">
        <div>
          <p className="text-[10.5px] uppercase tracking-wide text-muted">Bill to</p>
          <p className="mt-0.5 text-[13px] font-medium text-foreground">{inv.billTo.name}</p>
          {addressLines.map((line, i) => (
            <p key={i} className="text-[12px] text-muted">
              {line}
            </p>
          ))}
          {inv.billTo.taxId && <p className="text-[12px] text-muted">Tax ID: {inv.billTo.taxId}</p>}
        </div>

        <div className="text-right text-[12px]">
          <p className="text-muted">
            Issued: {inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : "—"}
          </p>
          <p className="text-muted">Due: {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : "—"}</p>
          <p className="text-muted">Currency: {inv.currency}</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-left text-[13px]">
          <thead className="border-b border-line">
            <tr className="text-[10.5px] uppercase tracking-wide text-muted">
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Qty</th>
              <th className="py-2 text-right font-medium">Unit price</th>
              <th className="py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {inv.lines.map((line, i) => (
              <tr key={i}>
                <td className="py-2.5 text-foreground-soft">{line.description}</td>
                <td className="py-2.5 text-right tabular-nums text-muted">{line.quantity}</td>
                <td className="py-2.5 text-right tabular-nums text-muted">{money(line.unitPrice)}</td>
                <td className="py-2.5 text-right tabular-nums text-foreground-soft">{money(line.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 border-t border-line pt-3">
        <dl className="ml-auto max-w-[240px] space-y-1 text-[13px]">
          <SummaryRow label="Subtotal" value={money(inv.subtotal)} />
          {inv.discountAmount > 0 && <SummaryRow label="Discount" value={`−${money(inv.discountAmount)}`} />}
          {inv.taxAmount > 0 && <SummaryRow label={`Tax (${inv.taxRate}%)`} value={money(inv.taxAmount)} />}
          <SummaryRow label="Total" value={money(inv.total)} strong />
          {inv.paidAmount > 0 && <SummaryRow label="Paid" value={`−${money(inv.paidAmount)}`} />}
          {inv.paidAmount > 0 && <SummaryRow label="Balance due" value={money(inv.balance)} strong />}
        </dl>
      </div>

      {(inv.paymentInstructions || inv.notes) && (
        <div className="mt-6 space-y-4 border-t border-line pt-4">
          {inv.paymentInstructions && (
            <div>
              <p className="text-[10.5px] uppercase tracking-wide text-muted">Payment instructions</p>
              <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground-soft">
                {inv.paymentInstructions}
              </p>
            </div>
          )}
          {inv.notes && (
            <div>
              <p className="text-[10.5px] uppercase tracking-wide text-muted">Notes</p>
              <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground-soft">
                {inv.notes}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
        <Button onClick={() => void downloadPdf()} disabled={downloading}>
          <Download />
          {downloading ? "Preparing…" : "Download PDF"}
        </Button>

        <p className="text-[11px] text-muted">
          {inv.expiresAt
            ? `This link expires on ${new Date(inv.expiresAt).toLocaleDateString()}.`
            : "This is a private link. Please do not share it publicly."}
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children, brandColor }: { children: React.ReactNode; brandColor?: string | null }) {
  return (
    <div className="min-h-screen bg-background">
      <div
        className="h-1.5 w-full"
        style={{ backgroundColor: brandColor ?? "#1f2937" }}
        aria-hidden
      />
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <div className="rounded-xl border border-line bg-surface p-5 shadow-sm sm:p-8">{children}</div>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-muted">
          <FileText className="size-3" aria-hidden />
          This page is not indexed by search engines.
        </p>
      </div>
    </div>
  );
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? "font-medium text-foreground" : "text-muted"}>{label}</dt>
      <dd className={strong ? "font-semibold tabular-nums text-foreground" : "tabular-nums text-foreground-soft"}>
        {value}
      </dd>
    </div>
  );
}

/** Prints a billing address whatever shape it was stored in. */
function extractAddress(address: Record<string, unknown> | null | undefined): string[] {
  if (!address || typeof address !== "object") return [];
  const order = ["line1", "line2", "city", "state", "postalCode", "postcode", "zip", "country"];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const key of order) {
    const v = address[key];
    if (typeof v === "string" && v.trim()) {
      out.push(v.trim());
      seen.add(key);
    }
  }
  for (const [k, v] of Object.entries(address)) {
    if (seen.has(k)) continue;
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  return out;
}

/** Local button, so this file does not import the CRM's shell-adjacent components. */
function Button({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-[13px] font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}
