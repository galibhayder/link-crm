import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Mail,
  MoreHorizontal,
  Search,
  ShieldCheck,
  UserPlus,
  Users,
} from "lucide-react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Dialog from "@radix-ui/react-dialog";
import { ROLES, type Role } from "@crm/shared";
import { useAccessToken, useAuth } from "@/providers/auth";
import { apiRequest, buildQuery, type ApiError } from "@/lib/api";
import { formatDate, formatRelative, humanize } from "@/lib/utils";
import { PageContainer, PageStack } from "@/components/layout/app-shell";
import { PageHeading } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Label } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardContent, Skeleton } from "@/components/ui/card";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/ui/states";
import { cn } from "@/lib/utils";

interface StaffMember {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  supplier_id: string | null;
  is_active: boolean;
  suspended_at: string | null;
  suspension_reason: string | null;
  role_changed_at: string;
  last_seen_at: string | null;
  created_at: string;
}

interface Invitation {
  id: string;
  email: string;
  full_name: string;
  role: Role;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  created_at: string;
}

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  owner: "Full access, including margins and payments",
  account_manager: "Clients, campaigns, invoicing",
  prospector: "Publisher database and prospecting",
  outreach_specialist: "Outreach pipeline and negotiation",
  content_writer: "Content briefs only",
  client_user: "Client portal, own clients only",
  publisher_user: "Supplier portal, own sites only",
};

export function StaffPage() {
  const token = useAccessToken();
  const { can, user } = useAuth();
  const queryClient = useQueryClient();

  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "suspended">("all");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [suspendTarget, setSuspendTarget] = useState<StaffMember | null>(null);
  const [roleTarget, setRoleTarget] = useState<StaffMember | null>(null);
  const [banner, setBanner] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const canManage = can("staff:manage");

  const staff = useQuery({
    queryKey: ["staff", { q, roleFilter, statusFilter }],
    queryFn: () =>
      apiRequest<StaffMember[]>(
        `/api/v1/staff${buildQuery({ q, role: roleFilter, status: statusFilter, limit: 100 })}`,
        { token },
      ),
    enabled: Boolean(token),
  });

  const invitations = useQuery({
    queryKey: ["staff", "invitations"],
    queryFn: () => apiRequest<Invitation[]>("/api/v1/staff/invitations", { token }),
    enabled: Boolean(token) && canManage,
  });

  const pendingInvites = useMemo(
    () => (invitations.data?.data ?? []).filter((i) => i.status === "pending"),
    [invitations.data],
  );

  const members = staff.data?.data ?? [];
  const activeCount = members.filter((m) => m.is_active).length;
  const suspendedCount = members.filter((m) => !m.is_active).length;

  function announce(tone: "success" | "danger", text: string) {
    setBanner({ tone, text });
    window.setTimeout(() => setBanner(null), 6000);
  }

  function refreshAll() {
    void queryClient.invalidateQueries({ queryKey: ["staff"] });
  }

  return (
    <PageContainer>
      <PageStack>
        <PageHeading
          title="Staff & Roles"
          description="Create users, assign roles and control access. Roles are enforced in the database, not by this screen."
          actions={
            canManage ? (
              <Button onClick={() => setInviteOpen(true)}>
                <UserPlus />
                Invite user
              </Button>
            ) : undefined
          }
        />

        {banner && (
          <div
            role="status"
            className={cn(
              "flex items-start gap-2.5 rounded-md border p-3",
              banner.tone === "success"
                ? "border-[var(--color-success)]/30 bg-[var(--color-success-soft)]"
                : "border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)]",
            )}
          >
            {banner.tone === "success" ? (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[var(--color-success)]" aria-hidden />
            ) : (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-danger)]" aria-hidden />
            )}
            <p
              className="text-[12.5px] leading-relaxed"
              style={{ color: `var(--color-${banner.tone === "success" ? "success" : "danger"})` }}
            >
              {banner.text}
            </p>
          </div>
        )}

        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile label="Team members" value={members.length} icon={Users} />
          <SummaryTile label="Active" value={activeCount} icon={CheckCircle2} tone="success" />
          <SummaryTile label="Suspended" value={suspendedCount} icon={Ban} tone="danger" />
          <SummaryTile label="Pending invites" value={pendingInvites.length} icon={Mail} tone="info" />
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
            <Input
              placeholder="Search name or email"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
              aria-label="Search staff"
            />
          </div>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            aria-label="Filter by role"
            className="h-9 rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
          >
            <option value="">All roles</option>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {humanize(role)}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            aria-label="Filter by status"
            className="h-9 rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>

        {/* User table */}
        {staff.isLoading ? (
          <TableSkeleton rows={6} cols={4} />
        ) : staff.isError ? (
          <ErrorState
            title="Couldn't load users"
            description={(staff.error as ApiError)?.message ?? "The request failed."}
            onRetry={() => void staff.refetch()}
          />
        ) : members.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No users match those filters"
            description="Try clearing the search or selecting a different role."
          />
        ) : (
          <Card className="overflow-hidden">
            {/*
              A wide table on a narrow screen is unavoidable, but silently
              clipping it means the role and status columns are invisible with
              no hint that they exist. The hint below tells the user to scroll.
            */}
            <p className="border-b border-line bg-surface-sunken px-4 py-1.5 text-[11px] text-muted lg:hidden">
              Scroll the table sideways to see role and status →
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-line bg-surface-sunken">
                    {["User", "Role", "Status", "Last active", ""].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {members.map((member) => {
                    const isSelf = member.id === user?.userId;
                    const isOwner = member.role === "owner";
                    return (
                      <tr key={member.id} className="border-b border-line last:border-0 hover:bg-surface-sunken/60">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={member.full_name} email={member.email} size="sm" />
                            <div className="min-w-0">
                              <p className="truncate text-[13px] font-medium text-foreground">
                                {member.full_name}
                                {isSelf && <span className="ml-1.5 text-[11px] text-muted">(you)</span>}
                              </p>
                              <p className="truncate text-[11.5px] text-muted">{member.email}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <Badge tone={roleTone(member.role)}>{humanize(member.role)}</Badge>
                        </td>
                        <td className="px-4 py-3">
                          {member.is_active ? (
                            <Badge tone="success" dot>
                              Active
                            </Badge>
                          ) : (
                            <span title={member.suspension_reason ?? undefined}>
                              <Badge tone="danger" dot>
                                Suspended
                              </Badge>
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-[12.5px] text-muted">
                          {member.last_seen_at ? formatRelative(member.last_seen_at) : "Never"}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {canManage && !isOwner && !isSelf ? (
                            <RowMenu
                              member={member}
                              onChangeRole={() => setRoleTarget(member)}
                              onSuspend={() => setSuspendTarget(member)}
                              onActivate={async () => {
                                try {
                                  await apiRequest(`/api/v1/staff/${member.id}/activate`, {
                                    method: "POST",
                                    token,
                                  });
                                  announce("success", `${member.full_name} has been reactivated.`);
                                  refreshAll();
                                } catch (err) {
                                  announce("danger", (err as ApiError)?.message ?? "Could not reactivate.");
                                }
                              }}
                            />
                          ) : (
                            <span className="text-[11px] text-muted">
                              {isOwner ? "Owner" : isSelf ? "—" : ""}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Pending invitations */}
        {canManage && pendingInvites.length > 0 && (
          <Card>
            <CardContent className="pt-5">
              <p className="mb-3 text-[13px] font-semibold text-foreground">Pending invitations</p>
              <ul className="flex flex-col gap-2">
                {pendingInvites.map((invite) => (
                  <li
                    key={invite.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium text-foreground">{invite.email}</p>
                      <p className="text-[11px] text-muted">
                        {humanize(invite.role)} · expires {formatDate(invite.expires_at)}
                      </p>
                    </div>
                    <Badge tone="warning">Pending</Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </PageStack>

      {inviteOpen && (
        <InviteDialog
          onClose={() => setInviteOpen(false)}
          onDone={(msg) => {
            setInviteOpen(false);
            announce("success", msg);
            refreshAll();
          }}
          onError={(msg) => announce("danger", msg)}
        />
      )}

      {roleTarget && (
        <RoleDialog
          member={roleTarget}
          onClose={() => setRoleTarget(null)}
          onDone={(msg) => {
            setRoleTarget(null);
            announce("success", msg);
            refreshAll();
          }}
          onError={(msg) => announce("danger", msg)}
        />
      )}

      {suspendTarget && (
        <SuspendDialog
          member={suspendTarget}
          onClose={() => setSuspendTarget(null)}
          onDone={(msg) => {
            setSuspendTarget(null);
            announce("success", msg);
            refreshAll();
          }}
          onError={(msg) => announce("danger", msg)}
        />
      )}
    </PageContainer>
  );
}

// ---------------------------------------------------------------------------

function roleTone(role: Role) {
  if (role === "owner") return "brand" as const;
  if (role === "client_user" || role === "publisher_user") return "info" as const;
  return "neutral" as const;
}

function SummaryTile({
  label,
  value,
  icon: Icon,
  tone = "neutral",
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "neutral" | "success" | "danger" | "info";
}) {
  const color =
    tone === "success"
      ? "text-[var(--color-success)]"
      : tone === "danger"
        ? "text-[var(--color-danger)]"
        : tone === "info"
          ? "text-[var(--color-info)]"
          : "text-muted-strong";

  return (
    <Card className="p-4">
      <p className="text-[11.5px] font-medium text-muted">{label}</p>
      <p className="mt-1 text-[22px] font-semibold leading-none tracking-tight text-foreground tabular-nums">
        {value}
      </p>
      <Icon className={cn("mt-2 size-4", color)} aria-hidden />
    </Card>
  );
}

function RowMenu({
  member,
  onChangeRole,
  onSuspend,
  onActivate,
}: {
  member: StaffMember;
  onChangeRole: () => void;
  onSuspend: () => void;
  onActivate: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${member.full_name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[100] min-w-48 rounded-lg border border-line bg-surface-raised p-1 shadow-[var(--shadow-lg)] animate-in-up"
        >
          <DropdownMenu.Item
            onSelect={onChangeRole}
            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground-soft outline-none data-[highlighted]:bg-surface-sunken"
          >
            <ShieldCheck className="size-4" aria-hidden />
            Change role
          </DropdownMenu.Item>
          {member.is_active ? (
            <DropdownMenu.Item
              onSelect={onSuspend}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground-soft outline-none data-[highlighted]:bg-surface-sunken data-[highlighted]:text-danger"
            >
              <Ban className="size-4" aria-hidden />
              Suspend account
            </DropdownMenu.Item>
          ) : (
            <DropdownMenu.Item
              onSelect={onActivate}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground-soft outline-none data-[highlighted]:bg-surface-sunken"
            >
              <CheckCircle2 className="size-4" aria-hidden />
              Reactivate
            </DropdownMenu.Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-slate-950/50 backdrop-blur-[1px] animate-in-up" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[95] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface-raised p-6 shadow-[var(--shadow-lg)]">
          <Dialog.Title className="text-[16px] font-semibold tracking-tight text-foreground">{title}</Dialog.Title>
          {description && <Dialog.Description className="mt-1 text-[13px] leading-relaxed text-muted">{description}</Dialog.Description>}
          <div className="mt-5">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InviteDialog({
  onClose,
  onDone,
  onError,
}: {
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const token = useAccessToken();
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Role>("prospector");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("/api/v1/staff/invite", {
        method: "POST",
        token,
        body: { email, fullName, role },
      }),
    onSuccess: () => onDone(`Invitation sent to ${email}.`),
    onError: (err) => onError((err as ApiError)?.message ?? "Could not send the invitation."),
  });

  // Ownership is transferred, never invited. A publisher_user also needs a
  // supplier binding, which this compact dialog does not collect.
  const assignable = ROLES.filter((r) => r !== "owner" && r !== "publisher_user");

  return (
    <Modal
      title="Invite a user"
      description="They receive an email to set their password. The role you choose here is what they get — it cannot be changed at sign-up."
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="flex flex-col gap-4"
      >
        <Field label="Full name" htmlFor="invite-name">
          <Input id="invite-name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </Field>
        <Field label="Email" htmlFor="invite-email">
          <Input id="invite-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="h-9 rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
          >
            {assignable.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </select>
          <p className="text-[12px] text-muted">{ROLE_DESCRIPTIONS[role]}</p>
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Send invitation
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RoleDialog({
  member,
  onClose,
  onDone,
  onError,
}: {
  member: StaffMember;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const token = useAccessToken();
  const [role, setRole] = useState<Role>(member.role);

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/staff/${member.id}`, { method: "PATCH", token, body: { role } }),
    onSuccess: () => onDone(`${member.full_name} is now ${humanize(role)}.`),
    onError: (err) => onError((err as ApiError)?.message ?? "Could not change the role."),
  });

  const assignable = ROLES.filter((r) => r !== "owner" && r !== "publisher_user");

  return (
    <Modal
      title={`Change role — ${member.full_name}`}
      description="The change takes effect immediately: their sessions are revoked and a new sign-in is required."
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="role-select">Role</Label>
          <select
            id="role-select"
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="h-9 rounded-md border border-line bg-surface px-2.5 text-[13px] text-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring"
          >
            {assignable.map((r) => (
              <option key={r} value={r}>
                {humanize(r)}
              </option>
            ))}
          </select>
          <p className="text-[12px] text-muted">{ROLE_DESCRIPTIONS[role]}</p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={role === member.role}
          >
            Update role
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function SuspendDialog({
  member,
  onClose,
  onDone,
  onError,
}: {
  member: StaffMember;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const token = useAccessToken();
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/v1/staff/${member.id}/suspend`, { method: "POST", token, body: { reason } }),
    onSuccess: () => onDone(`${member.full_name} has been suspended and signed out.`),
    onError: (err) => onError((err as ApiError)?.message ?? "Could not suspend the account."),
  });

  return (
    <Modal
      title={`Suspend ${member.full_name}`}
      description="They are signed out immediately and cannot sign in again until reactivated. Their history and placements are preserved."
      onClose={onClose}
    >
      <div className="flex flex-col gap-4">
        <Field label="Reason" htmlFor="suspend-reason" hint="Recorded in the audit log.">
          <Input
            id="suspend-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Left the company"
            required
          />
        </Field>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => mutation.mutate()}
            loading={mutation.isPending}
            disabled={reason.trim().length < 3}
          >
            <Ban />
            Suspend account
          </Button>
        </div>
      </div>
    </Modal>
  );
}
