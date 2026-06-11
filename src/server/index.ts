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
import { trust } from "../core/trust/index.js";
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

  app.setErrorHandler((err: unknown, request, reply) => {
    const maybe = err as { statusCode?: unknown; message?: unknown };
    const status = typeof maybe.statusCode === "number" && maybe.statusCode >= 400 && maybe.statusCode < 500 ? maybe.statusCode : 500;
    if (status >= 500) {
      request.log.error({ err }, "request failed");
      void reply.code(500).send({ error: "internal server error" });
      return;
    }
    void reply.code(status).send({ error: typeof maybe.message === "string" ? maybe.message : "bad request" });
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

  // Agent identity — for Ittunaha health probes and inter-agent discovery.
  app.get("/agent", async () => {
    const { runCapabilities } = await import("../cli/capabilities.js");
    const caps = runCapabilities();
    return {
      id: "ikbi",
      name: "ikbi",
      role: "build orchestration, central nervous system",
      model: config.provider.defaultModels.builder ?? config.provider.defaultModels.driver ?? "unknown",
      tools: caps.builder.length,
      status: ready ? "active" : "starting",
      uptime: process.uptime(),
    };
  });

  // Capabilities — tool inventory and feature flags for Ittunaha/agents.
  app.get("/capabilities", async () => {
    const { runCapabilities } = await import("../cli/capabilities.js");
    const caps = runCapabilities();
    return {
      agent: "ikbi",
      tools: caps.builder,
      endpoints: ["/health", "/ready", "/agent", "/capabilities", "/chat"],
      model: config.provider.defaultModels.builder ?? config.provider.defaultModels.driver ?? "unknown",
      features: [
        "tool_calling",
        "governed_execution",
        "injection_defense",
        "trust_model",
        "circuit_breaker",
        "drift_prevention",
        "context_compression",
        "vision_support",
        "mcp_stdio",
        "sub_agent_delegation",
      ],
      toolParity: {
        builder: caps.builder.length,
        chat: caps.chat.length,
        inSync: caps.builderOnly.length === 0 && caps.chatOnly.length === 0,
      },
    };
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
  // M5: warm the trust tier cache BEFORE accepting connections. Without this the resolver
  // fails closed (every agent reads as the trust floor / requires-approval) until the
  // background load finishes — a race where early requests get the wrong, downgraded tier.
  // Awaiting here guarantees the first served request sees earned tiers. Fail-loud: a
  // broken roster surfaces at boot rather than silently degrading every request.
  await trust.preload();
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
