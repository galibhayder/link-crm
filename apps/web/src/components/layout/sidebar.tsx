import { NavLink } from "react-router-dom";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/providers/auth";
import { useOptionalUiConfig } from "@/providers/ui-config";
import { visibleNavigation } from "@/config/navigation";
import { BrandLogo } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * Sidebar.
 *
 * Collapses to an icon rail on desktop and becomes an overlay drawer on mobile.
 * The nav is built from the user's permissions AND the organisation's
 * customization, so a section the role cannot use — or that an admin has hidden —
 * never appears at all. Hiding it in CSS would still ship the route.
 */
export function Sidebar({
  collapsed,
  onToggleCollapsed,
  mobileOpen,
  onCloseMobile,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}) {
  const { permissions, user } = useAuth();
  const ui = useOptionalUiConfig();

  const sections = useMemo(
    () =>
      visibleNavigation(permissions, {
        // `modules` is the server's RBAC ∩ config answer. When the config has not
        // loaded yet it is an empty array — treated as "no customization" so the
        // nav behaves exactly as it did before this phase rather than flashing
        // empty on every cold load.
        modules: ui?.config.modules?.length ? ui.config.modules : null,
        labels: ui?.config.labels ?? null,
        sectionLabels: ui?.config.sectionLabels ?? null,
        sectionOrder: null,
        itemOrder: null,
      }),
    [permissions, ui?.config.modules, ui?.config.labels, ui?.config.sectionLabels],
  );

  const appName = ui?.appName || user?.organizationName || "Trivero Marketing";

  return (
    <>
      {/* Mobile scrim */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-[1px] transition-opacity lg:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={onCloseMobile}
        aria-hidden
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-line bg-sidebar",
          "transition-[width,transform] duration-200 ease-out",
          collapsed ? "w-[68px]" : "w-[248px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0",
        )}
        aria-label="Primary navigation"
      >
        {/* Brand */}
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <BrandLogo src={ui?.logoUrl} size={collapsed ? "sm" : "md"} alt={appName} />
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-[14px] font-semibold tracking-tight text-foreground">{appName}</p>
              <p className="truncate text-[11px] text-muted">Link Building CRM</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-3">
          {sections.map((section, index) => (
            <div key={section.id} className={cn(index > 0 && "mt-5")}>
              {!collapsed && (
                <p className="px-2.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted">
                  {section.label}
                </p>
              )}
              {collapsed && index > 0 && <div className="mx-2 mb-3 h-px bg-line" />}
              <ul className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const link = (
                    <NavLink
                      to={item.to}
                      end={item.to === "/"}
                      onClick={onCloseMobile}
                      className={({ isActive }) =>
                        cn(
                          "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium",
                          "transition-colors duration-150",
                          collapsed && "justify-center px-0",
                          isActive
                            ? "bg-sidebar-active text-sidebar-active-fg"
                            : "text-sidebar-fg hover:bg-sidebar-hover hover:text-foreground",
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon
                            className={cn("size-[17px] shrink-0", isActive ? "opacity-100" : "opacity-75")}
                            aria-hidden
                          />
                          {!collapsed && (
                            <span className="flex-1 truncate">{item.label}</span>
                          )}
                          {!collapsed && item.comingSoon && (
                            <span className="rounded bg-line px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide text-muted">
                              Soon
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  );

                  return (
                    <li key={item.to}>
                      {collapsed ? (
                        <Tooltip content={item.label} side="right">
                          {link}
                        </Tooltip>
                      ) : (
                        link
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="border-t border-line p-2">
          {!collapsed && user && (
            <div className="mb-2 flex items-center gap-2 rounded-md bg-surface-sunken px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12px] font-medium text-foreground-soft">
                  {user.email ?? "Signed in"}
                </p>
                <p className="truncate text-[11px] text-muted">{humanRole(user.role)}</p>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={onToggleCollapsed}
            className={cn(
              "hidden w-full items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] font-medium text-muted",
              "hover:bg-sidebar-hover hover:text-foreground lg:flex",
              collapsed && "justify-center px-0",
            )}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>
    </>
  );
}

function humanRole(role: string) {
  const map: Record<string, string> = {
    owner: "Super Admin",
    account_manager: "Account Manager",
    prospector: "Prospector",
    outreach_specialist: "Outreach Specialist",
    content_writer: "Content Writer",
    client_user: "Client",
    publisher_user: "Publisher",
  };
  return map[role] ?? role;
}

/** Small legend shown next to the brand in the sidebar footer on wide screens. */
export function EnvironmentBadge({ environment }: { environment: string }) {
  const tone = environment === "production" ? "success" : environment === "test" ? "warning" : "info";
  return (
    <Badge tone={tone} dot className="pointer-events-none">
      {environment}
    </Badge>
  );
}
