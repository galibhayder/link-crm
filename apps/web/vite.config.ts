import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Proxying keeps the browser on one origin in development, so there is no
    // CORS negotiation and no absolute API URL to get wrong. In a split
    // deployment, set VITE_API_URL and the client uses it directly instead.
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: true },
      // `/portal/v1` — NOT `/portal`.
      //
      // The client portal is a second API surface, but `/portal` is ALSO an SPA route.
      // Proxying the bare prefix swallows the app: a page load of /portal/drafts is
      // forwarded to the API and answers "No route for GET /portal/drafts" instead of
      // rendering the router. Only the API prefix is proxied, so client-side
      // navigation and deep links stay on the SPA.
      "/portal/v1": { target: "http://127.0.0.1:3000", changeOrigin: true },
      // The public invoice API. Like /portal this needs an explicit entry: the
      // SPA fallback answers 200 with index.html for any unmatched path, so a
      // missing proxy entry does not produce a 404 — it produces HTML where JSON
      // was expected, and the page silently renders its "link unavailable" state.
      "/public/v1": { target: "http://127.0.0.1:3000", changeOrigin: true },
      "/health": { target: "http://127.0.0.1:3000", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    // Split the heavy, rarely-changing dependencies out of the app chunk so a
    // code change does not invalidate 700kB of vendor code in the browser cache.
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          supabase: ["@supabase/supabase-js"],
          query: ["@tanstack/react-query"],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});
