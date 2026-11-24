import pino from "pino";
import { env, isProd } from "../config/env.js";

/**
 * Shared structured logger.
 *
 * One instance so that modules which are not handling a request (audit writes,
 * scheduled work) still emit through the same pipeline and level as the HTTP
 * logger.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  // Pretty output is a development nicety; production stays JSON for shipping.
  transport: isProd
    ? undefined
    : {
        target: "pino/file",
        options: { destination: 1 },
      },
  redact: {
    paths: ["*.password", "*.token", "*.access_token", "*.refresh_token", "*.secret"],
    censor: "[redacted]",
  },
});
