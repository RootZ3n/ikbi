/**
 * ikbi route registrar — the parallel-build SEAM (Step S) for HTTP routes.
 *
 * THE PROBLEM this solves: if every endpoint-exposing module (self-observation
 * status, Peh Q&A, dry-run toggle, kill-switch control) added its routes by
 * editing `server/index.ts`, that one file becomes a write-bottleneck — builders
 * collide on it.
 *
 * THE CONVENTION: a module registers its routes from its OWN file by calling
 * `registerRoutes("<module>", (app) => { ... })`. The server COMPOSES every
 * registration when it builds — it never names individual modules. Each module's
 * registrar runs inside its OWN Fastify encapsulation context (via `app.register`),
 * so a module can mount a `prefix`, add hooks/decorators, and define schemas
 * without leaking into the engine or other modules.
 *
 *     // src/modules/monitoring/routes.ts
 *     import { registerRoutes } from "../../server/registry.js";
 *     registerRoutes("monitoring", async (app) => {
 *       app.get("/status", async () => ({ ... }));
 *     });
 *
 * Registrations are picked up by `buildServer()` in `server/index.ts`. For them to
 * exist at build time the module must be IMPORTED first — that is wired once via
 * the `src/modules/index.ts` barrel (imported by the service entry + the CLI), so
 * importing a module is all it takes to expose its routes. No `server/index.ts` edit.
 */

import type { FastifyInstance } from "fastify";

/** A module's route registrar: receives an (encapsulated) Fastify instance to add routes to. */
export type RouteRegistrar = (app: FastifyInstance) => void | Promise<void>;

/** One registered module's routes. */
export interface RouteRegistration {
  /** The owning module's name (for logs + duplicate detection). */
  readonly module: string;
  /** Adds the module's routes to the (encapsulated) instance it is given. */
  readonly register: RouteRegistrar;
}

/**
 * The process-wide route registry. Modules append at import time; the server
 * applies them when it builds. Append-only and order-preserving.
 */
class RouteRegistry {
  private readonly entries: RouteRegistration[] = [];
  private readonly seen = new Set<string>();

  /** Register a module's routes. Throws on a duplicate module name (a wiring bug). */
  register(module: string, register: RouteRegistrar): void {
    if (this.seen.has(module)) {
      throw new Error(`route registrar for module "${module}" is already registered`);
    }
    this.seen.add(module);
    this.entries.push({ module, register });
  }

  /** All registrations, in registration order. */
  all(): readonly RouteRegistration[] {
    return [...this.entries];
  }

  /** Module names with registered routes (for diagnostics). */
  modules(): string[] {
    return [...this.seen];
  }

  /**
   * Mount every registration onto `app`, each in its OWN encapsulation context.
   * Called by `buildServer()`. Plugins are deferred by Fastify until `ready()` /
   * `listen()`, so this stays synchronous and order-preserving.
   */
  applyTo(app: FastifyInstance): void {
    for (const entry of this.entries) {
      // Each registrar gets its own encapsulation context (own hooks/decorators/
      // prefix). `instance` is the same concrete Fastify type as `app`; modules
      // type their registrar against the standard `FastifyInstance`, so narrow it.
      app.register(async (instance) => {
        await entry.register(instance as unknown as FastifyInstance);
      });
    }
  }

  /** Test-only: clear all registrations. */
  reset(): void {
    this.entries.length = 0;
    this.seen.clear();
  }
}

/** The single canonical route registry. */
export const routes: RouteRegistry = new RouteRegistry();

/** Register a module's HTTP routes (see file header). The convention modules use. */
export function registerRoutes(module: string, register: RouteRegistrar): void {
  routes.register(module, register);
}
