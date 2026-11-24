import { Link } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ChevronRight, LogOut, Menu, Monitor, Moon, Search, Sun, UserRound } from "lucide-react";
import { useTheme } from "@/providers/theme";
import { useAuth } from "@/providers/auth";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { cn, humanize } from "@/lib/utils";
import { NotificationBell } from "@/features/notifications/notification-bell";

export interface Crumb {
  label: string;
  to?: string;
}

export function Header({
  onOpenMobileNav,
  breadcrumbs = [],
}: {
  onOpenMobileNav: () => void;
  breadcrumbs?: Crumb[];
}) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md sm:px-6">
      <Button
        variant="ghost"
        size="icon-sm"
        className="lg:hidden"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <Menu />
      </Button>

      <Breadcrumbs crumbs={breadcrumbs} />

      <div className="ml-auto flex items-center gap-1">
        <SearchButton />
        <NotificationBell />
        <ThemeMenu />
        <UserMenu />
      </div>
    </header>
  );
}

function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  if (crumbs.length === 0) return <div className="min-w-0 flex-1" />;

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex items-center gap-1 text-[13px]">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${i}`} className="flex min-w-0 items-center gap-1">
              {crumb.to && !last ? (
                <Link
                  to={crumb.to}
                  className="truncate rounded px-1 py-0.5 text-muted transition-colors hover:text-foreground"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  className={cn("truncate px-1 py-0.5", last ? "font-medium text-foreground" : "text-muted")}
                  aria-current={last ? "page" : undefined}
                >
                  {crumb.label}
                </span>
              )}
              {!last && <ChevronRight className="size-3.5 shrink-0 text-line-strong" aria-hidden />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * A search affordance that is honest about not existing yet: it is disabled
 * rather than opening an empty palette that looks broken.
 */
function SearchButton() {
  return (
    <button
      type="button"
      disabled
      title="Global search arrives in a later phase"
      className="hidden h-8 items-center gap-2 rounded-md border border-line bg-surface-sunken px-2.5 text-[12.5px] text-muted sm:flex"
    >
      <Search className="size-3.5" aria-hidden />
      <span>Search</span>
      <kbd className="ml-3 rounded border border-line bg-surface px-1 font-sans text-[10px] font-medium text-muted">
        ⌘K
      </kbd>
    </button>
  );
}

function ThemeMenu() {
  const { theme, setTheme, resolved } = useTheme();

  const options = [
    { value: "light" as const, label: "Light", icon: Sun },
    { value: "dark" as const, label: "Dark", icon: Moon },
    { value: "system" as const, label: "System", icon: Monitor },
  ];

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>
          {resolved === "dark" ? <Moon /> : <Sun />}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-[100] min-w-40 rounded-lg border border-line bg-surface-raised p-1 shadow-[var(--shadow-lg)] animate-in-up"
        >
          <DropdownMenu.Label className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
            Appearance
          </DropdownMenu.Label>
          {options.map((option) => {
            const Icon = option.icon;
            return (
              <DropdownMenu.Item
                key={option.value}
                onSelect={() => setTheme(option.value)}
                className={cn(
                  "flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none",
                  "text-foreground-soft data-[highlighted]:bg-surface-sunken data-[highlighted]:text-foreground",
                  theme === option.value && "font-medium text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden />
                <span className="flex-1">{option.label}</span>
                {theme === option.value && <span className="text-brand-600">✓</span>}
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="ml-1 flex items-center rounded-full outline-offset-2 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="Account menu"
        >
          <Avatar name={user?.email} email={user?.email} size="sm" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="z-[100] min-w-56 rounded-lg border border-line bg-surface-raised p-1 shadow-[var(--shadow-lg)] animate-in-up"
        >
          <div className="flex items-center gap-2.5 px-2 py-2">
            <Avatar name={user?.email} email={user?.email} size="md" />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-foreground">{user?.email ?? "Unknown"}</p>
              <p className="truncate text-[11.5px] text-muted">
                {user ? humanize(user.role) : "—"}
              </p>
            </div>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-line" />
          <DropdownMenu.Item asChild>
            <Link
              to="/profile"
              className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground-soft outline-none data-[highlighted]:bg-surface-sunken data-[highlighted]:text-foreground"
            >
              <UserRound className="size-4" aria-hidden />
              Profile settings
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={() => void signOut()}
            className="flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-foreground-soft outline-none data-[highlighted]:bg-surface-sunken data-[highlighted]:text-danger"
          >
            <LogOut className="size-4" aria-hidden />
            Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
