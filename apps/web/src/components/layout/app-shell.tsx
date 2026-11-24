import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { NAV_SECTIONS } from "@/config/navigation";
import { Sidebar } from "./sidebar";
import { Header, type Crumb } from "./header";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "linkforge-sidebar-collapsed";

/**
 * Routes that are not in the navigation, so their breadcrumb has to be declared.
 *
 * Everything else is derived from NAV_SECTIONS. The previous hand-maintained map
 * covered the nav routes only, so adding a route produced a breadcrumb reading
 * "Not found" — which is what the Outreach page showed the first time it loaded.
 */
const EXTRA_CRUMBS: Record<string, Crumb[]> = {
  "/": [{ label: "Dashboard" }],
  "/profile": [{ label: "Your profile" }],
};

/** Nav label per path, built once from the navigation config. */
const NAV_CRUMBS: Record<string, Crumb[]> = Object.fromEntries(
  NAV_SECTIONS.flatMap((section) =>
    section.items.map((item) => [item.to, [{ label: item.label }] as Crumb[]]),
  ),
);

function crumbsFor(pathname: string): Crumb[] {
  const exact = EXTRA_CRUMBS[pathname] ?? NAV_CRUMBS[pathname];
  if (exact) return exact;

  // A nested route such as /clients/123 still belongs under its module, so fall
  // back to the longest nav prefix that matches.
  const prefix = Object.keys(NAV_CRUMBS)
    .filter((p) => p !== "/" && pathname.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0];

  return prefix ? (NAV_CRUMBS[prefix] ?? [{ label: "Not found" }]) : [{ label: "Not found" }];
}

export function AppShell() {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSE_KEY) === "true";
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close the mobile drawer whenever the route changes, otherwise it stays over
  // the page the user just navigated to.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    window.localStorage.setItem(COLLAPSE_KEY, String(collapsed));
  }, [collapsed]);

  const crumbs = useMemo(() => crumbsFor(location.pathname), [location.pathname]);

  return (
    <TooltipProvider>
      <div className="min-h-full bg-background">
        <Sidebar
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
        />

        <div
          className={cn(
            "flex min-h-screen flex-col transition-[padding] duration-200 ease-out",
            collapsed ? "lg:pl-[68px]" : "lg:pl-[248px]",
          )}
        >
          <Header onOpenMobileNav={() => setMobileOpen(true)} breadcrumbs={crumbs} />
          <main id="main" className="flex-1">
            <Outlet />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * Standard page frame: max width, consistent padding, and the entry animation
 * applied once per route rather than per component.
 */
export function PageContainer({
  children,
  className,
  width = "default",
}: {
  children: ReactNode;
  className?: string;
  width?: "default" | "wide" | "narrow";
}) {
  const widths = {
    narrow: "max-w-3xl",
    default: "max-w-[1440px]",
    wide: "max-w-[1760px]",
  } as const;

  return (
    <div className={cn("mx-auto w-full px-4 py-6 sm:px-6 lg:px-8", widths[width], className)}>
      <div className="animate-in-up">{children}</div>
    </div>
  );
}

/** Vertical rhythm for stacked sections inside a page. */
export function PageStack({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-6", className)}>{children}</div>;
}
