/**
 * ikbi structured logging.
 *
 * Foundational: every component logs through this module. Nothing uses raw
 * `console.*`. Output is structured (JSON via pino), suitable for journald.
 */

import { pino, type Logger } from "pino";

import { config } from "./config.js";

export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env, isTty: boolean = process.stderr.isTTY === true): string {
  const explicit = env.IKBI_LOG_LEVEL?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return isTty ? "silent" : config.logLevel;
}

/** The root logger for the ikbi service. */
export const log: Logger = pino({
  level: resolveLogLevel(),
  base: {
    service: "ikbi",
    version: config.version,
  },
  formatters: {
    // Emit the level as a human-readable string ("info") rather than a number.
    level(label) {
      return { level: label };
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** Create a child logger bound to a named component (e.g. "server", "config"). */
export function childLogger(component: string): Logger {
  return log.child({ component });
}
