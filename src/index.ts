/**
 * ikbi service entry point.
 *
 * Wires up structured logging, starts the HTTP service, and installs a clean
 * shutdown path for SIGTERM/SIGINT. The shutdown handler is the seam for the
 * kill-switch / graceful-degradation work to come — for now it drains the
 * server, logs, and exits 0.
 */

import { config } from "./core/config.js";
import { log } from "./core/log.js";
import { setReady, startServer } from "./server/index.js";

async function main(): Promise<void> {
  log.info({ env: config.env, stateRoot: config.stateRoot }, "ikbi starting");

  const app = await startServer();

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      log.warn({ signal }, "shutdown already in progress, ignoring signal");
      return;
    }
    shuttingDown = true;

    log.info({ signal }, "received shutdown signal, draining");
    setReady(false);

    try {
      // Drain in-flight requests and close listeners.
      await app.close();
      log.info({ signal }, "ikbi shut down cleanly");
      process.exit(0);
    } catch (err) {
      log.error({ err, signal }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  log.fatal({ err }, "ikbi failed to start");
  process.exit(1);
});
