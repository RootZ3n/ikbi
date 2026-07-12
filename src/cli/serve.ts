/**
 * `ikbi serve` — start the HTTP service.
 *
 * Accepts `--port <n>` to override the config port at the command line.
 * Handles SIGTERM/SIGINT for graceful shutdown.
 */

import { registerCommand } from "./registry.js";
import { config } from "../core/config.js";
import { setReady, startServer } from "../server/index.js";
import { workspaces as coreWorkspaces } from "../core/workspace/index.js";
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
    setReady(false); // stop reporting ready → a load balancer / tailnet peer drains us
    // #2: DRAIN in-flight work. `app.close()` waits for open HTTP requests, but a server-driven BUILD
    // can outlive that window — retain every live workspace first so its work survives shutdown and is
    // inspectable (`ikbi workspace ls`), rather than being orphaned mid-flight. Best-effort + bounded.
    const drain = setTimeout(() => { writeStderr("ikbi: drain timed out, forcing exit\n"); process.exit(1); }, 10_000);
    drain.unref?.();
    try {
      const retained = await coreWorkspaces.retainAllLive(`server shutdown (${signal})`).catch(() => 0);
      if (retained > 0) writeStderr(`ikbi: retained ${retained} in-flight workspace(s) — resume/inspect with \`ikbi workspace ls\`\n`);
      await app.close();
      writeStderr("ikbi: shut down cleanly\n");
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  // `serve` OWNS the process lifecycle: drop the generic CLI signal handlers (the interactive/build
  // retain-and-exit handlers registered by cli/index.ts) so they can't race this graceful shutdown.
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

registerCommand({
  name: "serve",
  summary: "Start the ikbi HTTP service (Fastify)",
  usage: "ikbi serve [--port <n>]",
  run: (argv) => runServe(argv),
});
