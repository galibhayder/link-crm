import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Bell, CheckCheck, Circle } from "lucide-react";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";
import { Button } from "@/components/ui/button";
import { cn, formatRelative } from "@/lib/utils";

/**
 * NOTIFICATION BELL.
 *
 * This is the visible delivery for anchor alerts (and the two pre-existing
 * notification types). An account manager should see the badge change without
 * opening the Anchors page.
 *
 * Two queries on purpose:
 *   - the count polls slowly (60s) and is cheap (`head: true`, no rows)
 *   - the list is fetched only when the panel opens
 *
 * Polling the list on a timer would transfer thirty rows a minute to render a
 * number. Polling the count is one integer.
 */

interface Notification {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

interface NotificationList {
  notifications: Notification[];
  unreadCount: number;
}

export function NotificationBell() {
  const token = useAccessToken();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const unread = useQuery({
    queryKey: ["notifications", "unread-count"],
    queryFn: async () => {
      const res = await apiRequest<{ unreadCount: number }>("/api/v1/notifications/unread-count", { token });
      return res.data.unreadCount;
    },
    enabled: Boolean(token),
    refetchInterval: 60_000,
    // A background tab should not keep polling indefinitely.
    refetchIntervalInBackground: false,
  });

  const list = useQuery({
    queryKey: ["notifications", "list"],
    queryFn: async () => {
      const res = await apiRequest<NotificationList>(`/api/v1/notifications${buildQuery({ limit: 20 })}`, {
        token,
      });
      return res.data;
    },
    enabled: Boolean(token) && open,
  });

  const markRead = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest(`/api/v1/notifications/${id}/read`, { method: "PATCH", token });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const markAll = useMutation({
    mutationFn: async () => {
      await apiRequest("/api/v1/notifications/read-all", { method: "POST", token });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });

  const count = unread.data ?? 0;

  const handleClick = (n: Notification) => {
    if (!n.read_at) markRead.mutate(n.id);

    // `link` comes from the payload the server wrote. It is a fixed path per type,
    // never user input, so a plain navigate is safe here.
    const link = typeof n.payload.link === "string" ? n.payload.link : null;
    if (link) {
      setOpen(false);
      navigate(link);
    }
  };

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}
          className="relative"
        >
          <Bell />
          {count > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex min-w-[15px] items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[9.5px] font-semibold leading-4 text-white"
              aria-hidden
            >
              {count > 9 ? "9+" : count}
            </span>
          )}
        </Button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 w-[min(360px,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-0 shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <p className="text-[12.5px] font-semibold text-foreground">Notifications</p>
            {count > 0 && (
              <Button
                variant="ghost"
                size="sm"
                loading={markAll.isPending}
                onClick={(e) => {
                  // The menu would otherwise close on every click.
                  e.preventDefault();
                  markAll.mutate();
                }}
              >
                <CheckCheck />
                Mark all read
              </Button>
            )}
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {list.isLoading ? (
              <p className="px-3 py-6 text-center text-[12px] text-muted">Loading…</p>
            ) : list.isError ? (
              <p className="px-3 py-6 text-center text-[12px] text-[var(--color-danger)]">
                {(list.error as ApiError)?.message ?? "Could not load notifications"}
              </p>
            ) : (list.data?.notifications ?? []).length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-muted">Nothing to show.</p>
            ) : (
              <ul className="divide-y divide-line">
                {(list.data?.notifications ?? []).map((n) => (
                  <li key={n.id}>
                    <DropdownMenu.Item
                      // Radix calls onSelect on Enter/Space as well as click, so the
                      // bell stays keyboard-operable.
                      onSelect={() => handleClick(n)}
                      className={cn(
                        "flex cursor-pointer items-start gap-2 px-3 py-2.5 outline-none transition hover:bg-surface-sunken focus-visible:bg-surface-sunken",
                        !n.read_at && "bg-brand-50/40 dark:bg-brand-900/10",
                      )}
                    >
                      <Circle
                        className={cn(
                          "mt-1 size-2 shrink-0",
                          n.read_at ? "text-transparent" : "fill-brand-600 text-brand-600",
                        )}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-medium text-foreground">{titleFor(n)}</span>
                        <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted">
                          {bodyFor(n)}
                        </span>
                        <span className="mt-0.5 block text-[10.5px] text-muted">
                          {formatRelative(n.created_at)}
                        </span>
                      </span>
                    </DropdownMenu.Item>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Label per type.
 *
 * The payload is whatever the writer put there, so every read is defensive — a
 * notification with an unexpected shape must render as something rather than crash
 * the header.
 */
function titleFor(n: Notification): string {
  switch (n.type) {
    case "anchor_alert":
      return "Anchor alert";
    case "follow_up_due":
      return "Follow-up due";
    case "placement_stage_changed":
      return "Placement moved";
    case "link_needs_review":
      return "Link needs review";
    default:
      return "Notification";
  }
}

function bodyFor(n: Notification): string {
  const campaign = typeof n.payload.campaignName === "string" ? n.payload.campaignName : null;
  const message = typeof n.payload.message === "string" ? n.payload.message : null;
  const domain = typeof n.payload.domain === "string" ? n.payload.domain : null;
  const targetUrl = typeof n.payload.targetUrl === "string" ? n.payload.targetUrl : null;
  const to = typeof n.payload.to === "string" ? n.payload.to : null;

  if (n.type === "anchor_alert") {
    return campaign ? `${campaign}: ${message ?? "alert"}` : (message ?? "Anchor distribution alert");
  }
  if (n.type === "follow_up_due") return domain ? `Follow up with ${domain}` : "A follow-up is due";
  if (n.type === "placement_stage_changed") {
    return targetUrl ? `${targetUrl}${to ? ` → ${to}` : ""}` : "A placement changed stage";
  }
  if (n.type === "link_needs_review") {
    // Deliberately not the raw `failure_reason`: it is written for an operator
    // reading a check row, and reads as jargon in a notification. The link is the
    // actionable part — the reviewer opens the page and looks.
    const url = typeof n.payload.url === "string" ? n.payload.url : null;
    return url ? `Open ${url} and confirm the link is there` : "A link could not be verified automatically";
  }
  return "You have a new notification";
}
