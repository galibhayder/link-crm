import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { pinoHttp } from "pino-http";
import { env, isProd } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { createStaticMiddleware, defaultWebDistPath } from "./middleware/static.js";
import { authenticate } from "./middleware/authenticate.js";
import { admin } from "./integrations/supabase.js";
import { internalRouter } from "./modules/index.js";
import { jobsRouter } from "./modules/jobs/index.js";
import { portalRouter } from "./modules/portal-client/index.js";
import { supplierRouter } from "./modules/portal-supplier/index.js";
import { publicInvoicesRouter } from "./modules/public-invoices/index.js";

export function createApp(): Express {
  const app = express();

  // Behind nginx or a host proxy, so rate-limit and log the real client IP.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("x-request-id", req.requestId);
    next();
  });

  app.use(
    pinoHttp({
      level: env.LOG_LEVEL,
      genReqId: (req) => (req as { requestId?: string }).requestId ?? randomUUID(),
      autoLogging: { ignore: (req) => req.url === "/health/live" },
      redact: {
        // Never log a token, a password, or a service key.
        paths: ["req.headers.authorization", "req.headers.cookie", "req.body.password"],
        censor: "[redacted]",
      },
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );

  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  // ---------------------------------------------------------------------
  // Health — deliberately unauthenticated, and mounted before auth.
  // /live is for the uptime monitor; /ready actually touches the database.
  // ---------------------------------------------------------------------
  app.get("/health/live", (_req, res) => {
    res.json({ data: { status: "ok", uptime: process.uptime() } });
  });

  app.get("/health/ready", async (_req, res) => {
    const started = Date.now();
    const { error } = await admin().from("organizations").select("id", { head: true, count: "exact" });
    const latencyMs = Date.now() - started;

    if (error) {
      res.status(503).json({ data: { status: "degraded", database: "unreachable", latencyMs } });
      return;
    }
    res.json({ data: { status: "ok", database: "reachable", latencyMs } });
  });

  app.get("/health", (_req, res) => res.redirect(307, "/health/live"));

  // ---------------------------------------------------------------------
  // Scheduled work.
  //
  // Mounted BEFORE the token-authenticated routers and with its own HMAC guard,
  // because pg_cron/pg_net call it with a signature and no user token. Putting
  // this behind `authenticate` would make every job permanently unreachable.
  // ---------------------------------------------------------------------
  app.use("/api/v1/internal/jobs", jobsRouter);

  // ---------------------------------------------------------------------
  // Public invoice links.
  //
  // Mounted BEFORE `authenticate` and OUTSIDE every authenticated surface,
  // because the recipient of a shared invoice has no account. The router is
  // guarded by a 256-bit token whose SHA-256 is the only thing stored, sends
  // noindex/no-store headers, and projects from the invoice's frozen snapshot —
  // so it can serve a client-safe document and nothing else.
  // ---------------------------------------------------------------------
  app.use("/public/v1", publicInvoicesRouter);

  // ---------------------------------------------------------------------
  // Three surfaces, three middleware stacks.
  //
  // They are mounted separately on purpose: a client token hitting /api/v1 is
  // rejected by authenticate() before any handler runs, so portal isolation is
  // a structural fact rather than a per-route convention.
  // ---------------------------------------------------------------------
  app.use("/api/v1", authenticate, internalRouter);
  app.use("/portal/v1", authenticate, portalRouter);
  app.use("/supplier/v1", authenticate, supplierRouter);

  // ---------------------------------------------------------------------
  // The compiled React app.
  //
  // Mounted AFTER every API surface and BEFORE the 404 handler, so an unmatched
  // API path still returns JSON while a client-side route such as /invoices/:id
  // returns the shell on a hard refresh. In development Vite serves the SPA and
  // this middleware simply never finds a build to serve.
  // ---------------------------------------------------------------------
  app.use(
    createStaticMiddleware(env.WEB_DIST_PATH || defaultWebDistPath()),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
