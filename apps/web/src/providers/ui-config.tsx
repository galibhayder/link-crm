import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccessToken, useAuth } from "@/providers/auth";
import { apiRequest } from "@/lib/api";

/**
 * UI CONFIGURATION PROVIDER.
 *
 * Loads `GET /admin/ui/effective` once per session and exposes:
 *   - the modules this user may reach (already RBAC ∩ config, computed server-side)
 *   - their labels, theme and branding
 *
 * THE CLIENT DOES NOT RE-DERIVE PERMISSIONS. It renders what the API said. That is
 * deliberate: a second implementation of "which modules can this role see" is a
 * second place for the rule to drift, and the drift would be invisible until
 * someone saw a module they should not.
 *
 * The theme is applied by overriding the `--color-brand-*` CSS variables on the
 * document root. Those are plain CSS variables (not compiled Tailwind values), so
 * this needs no rebuild and takes effect immediately.
 */

export interface EffectiveUi {
  modules: string[];
  labels: Record<string, string | null>;
  sectionLabels: Record<string, string | null>;
  theme: {
    accent?: string;
    sidebar?: string;
    radius?: "sharp" | "default" | "round";
  };
  branding: {
    appName?: string;
    tagline?: string;
  };
  dashboard: {
    hidden?: string[];
    order?: string[];
  };
  tables: Record<string, { columns?: string[]; order?: string[]; pageSize?: number }>;
  version: number;
  valid: boolean;
  role: string;
}

const EMPTY: EffectiveUi = {
  modules: [],
  labels: {},
  sectionLabels: {},
  theme: {},
  branding: {},
  dashboard: {},
  tables: {},
  version: 0,
  valid: true,
  role: "",
};

interface UiConfigContextValue {
  config: EffectiveUi;
  isLoading: boolean;
  /** A module is visible when the server said so. Never computed here. */
  canSeeModule: (moduleId: string) => boolean;
  /** The custom label, or null to use the built-in one. */
  labelFor: (moduleId: string) => string | null;
  sectionLabel: (sectionId: string) => string | null;
  /** The logo, from the org row rather than the config document. */
  logoUrl: string | null;
  appName: string;
  refresh: () => void;
}

const UiConfigContext = createContext<UiConfigContextValue | null>(null);

/**
 * Derives a full brand ramp from one accent colour.
 *
 * Tailwind's `brand-50…900` scale is used throughout the app, so overriding only
 * `brand-600` would leave buttons, hovers and focus rings on the old hue — the UI
 * would look half-recoloured. This mixes the accent toward white and black to
 * build the neighbouring steps.
 *
 * The math is deliberately simple (linear blend in sRGB) because it only has to
 * produce a coherent ramp from a user-chosen colour, not perceptual uniformity.
 */
function brandRamp(accent: string): Record<string, string> {
  const hex = accent.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return {};

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  const blend = (channel: number, target: number, amount: number) =>
    Math.round(channel + (target - channel) * amount);

  const toHex = (cr: number, cg: number, cb: number) =>
    `#${[cr, cg, cb].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;

  // Steps toward white (50–400) and toward black (700–900).
  const lighten = (amount: number) => toHex(blend(r, 255, amount), blend(g, 255, amount), blend(b, 255, amount));
  const darken = (amount: number) => toHex(blend(r, 0, amount), blend(g, 0, amount), blend(b, 0, amount));

  return {
    "--color-brand-50": lighten(0.94),
    "--color-brand-100": lighten(0.88),
    "--color-brand-200": lighten(0.76),
    "--color-brand-300": lighten(0.6),
    "--color-brand-400": lighten(0.36),
    "--color-brand-500": lighten(0.16),
    "--color-brand-600": accent,
    "--color-brand-700": darken(0.16),
    "--color-brand-800": darken(0.32),
    "--color-brand-900": darken(0.46),
  };
}

const RADIUS: Record<string, Record<string, string>> = {
  sharp: { "--radius-sm": "2px", "--radius-md": "3px", "--radius-lg": "4px", "--radius-xl": "6px" },
  default: {},
  round: { "--radius-sm": "8px", "--radius-md": "12px", "--radius-lg": "18px", "--radius-xl": "24px" },
};

export function UiConfigProvider({ children }: { children: ReactNode }) {
  const token = useAccessToken();
  const { status, user } = useAuth();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["admin-ui", "effective"],
    queryFn: async () => {
      const res = await apiRequest<EffectiveUi>("/api/v1/admin/ui/effective", { token });
      return res.data;
    },
    /*
     * INTERNAL SURFACE ONLY.
     *
     * `/api/v1/admin/ui/effective` lives on the internal router, which rejects a
     * `client_user` token with 403 before any handler runs. Without this gate every
     * portal page load fired a request that could only fail, and the console
     * filled with 403s that looked like a bug in the portal.
     *
     * A client has no customizable navigation, so there is nothing to fetch.
     */
    enabled: Boolean(token) && status === "authenticated" && user?.surface === "internal",
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const config = query.data ?? EMPTY;

  // ---- theme -------------------------------------------------------------
  useEffect(() => {
    const root = document.documentElement;

    // Everything the theme touches, so a change can be reverted cleanly instead of
    // leaving the previous organisation's colours behind on sign-out.
    const applied: string[] = [];

    const accent = config.theme?.accent;
    if (accent) {
      const ramp = brandRamp(accent);
      for (const [prop, value] of Object.entries(ramp)) {
        root.style.setProperty(prop, value);
        applied.push(prop);
      }
      // The focus ring is a separate token; leaving it on the old hue would show a
      // mismatched outline on every focused control.
      root.style.setProperty("--ring", accent);
      applied.push("--ring");
    }

    const sidebar = config.theme?.sidebar;
    if (sidebar) {
      root.style.setProperty("--sidebar-active-bg", `${sidebar}14`);
      root.style.setProperty("--sidebar-active-fg", sidebar);
      applied.push("--sidebar-active-bg", "--sidebar-active-fg");
    }

    const radius = config.theme?.radius;
    if (radius && RADIUS[radius]) {
      for (const [prop, value] of Object.entries(RADIUS[radius])) {
        root.style.setProperty(prop, value);
        applied.push(prop);
      }
    }

    return () => {
      for (const prop of applied) root.style.removeProperty(prop);
    };
  }, [config.theme?.accent, config.theme?.sidebar, config.theme?.radius]);

  // ---- document title + branding -----------------------------------------
  const appName = config.branding?.appName ?? "";
  useEffect(() => {
    if (!appName) return;
    const previous = document.title;
    document.title = `${appName} — Link Building CRM`;
    return () => {
      document.title = previous;
    };
  }, [appName]);

  const canSeeModule = useCallback(
    (moduleId: string) => config.modules.includes(moduleId),
    [config.modules],
  );

  const labelFor = useCallback(
    (moduleId: string) => config.labels[moduleId] ?? null,
    [config.labels],
  );

  const sectionLabel = useCallback(
    (sectionId: string) => config.sectionLabels[sectionId] ?? null,
    [config.sectionLabels],
  );

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["admin-ui"] });
  }, [qc]);

  const value = useMemo<UiConfigContextValue>(
    () => ({
      config,
      isLoading: query.isLoading,
      canSeeModule,
      labelFor,
      sectionLabel,
      // `user.logoUrl` comes from the auth profile, which reads `organizations`.
      logoUrl: (user as { logoUrl?: string | null } | null)?.logoUrl ?? null,
      appName: appName || "Trivero Marketing",
      refresh,
    }),
    [config, query.isLoading, canSeeModule, labelFor, sectionLabel, user, appName, refresh],
  );

  return <UiConfigContext.Provider value={value}>{children}</UiConfigContext.Provider>;
}

export function useUiConfig() {
  const ctx = useContext(UiConfigContext);
  if (!ctx) throw new Error("useUiConfig must be used inside UiConfigProvider");
  return ctx;
}

/**
 * Safe accessor for components rendered OUTSIDE the provider.
 *
 * The public invoice page and the login screen mount without a session, so they
 * cannot be inside `UiConfigProvider`. This returns nulls rather than throwing —
 * a missing provider is a layout fact there, not a bug.
 */
export function useOptionalUiConfig() {
  return useContext(UiConfigContext);
}
