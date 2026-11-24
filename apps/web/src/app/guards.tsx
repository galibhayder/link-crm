import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { Permission, Surface } from "@crm/shared";
import { useAuth } from "@/providers/auth";
import { PageContainer } from "@/components/layout/app-shell";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/card";
import { ShieldAlert } from "lucide-react";

/** Full-page loading state, shown while the session is being resolved. */
export function FullPageLoader({ label = "Loading your workspace" }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
      <div className="flex size-11 items-center justify-center rounded-lg bg-brand-600 text-white">
        <svg viewBox="0 0 24 24" className="size-5 animate-pulse" fill="none" aria-hidden>
          <path d="M9 15l6-6M8 12H6a4 4 0 000 8h2M16 12h2a4 4 0 010 8h-2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </div>
      <div className="w-56 space-y-2">
        <Skeleton className="h-2.5 w-full" />
        <Skeleton className="mx-auto h-2.5 w-2/3" />
      </div>
      <p className="text-[13px] text-muted">{label}…</p>
    </div>
  );
}

/**
 * Requires a session. Redirects to /login and remembers where the user was
 * heading, so the redirect back after sign-in lands where they intended.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") return <FullPageLoader />;
  if (status === "anonymous" || status === "error") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}

/** Keeps an authenticated user off the login screen. */
export function RedirectIfAuthenticated({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  if (status === "loading") return <FullPageLoader label="Checking your session" />;
  if (status === "authenticated") return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * Requires the session to belong to a particular surface.
 *
 * This is the route-layer half of keeping the client portal and the internal CRM
 * apart. It is NOT the security boundary — `authenticate` rejects a portal token on
 * `/api/v1` before any handler runs, which is what actually protects the data. This
 * exists so a person who lands on the wrong tree is sent to their own workspace
 * rather than shown an "access denied" page for a product they do have.
 *
 * Three layers, deliberately:
 *   route  — this guard, so a typed URL does not render the wrong shell
 *   UI     — the portal has its own shell; the internal sidebar is never mounted
 *   API    — the real boundary, enforced server-side
 */
export function RequireSurface({ surface }: { surface: Surface }) {
  const { status, user } = useAuth();

  if (status === "loading") return <FullPageLoader label="Checking your access" />;
  if (!user) return <Navigate to="/login" replace />;

  if (user.surface !== surface) {
    // Send them where they belong instead of refusing them. A client typing "/"
    // should land in their portal; a member of staff typing "/portal" should land
    // in the CRM.
    return <Navigate to={user.surface === "portal" ? "/portal" : "/"} replace />;
  }

  return <Outlet />;
}

/**
 * Permission gate for a route.
 *
 * This is convenience, not security: the API rejects the request regardless.
 * It exists so a user who lacks a permission sees an explanation instead of an
 * empty page that looks broken.
 */
export function RequirePermission({ permission, children }: { permission: Permission; children: React.ReactNode }) {
  const { can, user } = useAuth();

  if (!can(permission)) {
    return (
      <PageContainer>
        <EmptyState
          icon={ShieldAlert}
          title="You don't have access to this section"
          description={
            user
              ? `Your role (${user.role.replace(/_/g, " ")}) doesn't include this permission. An administrator can grant it in Staff & Roles.`
              : "Your account doesn't include this permission."
          }
          action={
            <Button variant="secondary" size="sm" onClick={() => window.history.back()}>
              Go back
            </Button>
          }
        />
      </PageContainer>
    );
  }
  return <>{children}</>;
}

/** Route-level error boundary fallback. */
export function RouteErrorState({ error }: { error: Error }) {
  return (
    <PageContainer>
      <ErrorState
        title="This page couldn't load"
        description={error.message}
        onRetry={() => window.location.reload()}
      />
    </PageContainer>
  );
}
