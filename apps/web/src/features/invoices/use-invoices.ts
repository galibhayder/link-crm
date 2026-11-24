import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";

/**
 * INVOICE DATA LAYER.
 *
 * All reads go through `v_invoices`, so `effective_status` and `balance` come from
 * the server rather than being re-derived here. Two derivations of "is this
 * overdue" is how a screen and its PDF end up disagreeing.
 *
 * The PDF is fetched as a BLOB and saved locally, not opened as a URL. A URL would
 * need the bearer token in a query string (logged by proxies) or a cookie (not
 * how this app authenticates), so the authenticated fetch is the only honest path.
 */

export interface InvoiceSummary {
  id: string;
  invoice_number: string;
  client_id: string;
  client_name: string;
  agency_partner_name: string | null;
  status: string;
  effective_status: string;
  currency: string;
  subtotal: string | number;
  discount_amount: string | number;
  tax_rate: string | number;
  tax_amount: string | number;
  total: string | number;
  paid_amount: string | number;
  balance: string | number;
  due_date: string | null;
  issued_at: string | null;
  published_at: string | null;
  period_start: string;
  period_end: string;
  days_overdue: number;
  snapshot_version: number;
}

export interface InvoiceLineItem {
  id?: string;
  description: string;
  quantity: string | number;
  unit_price: string | number;
  amount: string | number;
  placement_id?: string | null;
  sort_order?: number;
}

export interface InvoiceShareState {
  active: boolean;
  expires_at: string | null;
  links: Array<{
    id: string;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    last_accessed_at: string | null;
    access_count: number;
  }>;
}

export interface InvoiceDetail extends InvoiceSummary {
  notes: string | null;
  payment_instructions: string | null;
  line_items: InvoiceLineItem[];
  share: InvoiceShareState;
}

export interface InvoicePreviewDocument {
  invoiceNumber: string;
  status: string;
  issuedAt: string | null;
  dueDate: string | null;
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
  branding: { agencyName: string; brandColor: string | null };
  billTo: { name: string };
}

export const INVOICE_KEYS = {
  list: (filters: Record<string, unknown>) => ["invoices", "list", filters] as const,
  detail: (id: string) => ["invoices", "detail", id] as const,
  preview: (id: string) => ["invoices", "preview", id] as const,
  payments: (id: string) => ["invoices", "payments", id] as const,
};

export function useInvoices(filters: { status?: string; effectiveStatus?: string; clientId?: string } = {}) {
  const token = useAccessToken();

  return useQuery({
    queryKey: INVOICE_KEYS.list(filters),
    queryFn: async () => {
      const res = await apiRequest<InvoiceSummary[]>(
        `/api/v1/invoices${buildQuery({ ...filters, limit: 100 })}`,
        { token },
      );
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });
}

export function useInvoice(id: string | undefined) {
  const token = useAccessToken();

  return useQuery({
    queryKey: INVOICE_KEYS.detail(id ?? ""),
    queryFn: async () => {
      const res = await apiRequest<InvoiceDetail>(`/api/v1/invoices/${id}`, { token });
      return res.data;
    },
    enabled: Boolean(token) && Boolean(id),
  });
}

export function useInvoicePreview(id: string | undefined, enabled: boolean) {
  const token = useAccessToken();

  return useQuery({
    queryKey: INVOICE_KEYS.preview(id ?? ""),
    queryFn: async () => {
      const res = await apiRequest<{ document: InvoicePreviewDocument }>(`/api/v1/invoices/${id}/preview`, {
        token,
      });
      return res.data.document;
    },
    // Only fetched when the preview dialog opens — no reason to compute a document
    // nobody is looking at.
    enabled: Boolean(token) && Boolean(id) && enabled,
  });
}

export interface PaymentRow {
  id: string;
  amount: string | number;
  currency: string;
  method: string;
  reference: string | null;
  received_at: string;
}

export function useInvoicePayments(id: string | undefined) {
  const token = useAccessToken();

  return useQuery({
    queryKey: INVOICE_KEYS.payments(id ?? ""),
    queryFn: async () => {
      const res = await apiRequest<PaymentRow[]>(`/api/v1/payments${buildQuery({ invoiceId: id, limit: 50 })}`, {
        token,
      });
      return res.data ?? [];
    },
    enabled: Boolean(token) && Boolean(id),
  });
}

export function useInvoiceActions() {
  const token = useAccessToken();
  const qc = useQueryClient();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["invoices"] });
  };

  const issue = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest(`/api/v1/invoices/${id}/issue`, { method: "POST", token });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const publish = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest(`/api/v1/invoices/${id}/publish`, { method: "POST", token });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const unpublish = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest(`/api/v1/invoices/${id}/unpublish`, { method: "POST", token });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const cancelInvoice = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest(`/api/v1/invoices/${id}/cancel`, { method: "POST", token });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const duplicate = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest<{ id: string }>(`/api/v1/invoices/${id}/duplicate`, { method: "POST", token });
      return res.data;
    },
    onSuccess: invalidate,
  });

  /** Creates a fresh public link. The raw token is only ever returned here. */
  const createShareLink = useMutation({
    mutationFn: async (input: { id: string; expiresInDays?: number }) => {
      const res = await apiRequest<{ token: string; url: string; expires_at: string | null }>(
        `/api/v1/invoices/${input.id}/share-link`,
        {
          method: "POST",
          body: input.expiresInDays ? { expiresInDays: input.expiresInDays } : {},
          token,
        },
      );
      return res.data;
    },
    onSuccess: invalidate,
  });

  const revokeShareLink = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest<{ revoked: number }>(`/api/v1/invoices/${id}/share-link`, {
        method: "DELETE",
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const recordPayment = useMutation({
    mutationFn: async (input: { invoiceId: string; amount: number; method: string; reference?: string }) => {
      const res = await apiRequest("/api/v1/payments", {
        method: "POST",
        body: {
          invoiceId: input.invoiceId,
          amount: input.amount,
          method: input.method,
          reference: input.reference,
        },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const reversePayment = useMutation({
    mutationFn: async (paymentId: string) => {
      const res = await apiRequest(`/api/v1/payments/${paymentId}`, { method: "DELETE", token });
      return res.data;
    },
    onSuccess: invalidate,
  });

  return {
    issue,
    publish,
    unpublish,
    cancelInvoice,
    duplicate,
    createShareLink,
    revokeShareLink,
    recordPayment,
    reversePayment,
  };
}

/**
 * Downloads an invoice PDF and saves it.
 *
 * The object URL is revoked in a `finally`, because a browser keeps the blob alive
 * until it is; a dozen downloads would otherwise pin a dozen PDFs in memory.
 */
export async function downloadInvoicePdf(id: string, invoiceNumber: string, token: string | null) {
  const res = await fetch(`/api/v1/invoices/${id}/pdf`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) {
    throw new Error(`Could not download the invoice (${res.status})`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `Invoice-${invoiceNumber}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser a tick to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export async function downloadReportExport(
  path: string,
  filename: string,
  token: string | null,
  format: "csv" | "xlsx",
) {
  const res = await fetch(`${path}${path.includes("?") ? "&" : "?"}format=${format}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  if (!res.ok) throw new Error(`Export failed (${res.status})`);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filename}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function invoiceErrorMessage(err: unknown): string {
  return (err as ApiError)?.message ?? "Something went wrong";
}

/** Shared presentation helpers, so a status looks the same everywhere. */
export const INVOICE_STATUS: Record<string, { label: string; tone: "neutral" | "brand" | "success" | "warning" | "danger" | "info" | "outline" }> = {
  draft: { label: "Draft", tone: "neutral" },
  issued: { label: "Issued", tone: "info" },
  published: { label: "Published", tone: "brand" },
  partially_paid: { label: "Part paid", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  overdue: { label: "Overdue", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "outline" },
};

export function formatInvoiceMoney(amount: string | number | null | undefined, currency: string): string {
  const value = typeof amount === "string" ? Number(amount) : (amount ?? 0);
  const safe = Number.isFinite(value) ? value : 0;
  const decimals = ["JPY", "KRW", "VND", "CLP", "ISK", "HUF"].includes(currency) ? 0 : 2;

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(safe);
  } catch {
    return `${currency} ${safe.toFixed(decimals)}`;
  }
}
