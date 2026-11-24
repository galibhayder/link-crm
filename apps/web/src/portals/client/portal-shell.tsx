import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { FileText, LayoutDashboard, LogOut, Megaphone, Monitor, Moon, Receipt, ShieldCheck, Sun } from "lucide-react";
import { APP_NAME } from "@/lib/env";
import { useAuth } from "@/providers/auth";
import { useTheme } from "@/providers/theme";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePortalDrafts } from "./use-portal";

/**
 * CLIENT PORTAL SHELL.
 *
 * Deliberately NOT the internal `AppShell`. That sidebar is generated from the staff
 * permission matrix — mounting it for a client would either render a set of links
 * that 403, or require a per-item permission check that could drift from the API.
 * A separate shell with a hand-written nav for this surface cannot leak an internal
 * module onto a client's screen.
 *
 * Top navigation rather than a rail: a client has three destinations, and a
 * persistent left column for three items wastes a third of a narrow screen.
 */

const NAV = [
  { to: "/portal", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/portal/campaigns", label: "Campaigns", icon: Megaphone, end: false },
  { to: "/portal/drafts", label: "Content", icon: FileText, end: false },
  { to: "/portal/invoices", label: "Invoices", icon: Receipt, end: false },
];

/** Small theme cycler; the internal header has its own inline in a dropdown. */
function ThemeCycle() {
  const { theme, setTheme } = useTheme();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={`Theme: ${theme}. Switch to ${next}`}
      title={`Theme: ${theme}`}
      onClick={() => setTheme(next)}
    >
      <Icon />
    </Button>
  );
}

export function PortalShell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  // A count badge on Content so a client sees there is something waiting without
  // opening the page. Shares the query key with the list, so it costs no extra request.
  const drafts = usePortalDrafts();
  const awaiting = (drafts.data ?? []).filter((d) => d.status === "in_review").length;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-brand-600 text-white">
              <ShieldCheck className="size-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold leading-tight text-foreground">{APP_NAME}</p>
              <p className="truncate text-[10.5px] leading-tight text-muted">Client portal</p>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <span
              className="hidden max-w-[180px] truncate text-[12px] text-muted sm:block"
              title={user?.email ?? ""}
            >
              {user?.email}
            </span>
            <ThemeCycle />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Sign out"
              onClick={() => {
                void Promise.resolve(signOut()).then(() => navigate("/login", { replace: true }));
              }}
            >
              <LogOut />
            </Button>
          </div>
        </div>

        <nav aria-label="Portal" className="mx-auto w-full max-w-6xl px-2 sm:px-4">
          <ul className="flex items-center gap-1 overflow-x-auto pb-1">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition",
                      isActive
                        ? "bg-brand-600/10 text-brand-700 dark:text-brand-300"
                        : "text-muted hover:bg-surface-sunken hover:text-foreground",
                    )
                  }
                >
                  <item.icon className="size-3.5" aria-hidden />
                  {item.label}
                  {item.to === "/portal/drafts" && awaiting > 0 && (
                    <span
                      className="rounded-full bg-[var(--color-warning-soft)] px-1.5 text-[10.5px] font-semibold text-[var(--color-warning)]"
                      aria-label={`${awaiting} awaiting review`}
                    >
                      {awaiting}
                    </span>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>

      <main id="main" className="flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
          <Outlet />
        </div>
      </main>

      <footer className="border-t border-line px-4 py-3">
        <p className="mx-auto max-w-6xl text-[11px] text-muted">
          You are signed in to the client portal. Only campaigns, placements and content
          belonging to your organisation are shown.
        </p>
      </footer>
    </div>
  );
}

/** Shared page header for the portal — simpler than the internal PageHeading. */
export function PortalPageHeading({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
