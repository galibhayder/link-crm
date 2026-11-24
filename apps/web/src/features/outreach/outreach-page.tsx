import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Mail,
  MailX,
  Plus,
  Send,
  ShieldAlert,
  Timer,
  X,
} from "lucide-react";
import { useAccessToken, useAuth } from "@/providers/auth";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { PageHeading } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/states";
import { cn, formatRelative, humanize } from "@/lib/utils";

/**
 * OUTREACH MANAGEMENT.
 *
 * Two panes: the follow-up queue (what needs doing) and the record list (what has
 * happened). Templates are managed in a dialog because they are edited rarely and
 * read constantly — a full page for them would be a worse trade.
 *
 * SENDING IS NOT AVAILABLE. There is no provider, so the send button explains
 * that rather than pretending. "Log an outreach" is the honest path: it records
 * that a human sent it elsewhere, which is what actually happens in an agency
 * that has not wired up an ESP.
 */

interface OutreachRecord {
  id: string;
  prospect_id: string;
  campaign_id: string;
  template_id: string | null;
  kind: string;
  status: string;
  response_status: string | null;
  subject: string | null;
  body_excerpt: string | null;
  recipient_email: string | null;
  sent_at: string | null;
  responded_at: string | null;
  follow_up_due_at: string | null;
  follow_up_count: number;
  owner_id: string | null;
  created_at: string;
  prospect?: { id: string; domain: string; contact_name: string | null; contact_email: string | null } | null;
}

interface Template {
  id: string;
  name: string;
  subject: string;
  body_md: string;
  category: string;
  variables: string[];
}

const STATUS_TONE: Record<string, "neutral" | "brand" | "success" | "warning" | "danger" | "info" | "outline"> = {
  draft: "neutral",
  queued: "info",
  sent: "brand",
  replied: "success",
  no_response: "warning",
  bounced: "danger",
  cancelled: "outline",
};

export function OutreachPage() {
  const token = useAccessToken();
  const { can } = useAuth();
  const queryClient = useQueryClient();

  const canWrite = can("touchpoints:write");
  const canTemplates = can("templates:write");

  const [statusFilter, setStatusFilter] = useState("");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [logTarget, setLogTarget] = useState<OutreachRecord | null>(null);
  const [selected, setSelected] = useState<OutreachRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const records = useQuery({
    queryKey: ["outreach-records", statusFilter],
    queryFn: async () => {
      // The token must be passed explicitly: without it the request is anonymous
      // and returns 401 even though the user is signed in.
      const res = await apiRequest<OutreachRecord[]>(
        `/api/v1/outreach${buildQuery({ limit: 100, status: statusFilter || undefined })}`,
        { token },
      );
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  const followUps = useQuery({
    queryKey: ["outreach-follow-ups"],
    queryFn: async () => {
      const res = await apiRequest<OutreachRecord[]>("/api/v1/outreach/follow-ups", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token),
  });

  const templates = useQuery({
    queryKey: ["outreach-templates"],
    queryFn: async () => {
      const res = await apiRequest<Template[]>("/api/v1/outreach/templates", { token });
      return res.data ?? [];
    },
    enabled: Boolean(token) && can("templates:read"),
  });

  const send = useMutation({
    mutationFn: async (id: string) => {
      // `confirm: true` is the explicit-authorisation flag the API requires.
      await apiRequest(`/api/v1/outreach/${id}/send`, { method: "POST", body: { confirm: true }, token });
    },
    onError: (err) => setError((err as ApiError).message),
  });

  const markResponse = useMutation({
    mutationFn: async ({ id, responseStatus }: { id: string; responseStatus: string }) => {
      await apiRequest(`/api/v1/outreach/${id}`, { method: "PATCH", body: { responseStatus }, token });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["outreach-records"] });
      void queryClient.invalidateQueries({ queryKey: ["outreach-follow-ups"] });
    },
    onError: (err) => setError((err as ApiError).message),
  });

  const dueCount = followUps.data?.length ?? 0;

  const grouped = useMemo(() => records.data ?? [], [records.data]);

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Outreach"
          description="Templates, contact history and the follow-up queue for every prospect you have approached."
          actions={
            <>
              {can("templates:read") && (
                <Button variant="secondary" size="sm" onClick={() => setTemplatesOpen(true)}>
                  <Mail />
                  Templates
                </Button>
              )}
            </>
          }
        />

        {/* Sending is deliberately absent. Say so once, clearly, rather than
            offering a button that cannot work. */}
        <div className="flex items-start gap-2.5 rounded-lg border border-[var(--color-info)]/30 bg-[var(--color-info-soft)]/50 px-3.5 py-2.5">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--color-info)]" aria-hidden />
          <div className="text-[12.5px] leading-relaxed text-foreground-soft">
            <p className="font-medium text-foreground">Sending is disabled in this build.</p>
            <p className="mt-0.5 text-muted">
              No email provider is configured, so nothing can be sent from here. Log an outreach you sent elsewhere —
              that keeps reply rates and follow-ups accurate.
            </p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]/50 px-3 py-2 text-[12.5px] text-[var(--color-danger)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{error}</p>
          </div>
        )}

        {dueCount > 0 && (
          <Card>
            <CardContent className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <Timer className="size-4 text-[var(--color-warning)]" aria-hidden />
                <h2 className="text-[13px] font-semibold text-foreground">
                  Follow-ups due
                  <span className="ml-1.5 rounded-full bg-[var(--color-warning-soft)] px-1.5 text-[11px] font-medium text-[var(--color-warning)]">
                    {dueCount}
                  </span>
                </h2>
              </div>
              <ul className="divide-y divide-line">
                {followUps.data?.slice(0, 6).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-[12.5px] font-medium text-foreground">
                        {r.prospect?.domain ?? r.recipient_email ?? "Unknown prospect"}
                      </p>
                      <p className="truncate text-[11.5px] text-muted">
                        {r.subject ?? "No subject"} · {r.follow_up_count} follow-up
                        {r.follow_up_count === 1 ? "" : "s"} sent
                      </p>
                    </div>
                    <Badge tone="warning" dot>
                      due {r.follow_up_due_at ? formatRelative(r.follow_up_due_at) : ""}
                    </Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <span className="whitespace-nowrap">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-9 rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            >
              <option value="">All</option>
              <option value="draft">Draft</option>
              <option value="sent">Sent</option>
              <option value="replied">Replied</option>
              <option value="no_response">No response</option>
              <option value="bounced">Bounced</option>
            </select>
          </label>
          <p className="ml-auto text-[12px] tabular-nums text-muted">
            {grouped.length} record{grouped.length === 1 ? "" : "s"}
          </p>
        </div>

        {records.isLoading ? (
          <TableSkeleton rows={6} cols={4} />
        ) : records.isError ? (
          <ErrorState description={(records.error as ApiError)?.message} onRetry={() => void records.refetch()} />
        ) : grouped.length === 0 ? (
          <EmptyState
            icon={MailX}
            title="No outreach records yet"
            description="Records appear here once you draft an approach to a prospect. Use the Prospects module to start one."
          />
        ) : (
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-[12.5px]">
                <thead className="border-b border-line bg-surface-sunken/60">
                  <tr className="text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-4 py-2.5 font-medium">Prospect</th>
                    <th className="px-4 py-2.5 font-medium">Subject</th>
                    <th className="px-4 py-2.5 font-medium">Status</th>
                    <th className="px-4 py-2.5 font-medium">Sent</th>
                    <th className="px-4 py-2.5 font-medium">Follow-up</th>
                    <th className="px-4 py-2.5 font-medium sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {grouped.map((r) => (
                    <tr key={r.id} className="hover:bg-surface-sunken/40">
                      <td className="px-4 py-2.5">
                        <button
                          type="button"
                          onClick={() => setSelected(r)}
                          className="text-left font-medium text-foreground hover:text-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          {r.prospect?.domain ?? "—"}
                        </button>
                        {r.recipient_email && (
                          <p className="truncate text-[11.5px] text-muted">{r.recipient_email}</p>
                        )}
                      </td>
                      <td className="max-w-[240px] truncate px-4 py-2.5 text-foreground-soft">
                        {r.subject ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{humanize(r.status)}</Badge>
                          {r.response_status && <Badge tone="outline">{humanize(r.response_status)}</Badge>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                        {r.sent_at ? formatRelative(r.sent_at) : "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        {r.follow_up_due_at ? (
                          <span className="inline-flex items-center gap-1 text-muted">
                            <CalendarClock className="size-3" aria-hidden />
                            {formatRelative(r.follow_up_due_at)}
                          </span>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {canWrite && (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setLogTarget(r)}
                              title="Log an outreach sent outside the system"
                            >
                              <ArrowUpRight />
                              Log
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setError(null);
                                send.mutate(r.id);
                              }}
                              title="Send via the configured provider"
                            >
                              <Send />
                              Send
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </PageStack>

      <TemplatesDialog open={templatesOpen} onOpenChange={setTemplatesOpen} templates={templates.data ?? []} canWrite={canTemplates} />

      <LogOutreachDialog
        record={logTarget}
        open={Boolean(logTarget)}
        onOpenChange={(v) => !v && setLogTarget(null)}
        onLogged={() => {
          void queryClient.invalidateQueries({ queryKey: ["outreach-records"] });
          void queryClient.invalidateQueries({ queryKey: ["outreach-follow-ups"] });
        }}
      />

      <RecordDrawer
        record={selected}
        open={Boolean(selected)}
        onOpenChange={(v) => !v && setSelected(null)}
        canWrite={canWrite}
        onResponse={(id, status) => markResponse.mutate({ id, responseStatus: status })}
      />
    </PageContainer>
  );
}

function TemplatesDialog({
  open,
  onOpenChange,
  templates,
  canWrite,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  templates: Template[];
  canWrite: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <Dialog.Title className="text-[15px] font-semibold text-foreground">Email templates</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12.5px] text-muted">
                Placeholders use <code className="rounded bg-surface-sunken px-1">{"{{domain}}"}</code> syntax and are
                filled per prospect.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>

          {templates.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="No templates yet"
              description={
                canWrite
                  ? "Add one through the API or the seed data to standardise your outreach."
                  : "An account manager can create templates for the team."
              }
            />
          ) : (
            <ul className="space-y-2">
              {templates.map((t) => (
                <li key={t.id} className="rounded-lg border border-line bg-surface-sunken/50 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-medium text-foreground">{t.name}</p>
                      <p className="mt-0.5 truncate text-[12px] text-muted">{t.subject}</p>
                    </div>
                    <Badge tone="outline">{humanize(t.category)}</Badge>
                  </div>
                  <pre className="mt-2 max-h-24 overflow-hidden whitespace-pre-wrap text-[11.5px] leading-relaxed text-muted-strong">
                    {t.body_md}
                  </pre>
                  {t.variables?.length > 0 && (
                    <p className="mt-1.5 text-[11px] text-muted">Variables: {t.variables.join(", ")}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LogOutreachDialog({
  record,
  open,
  onOpenChange,
  onLogged,
}: {
  record: OutreachRecord | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onLogged: () => void;
}) {
  const [channel, setChannel] = useState("email");
  const [outcome, setOutcome] = useState("no_reply");
  const [note, setNote] = useState("");
  const [nextFollowUp, setNextFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const token = useAccessToken();

  const submit = async () => {
    if (!record) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/api/v1/outreach/${record.id}/log`, {
        method: "POST",
        body: {
          channel,
          outcome,
          note: note || undefined,
          nextFollowUpAt: nextFollowUp || undefined,
        },
        token,
      });
      onLogged();
      onOpenChange(false);
      setNote("");
      setNextFollowUp("");
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 shadow-xl focus:outline-none">
          <Dialog.Title className="text-[15px] font-semibold text-foreground">Log an outreach</Dialog.Title>
          <Dialog.Description className="mb-4 mt-1 text-[12.5px] text-muted">
            Record something you sent outside the system. This is what keeps reply rates honest without a provider.
          </Dialog.Description>

          <div className="space-y-3">
            <Field label="Channel">
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground"
              >
                <option value="email">Email</option>
                <option value="linkedin">LinkedIn</option>
                <option value="contact_form">Contact form</option>
                <option value="phone">Phone</option>
                <option value="other">Other</option>
              </select>
            </Field>

            <Field label="Outcome">
              <select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
                className="h-9 w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground"
              >
                <option value="no_reply">No reply yet</option>
                <option value="positive">Positive</option>
                <option value="negative">Negative</option>
                <option value="bounce">Bounced</option>
                <option value="auto_reply">Auto-reply</option>
              </select>
            </Field>

            <Field label="Next follow-up" hint="Leave empty if no follow-up is needed.">
              <Input type="datetime-local" value={nextFollowUp} onChange={(e) => setNextFollowUp(e.target.value)} />
            </Field>

            <Field label="Note">
              <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What happened?" />
            </Field>

            {error && (
              <p role="alert" className="text-[12.5px] text-[var(--color-danger)]">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button size="sm" loading={busy} onClick={submit}>
                <CheckCircle2 />
                Log it
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function RecordDrawer({
  record,
  open,
  onOpenChange,
  canWrite,
  onResponse,
}: {
  record: OutreachRecord | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  canWrite: boolean;
  onResponse: (id: string, status: string) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-full max-w-sm flex-col border-l border-line bg-surface shadow-2xl focus:outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-[15px] font-semibold text-foreground">
                {record?.prospect?.domain ?? "Outreach record"}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-muted">
                {record?.subject ?? "No subject"}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {record && (
              <>
                <div className="mb-4 flex flex-wrap gap-1.5">
                  <Badge tone={STATUS_TONE[record.status] ?? "neutral"}>{humanize(record.status)}</Badge>
                  <Badge tone="outline">{humanize(record.kind)}</Badge>
                  {record.response_status && <Badge tone="info">{humanize(record.response_status)}</Badge>}
                </div>

                <dl className="space-y-2 text-[12.5px]">
                  <Detail label="Contact">{record.prospect?.contact_name ?? "—"}</Detail>
                  <Detail label="Email">{record.recipient_email ?? record.prospect?.contact_email ?? "—"}</Detail>
                  <Detail label="Follow-ups sent">{String(record.follow_up_count)}</Detail>
                  <Detail label="Sent">{record.sent_at ? formatRelative(record.sent_at) : "not sent"}</Detail>
                  <Detail label="Responded">{record.responded_at ? formatRelative(record.responded_at) : "—"}</Detail>
                  <Detail label="Next follow-up">
                    {record.follow_up_due_at ? formatRelative(record.follow_up_due_at) : "—"}
                  </Detail>
                </dl>

                {record.body_excerpt && (
                  <div className="mt-4 rounded-lg border border-line bg-surface-sunken p-3">
                    <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Excerpt</p>
                    <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground-soft">
                      {record.body_excerpt}
                    </p>
                  </div>
                )}

                {canWrite && (
                  <div className="mt-5">
                    <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">Record a response</p>
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          ["positive", "Positive"],
                          ["neutral", "Neutral"],
                          ["negative", "Negative"],
                          ["not_interested", "Not interested"],
                        ] as const
                      ).map(([value, label]) => (
                        <Button
                          key={value}
                          variant="secondary"
                          size="sm"
                          onClick={() => onResponse(record.id, value)}
                          className={cn(value === "positive" && "border-[var(--color-success)]/40 text-[var(--color-success)]")}
                        >
                          {label}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-foreground-soft">{children}</dd>
    </div>
  );
}
