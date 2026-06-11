/**
 * `ikbi serve` — start the HTTP service.
 *
 * Accepts `--port <n>` to override the config port at the command line.
 * Handles SIGTERM/SIGINT for graceful shutdown.
 */

import { registerCommand } from "./registry.js";
import { config } from "../core/config.js";
import { setReady, startServer } from "../server/index.js";
import { writeStderr } from "./io.js";

async function runServe(argv: readonly string[]): Promise<void> {
  // Parse --port from argv
  let port = config.port;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port" && i + 1 < argv.length) {
      const parsed = Number(argv[i + 1]);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
        port = parsed;
      }
      i++; // skip value
    }
  }

  const app = await startServer({ port });

  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      writeStderr("ikbi: shutdown already in progress, ignoring signal\n");
      return;
    }
    shuttingDown = true;
    writeStderr(`ikbi: received ${signal}, shutting down\n`);
    setReady(false);
    try {
      await app.close();
      writeStderr("ikbi: shut down cleanly\n");
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

registerCommand({
  name: "serve",
  summary: "Start the ikbi HTTP service (Fastify)",
  usage: "ikbi serve [--port <n>]",
  run: (argv) => runServe(argv),
});
