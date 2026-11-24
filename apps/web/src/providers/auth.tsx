import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session } from "@supabase/supabase-js";
import type { Permission, Role, Surface } from "@crm/shared";
import { getSupabase, isAuthConfigured } from "../lib/supabase.js";
import { apiRequest, onUnauthorized, ApiError } from "../lib/api.js";

/**
 * The shape the API returns from /api/v1/me. It is deliberately narrower than
 * the Supabase user: the API has already resolved the profile from the database,
 * which is why the role here is authoritative rather than token-derived.
 */
export interface CurrentUser {
  userId: string;
  email: string | null;
  role: Role;
  organizationId: string;
  supplierId: string | null;
  surface: Surface;
  /**
   * Organisation branding, delivered with the identity response.
   *
   * The sidebar, login screen and invoice header all need the logo and business
   * name on the first paint after sign-in; `/me` is already the one call every
   * session makes, so the branding rides along rather than costing a second
   * round trip on the critical path.
   */
  organizationName: string | null;
  logoUrl: string | null;
  brandColor: string | null;
}

interface MeResponse {
  userId: string;
  email: string | null;
  role: Role;
  organizationId: string;
  supplierId?: string | null;
  surface: Surface;
  permissions?: Permission[];
  fullName?: string | null;
  organizationName?: string | null;
  logoUrl?: string | null;
  brandColor?: string | null;
}

/**
 * Which surface a session belongs to, read from the access token.
 *
 * Supabase puts `app_metadata` in the JWT, and only the server can write it —
 * unlike `user_metadata`, which a user can set themselves and which would let them
 * forge their own role. Decoding the payload here is not a trust decision: it
 * chooses which endpoint to call, and the API verifies the same claim server-side.
 * A wrong guess produces a 403, not elevated access.
 */
function surfaceFromToken(accessToken: string): Surface | null {
  try {
    const payload = accessToken.split(".")[1];
    if (!payload) return null;
    // base64url → base64, then decode. `atob` handles the padding rejection.
    const normalised = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(normalised)) as { app_metadata?: { role?: string } };
    const role = claims.app_metadata?.role;

    switch (role) {
      case "client_user":
        return "portal";
      case "publisher_user":
        return "supplier";
      case "owner":
      case "account_manager":
      case "prospector":
      case "outreach_specialist":
      case "content_writer":
        return "internal";
      default:
        return null;
    }
  } catch {
    // An unparseable token is not fatal — fall through to the internal endpoint,
    // which will reject it with a clear error.
    return null;
  }
}

export type AuthStatus = "loading" | "anonymous" | "authenticated" | "error";

interface AuthContextValue {
  status: AuthStatus;
  user: CurrentUser | null;
  permissions: Permission[];
  session: Session | null;
  error: string | null;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (permission: Permission) => boolean;
  canAny: (permissions: Permission[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Avoids a state update after unmount during async sign-in.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * When any API call returns 401 the session is gone — expired, or revoked by
   * an administrator. Drop to anonymous so the route guard redirects to /login,
   * instead of leaving the user on a screen whose data silently failed to load.
   */
  useEffect(() => {
    onUnauthorized(() => {
      if (!mounted.current) return;
      setUser(null);
      setPermissions([]);
      setSession(null);
      setStatus("anonymous");
    });
    return () => onUnauthorized(null);
  }, []);

  /**
   * Resolve the caller against the API.
   *
   * This is a second round-trip after Supabase auth, and it is not redundant:
   * the API checks is_active and role against the database, so a demoted or
   * deactivated user is rejected here even with a still-valid token.
   *
   * WHICH ENDPOINT DEPENDS ON THE SURFACE.
   *
   * `authenticate` rejects a token whose role belongs to another surface, so a
   * client_user calling `/api/v1/me` gets a 403 before any handler runs. That is
   * correct — it is the isolation this app depends on — but it meant a client could
   * never sign in at all. The surface is read from the token's `app_metadata.role`,
   * the same claim the database trusts, which only the server can set (never
   * `user_metadata`, which a user could forge).
   *
   * A `publisher_user` has no portal UI yet, so it keeps the internal endpoints and
   * is refused with a clear message rather than being sent to a screen that does not
   * exist.
   */
  const loadMe = useCallback(async (accessToken: string) => {
    const surface = surfaceFromToken(accessToken);
    const isClientPortal = surface === "portal";
    const base = isClientPortal ? "/portal/v1" : "/api/v1";

    try {
      const me = await apiRequest<MeResponse>(`${base}/me`, { token: accessToken });
      const profile = await apiRequest<{ role: Role; permissions: Permission[]; surface: Surface }>(
        `${base}/me/permissions`,
        { token: accessToken },
      );

      if (!mounted.current) return;
      setUser({
        userId: me.data.userId,
        email: me.data.email,
        role: me.data.role,
        organizationId: me.data.organizationId,
        supplierId: me.data.supplierId ?? null,
        // The server's answer wins over the token's claim: the token says where we
        // looked, the response says where the account actually belongs.
        surface: profile.data.surface ?? me.data.surface,
        organizationName: me.data.organizationName ?? null,
        logoUrl: me.data.logoUrl ?? null,
        brandColor: me.data.brandColor ?? null,
      });
      setPermissions(profile.data.permissions ?? []);
      setStatus("authenticated");
      setError(null);
    } catch (err) {
      if (!mounted.current) return;

      if (err instanceof ApiError && err.status === 403) {
        // Correct credentials but no access: a publisher account, or a deactivated
        // one. Say so plainly rather than looping on the login form.
        setError(
          err.message ||
            "This account cannot access this area. Publisher portal accounts are not yet available.",
        );
        setStatus("anonymous");
        setUser(null);
        setPermissions([]);
        await getSupabase()?.auth.signOut();
        return;
      }

      if (err instanceof ApiError && err.isAuthError) {
        setStatus("anonymous");
        setUser(null);
        setPermissions([]);
        return;
      }

      setError(err instanceof Error ? err.message : "Could not reach the API");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const supabase = getSupabase();

    if (!supabase) {
      // No Supabase config: the UI still renders, with an explicit notice
      // instead of an infinite spinner.
      setStatus("anonymous");
      setError("Authentication is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
      return;
    }

    let cancelled = false;

    void supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session);
      if (data.session) {
        void loadMe(data.session.access_token);
      } else {
        setStatus("anonymous");
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;

      setSession(nextSession);

      if (event === "SIGNED_OUT" || !nextSession) {
        setUser(null);
        setPermissions([]);
        setStatus("anonymous");
        return;
      }

      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") {
        void loadMe(nextSession.access_token);
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [loadMe]);

  const signIn = useCallback(async (email: string, password: string) => {
    const supabase = getSupabase();
    if (!supabase) throw new Error("Authentication is not configured");

    setError(null);
    setStatus("loading");

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });

    if (signInError) {
      setStatus("anonymous");
      // Supabase returns "Invalid login credentials" for both a bad password and
      // an unknown address. Preserve that ambiguity rather than enumerating
      // which addresses exist.
      throw new Error(signInError.message);
    }

    if (data.session) {
      setSession(data.session);
      await loadMe(data.session.access_token);
    }
  }, [loadMe]);

  const signOut = useCallback(async () => {
    await getSupabase()?.auth.signOut();
    setUser(null);
    setPermissions([]);
    setSession(null);
    setStatus("anonymous");
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    const supabase = getSupabase();
    const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : null;
    if (token) await loadMe(token);
  }, [loadMe]);

  const can = useCallback((permission: Permission) => permissions.includes(permission), [permissions]);
  const canAny = useCallback(
    (list: Permission[]) => list.some((p) => permissions.includes(p)),
    [permissions],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      permissions,
      session,
      error,
      configured: isAuthConfigured,
      signIn,
      signOut,
      refresh,
      can,
      canAny,
    }),
    [status, user, permissions, session, error, signIn, signOut, refresh, can, canAny],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}

/** The access token, for API calls. Null when anonymous. */
export function useAccessToken(): string | null {
  const { session } = useAuth();
  return session?.access_token ?? null;
}
