import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

/**
 * Bind explicitly. A reverse proxy (xCloud/nginx, Hostinger, etc.) connects to
 * 127.0.0.1; a server that binds only `localhost` can end up on IPv6 `::1` and
 * answer nothing there, producing a 502 while the process looks healthy. Set
 * HOST=0.0.0.0 when something outside the host must reach it directly.
 */
const host = process.env.HOST || "127.0.0.1";

const server = app.listen(env.PORT, host, () => {
  console.log(`[api] listening on http://${host}:${env.PORT} (${env.NODE_ENV})`);
});

/**
 * Graceful shutdown: stop accepting connections, then exit. Without this a
 * deploy leaves in-flight invoice numbering and payment writes half-applied.
 */
function shutdown(signal: string) {
  console.log(`[api] ${signal} received, draining connections`);
  server.close((err) => {
    if (err) {
      console.error("[api] error during shutdown", err);
      process.exit(1);
    }
    process.exit(0);
  });
  // Don't hang forever on a stuck socket.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
