import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, type ApiError } from "@/lib/api";
import { useAccessToken } from "@/providers/auth";
import type { UIConfig } from "@crm/shared";

/**
 * ADMIN CUSTOMIZATION DATA LAYER.
 *
 * Every mutation here goes through the API's validate-and-reject path. Nothing is
 * optimistically applied: a config that the server refuses must not appear to
 * have worked, or an admin would think they had hidden a module when they had not.
 */

export interface AdminConfigResponse {
  config: UIConfig;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  valid: boolean;
}

export interface RegistryModule {
  id: string;
  permission: string | null;
}

export interface Registries {
  modules: RegistryModule[];
  sections: Array<{ id: string; label: string }>;
  columns: Record<string, readonly string[]>;
  widgets: Array<{ id: string; label: string }>;
  rolePermissions: Record<string, string[]>;
}

export const ADMIN_KEYS = {
  config: ["admin-ui", "config"] as const,
  registries: ["admin-ui", "registries"] as const,
};

export function useAdminConfig() {
  const token = useAccessToken();

  return useQuery({
    queryKey: ADMIN_KEYS.config,
    queryFn: async () => {
      const res = await apiRequest<AdminConfigResponse>("/api/v1/admin/ui/config", { token });
      return res.data;
    },
    enabled: Boolean(token),
    // The editor must never show a stale copy: two admins, or one admin in two
    // tabs, would otherwise save over each other's changes.
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useRegistries() {
  const token = useAccessToken();

  return useQuery({
    queryKey: ADMIN_KEYS.registries,
    queryFn: async () => {
      const res = await apiRequest<Registries>("/api/v1/admin/ui/registries", { token });
      return res.data;
    },
    enabled: Boolean(token),
    staleTime: 10 * 60 * 1000,
  });
}

export function useAdminActions() {
  const token = useAccessToken();
  const qc = useQueryClient();

  const invalidate = () => {
    // Both the editor and the live effective config, so the sidebar updates the
    // moment a save succeeds — an admin needs to SEE the change they made.
    void qc.invalidateQueries({ queryKey: ["admin-ui"] });
  };

  const saveConfig = useMutation({
    mutationFn: async (config: UIConfig) => {
      const res = await apiRequest<{ version: number }>("/api/v1/admin/ui/config", {
        method: "PUT",
        body: { config },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const resetSection = useMutation({
    mutationFn: async (section: string) => {
      const res = await apiRequest<{ version: number; config: UIConfig }>("/api/v1/admin/ui/config/reset", {
        method: "POST",
        body: { section },
        token,
      });
      return res.data;
    },
    onSuccess: invalidate,
  });

  const uploadLogo = useMutation({
    mutationFn: async (dataUri: string) => {
      const res = await apiRequest<{ logo_url: string; mime: string; bytes: number }>(
        "/api/v1/settings/org/logo",
        { method: "PUT", body: { dataUri }, token },
      );
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-ui"] });
      // The logo rides on the auth profile, so refresh that too or the sidebar
      // would keep the old mark until the next sign-in.
      void qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });

  const removeLogo = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("/api/v1/settings/org/logo", { method: "DELETE", token });
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin-ui"] });
      void qc.invalidateQueries({ queryKey: ["auth"] });
    },
  });

  return { saveConfig, resetSection, uploadLogo, removeLogo };
}

export function adminErrorMessage(err: unknown): string {
  const apiErr = err as ApiError;
  // A 403 from this API is meaningful: it usually means the config would have
  // widened access, and the server said so in the message.
  return apiErr?.message ?? "Something went wrong";
}
