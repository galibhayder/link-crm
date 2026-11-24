import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { ThemeProvider } from "./theme";
import { AuthProvider } from "./auth";
import { UiConfigProvider } from "./ui-config";
import { ApiError } from "@/lib/api";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      // Never retry an auth or permission failure: retrying a 401 or 403 just
      // multiplies the same rejection and delays the error reaching the user.
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.status === 401 || error.status === 403 || error.status === 404) return false;
        }
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {/*
          UiConfigProvider sits INSIDE AuthProvider because it needs an access
          token to call /admin/ui/effective, and OUTSIDE the router because the
          sidebar and every themed surface read from it.

          It degrades safely when there is no session: the query is disabled and
          the config resolves to empty, which makes `visibleNavigation` behave
          exactly as it did before Phase 7.
        */}
        <AuthProvider>
          <UiConfigProvider>{children}</UiConfigProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
