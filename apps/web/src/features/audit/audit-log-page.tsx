import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ScrollText, Search } from "lucide-react";
import { useAccessToken } from "@/providers/auth";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { formatRelative, humanize } from "@/lib/utils";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { PageHeading } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/states";

interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_name_snapshot: string | null;
  actor_role: string | null;
  entity_type: string;
  entity_id: string | null;
  action: string;
  diff: Record<string, unknown>;
  ip: string | null;
  created_at: string;
}

const ACTION_TONES: Record<string, "neutral" | "success" | "warning" | "danger" | "info" | "brand"> = {
  create: "success",
  update: "info",
  delete: "danger",
  role_change: "warning",
  suspend: "danger",
  activate: "success",
  invite: "brand",
  login: "neutral",
  password_reset: "warning",
  export: "info",
};

export function AuditLogPage() {
  const token = useAccessToken();
  const [entityType, setEntityType] = useState("");
  const [action, setAction] = useState("");

  const logs = useQuery({
    queryKey: ["audit", { entityType, action }],
    queryFn: () =>
      apiRequest<AuditRow[]>(
        `/api/v1/audit${buildQuery({ entityType, action, limit: 100 })}`,
        { token },
      ),
    enabled: Boolean(token),
  });

  const rows = logs.data?.data ?? [];

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Audit log"
          description="Every sensitive action, who performed it and when. Entries are written by the server and cannot be edited or deleted through the application."
        />

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              placeholder="Filter by entity type (profile, invoice, placement_cost…)"
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              className="pl-8"
              aria-label="Filter by entity type"
            />
          </div>
          <Input
            placeholder="Filter by action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            aria-label="Filter by action"
            className="sm:w-56"
          />
        </div>

        {logs.isLoading ? (
          <TableSkeleton rows={8} cols={3} />
        ) : logs.isError ? (
          <ErrorState
            title="Couldn't load the audit log"
            description={(logs.error as ApiError)?.message ?? "The request failed."}
            onRetry={() => void logs.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No audit entries yet"
            description="Sensitive actions such as role changes, suspensions and cost edits appear here."
          />
        ) : (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li key={row.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">
                    <Badge tone={ACTION_TONES[row.action] ?? "neutral"}>{humanize(row.action)}</Badge>
                    <span className="truncate text-[12.5px] text-foreground">
                      {row.entity_type}
                      {row.entity_id && (
                        <span className="ml-1 font-mono text-[11px] text-muted">
                          {row.entity_id.slice(0, 8)}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-[11.5px] text-muted">
                    <span className="truncate">{row.actor_name_snapshot ?? row.actor_role ?? "system"}</span>
                    <span className="tabular-nums">{formatRelative(row.created_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </PageStack>
    </PageContainer>
  );
}
