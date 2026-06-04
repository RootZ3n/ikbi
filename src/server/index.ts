/**
 * ikbi HTTP service skeleton.
 *
 * Binds IKBI_BIND_HOST:IKBI_PORT (localhost by default — reachable over Tailscale,
 * never public unless IKBI_ALLOW_PUBLIC_BIND=true).
 *
 * Phase 0 exposes ONLY health/lifecycle endpoints. No engine routes yet.
 */

import Fastify from "fastify";

import { config } from "../core/config.js";
import { log } from "../core/log.js";
import { routes } from "./registry.js";

/**
 * Readiness flag. Flipped to `true` once the service has fully started, and back
 * to `false` when shutdown begins. This is the seam for the kill-switch /
 * graceful-degradation work to come.
 */
let ready = false;

/** Mark the service ready (or not) to serve traffic. */
export function setReady(value: boolean): void {
  ready = value;
}

/** Build the Fastify instance and register the Phase 0 routes. */
export function buildServer() {
  const app = Fastify({
    // Reuse our structured root logger rather than letting Fastify spin up its own.
    loggerInstance: log,
    disableRequestLogging: false,
  });

  // Liveness — the process is up and answering.
  app.get("/health", async () => {
    return { status: "ok", service: "ikbi", version: config.version };
  });

  // Readiness — the service is fully started and willing to take work.
  app.get("/ready", async (_req, reply) => {
    if (!ready) {
      reply.code(503);
      return { status: "starting", ready: false };
    }
    return { status: "ready", ready: true };
  });

  // Compose every module's routes via the route-registrar SEAM. Modules register
  // from their own files (see server/registry.ts) — this file never names them,
  // so endpoint-exposing modules are added WITHOUT editing server/index.ts. Each
  // registrar runs in its own Fastify encapsulation context.
  routes.applyTo(app as unknown as Parameters<typeof routes.applyTo>[0]);

  return app;
}

/** Build, start, and bind the server. Returns the running instance. */
export async function startServer() {
  const app = buildServer();
  await app.listen({ host: config.bindHost, port: config.port });
  setReady(true);
  log.info(
    {
      bindHost: config.bindHost,
      port: config.port,
      allowPublicBind: config.allowPublicBind,
    },
    "ikbi service listening",
  );
  return app;
}
