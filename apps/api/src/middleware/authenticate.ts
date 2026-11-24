import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { NextFunction, Request, Response } from "express";
import { can, type Permission } from "@crm/shared";
import type { Role, Surface } from "@crm/shared";
import { env } from "../config/env.js";
import { asUser } from "../integrations/supabase.js";
import { Errors } from "../lib/errors.js";

export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
  supplierId: string | null;
  email: string | null;
  /** Caller-scoped Supabase client. RLS applies to everything built from this. */
  db: ReturnType<typeof asUser>;
  surface: Surface;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId: string;
    }
  }
}

/**
 * JWKS is cached by jose and refreshed on unknown key ids, so verification is
 * local — no network call to the auth server per request.
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }
  return jwks;
}

interface CachedProfile {
  role: Role;
  orgId: string;
  supplierId: string | null;
  isActive: boolean;
  expiresAt: number;
}

/**
 * The token is a HINT; the database is the truth.
 *
 * A JWT carries role/org, but a demotion or deactivation does not rewrite an
 * already-issued token. Without this cache check, a demoted user keeps full
 * privileges until their token expires. 60s TTL bounds that window to one
 * minute without a DB round-trip per request.
 */
const profileCache = new Map<string, CachedProfile>();
const PROFILE_TTL_MS = 60_000;

export function clearProfileCache(userId?: string): void {
  if (userId) profileCache.delete(userId);
  else profileCache.clear();
}

async function loadProfile(userId: string, jwtRole: string, jwtOrg: string) {
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached;

  // service-role read: this is identity resolution, not user data access.
  const { admin } = await import("../integrations/supabase.js");
  const { data, error } = await admin()
    .from("profiles")
    .select("role, organization_id, supplier_id, is_active")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) {
    // Fail closed. An unknown user gets no context.
    return null;
  }

  const entry: CachedProfile = {
    role: data.role as Role,
    orgId: data.organization_id,
    supplierId: data.supplier_id ?? null,
    isActive: data.is_active,
    expiresAt: Date.now() + PROFILE_TTL_MS,
  };
  profileCache.set(userId, entry);

  // If the claims disagree with the row, the row wins. This is what makes a
  // role change take effect within the TTL instead of at token expiry.
  if (jwtRole && jwtRole !== entry.role) return entry;
  if (jwtOrg && jwtOrg !== entry.orgId) return entry;

  return entry;
}

export function surfaceOf(path: string): Surface | null {
  if (path.startsWith("/portal/v1")) return "portal";
  if (path.startsWith("/supplier/v1")) return "supplier";
  if (path.startsWith("/api/v1")) return "internal";
  return null;
}

const SURFACE_FOR_ROLE: Record<Role, Surface> = {
  owner: "internal",
  account_manager: "internal",
  prospector: "internal",
  outreach_specialist: "internal",
  content_writer: "internal",
  client_user: "portal",
  publisher_user: "supplier",
};

/**
 * authenticate — verifies the token, loads the authoritative profile, and
 * enforces that this role is on the surface being called.
 *
 * The surface check runs BEFORE any handler or permission check, so a client
 * token on an internal route is a 403 rather than a filtered response. That is
 * the difference between "portal separation" and "portal URL naming".
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw Errors.unauthorized();

    const token = header.slice("Bearer ".length).trim();
    if (!token) throw Errors.unauthorized();

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, getJwks(), {
        audience: "authenticated",
        issuer: `${env.SUPABASE_URL}/auth/v1`,
      });
      payload = verified.payload;
    } catch {
      throw Errors.unauthorized("Invalid or expired token");
    }

    const userId = payload.sub;
    if (!userId) throw Errors.unauthorized("Token has no subject");

    const appMeta = (payload.app_metadata ?? {}) as Record<string, unknown>;
    const jwtRole = typeof appMeta.role === "string" ? appMeta.role : "";
    const jwtOrg = typeof appMeta.org_id === "string" ? appMeta.org_id : "";

    const profile = await loadProfile(userId, jwtRole, jwtOrg);
    if (!profile || !profile.isActive) {
      throw Errors.forbidden("Your account is inactive. Contact an administrator.");
    }

    const surface = surfaceOf(req.baseUrl + req.path) ?? surfaceOf(req.path);
    if (!surface) throw Errors.notFound("Endpoint");

    if (SURFACE_FOR_ROLE[profile.role] !== surface) {
      throw Errors.forbidden("This sign-in type cannot access that area of the application");
    }

    req.auth = {
      userId,
      orgId: profile.orgId,
      role: profile.role,
      supplierId: profile.supplierId,
      email: typeof payload.email === "string" ? payload.email : null,
      db: asUser(token),
      surface,
    };

    next();
  } catch (err) {
    next(err);
  }
}

/** Declares the permission a route requires. Runs after authenticate. */
export function authorize(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) return next(Errors.unauthorized());

    const permitted = permissions.some((p) => can(auth.role, p));
    if (!permitted) {
      return next(Errors.forbidden());
    }
    next();
  };
}

/** Requires the caller to be on a specific surface explicitly. */
export function requireSurface(surface: Surface) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(Errors.unauthorized());
    if (req.auth.surface !== surface) return next(Errors.forbidden());
    next();
  };
}
