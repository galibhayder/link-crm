import { createApp } from "./app.js";
import { env } from "./config/env.js";

const app = createApp();

const server = app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
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
