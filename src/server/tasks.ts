/**
 * ikbi HTTP task routes — the external-agent integration surface (Phase 10.1, the
 * foundation for Pehlichi↔ikbi delegation).
 *
 * Mounts on the registerRoutes SEAM (the server never names this module):
 *   POST /api/build              — submit a build task            → 202 { taskId }
 *   POST /api/fix                — submit a fix task              → 202 { taskId }
 *   GET  /api/tasks              — list tasks (status/limit/offset)
 *   GET  /api/tasks/:taskId      — one task's status + result
 *   POST /api/tasks/:taskId/cancel — cooperatively cancel a running task
 *   GET  /api/tasks/:taskId/stream — SSE progress stream (see task-stream.ts)
 *
 * AUTH (H1): an OPTIONAL bearer token (IKBI_API_TOKEN). When set, every /api route
 * requires `Authorization: Bearer <token>`; when unset, the API is open (local-network
 * / Tailscale posture, matching the server's bind default). Read PER REQUEST so the
 * operator can set/clear it without a restart.
 *
 * The handlers are a thin shell over {@link TaskService}: validate the body + capacity,
 * kick off the run async, and return 202. Tests register `registerTaskRoutes` on a fresh
 * Fastify app with an injected service (no model key / worktree needed).
 */

import { existsSync, statSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { registerRoutes } from "./registry.js";
import { taskService, type TaskService } from "./task-service.js";
import { toPublicTask, type TaskStatus } from "./task-registry.js";
import { registerTaskStream } from "./task-stream.js";

/** The shared API token (IKBI_API_TOKEN), read per request. Trimmed; empty ⇒ "no token". */
function apiToken(): string | undefined {
  const t = process.env.IKBI_API_TOKEN?.trim();
  return t !== undefined && t.length > 0 ? t : undefined;
}

/** Constant-time compare of a presented secret against the configured token (length-safe). */
function tokenMatches(presented: string, token: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the bearer credential from `Authorization: Bearer <token>`, or undefined. */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim();
}

/**
 * OPTIONAL bearer-auth pre-handler. When IKBI_API_TOKEN is set, reject (401) any request
 * without a matching bearer; when unset, allow (local-network posture). Unlike /chat, the
 * API does NOT refuse-open — it is the explicitly local-only integration surface.
 */
async function apiAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = apiToken();
  if (token === undefined) return; // no token configured ⇒ open (local network)
  const presented = bearerOf(request.headers.authorization);
  if (presented === undefined || !tokenMatches(presented, token)) {
    reply.code(401);
    await reply.send({ error: "unauthorized: a valid Bearer token (IKBI_API_TOKEN) is required" });
  }
}

const buildBodySchema = {
  type: "object",
  required: ["goal", "repo"],
  additionalProperties: false,
  properties: {
    goal: { type: "string", minLength: 1 },
    repo: { type: "string", minLength: 1 },
    builderMode: { type: "string", enum: ["agent", "patch"] },
    priority: { type: "string" },
  },
} as const;

const fixBodySchema = {
  type: "object",
  required: ["repo"],
  additionalProperties: false,
  properties: {
    repo: { type: "string", minLength: 1 },
    check: { type: "string" },
    goal: { type: "string" },
    allowTestEdits: { type: "boolean" },
  },
} as const;

/** True iff `repo` is an existing directory on disk. */
function repoExists(repo: string): boolean {
  try {
    return existsSync(repo) && statSync(repo).isDirectory();
  } catch {
    return false;
  }
}

const VALID_STATUSES: readonly TaskStatus[] = ["running", "success", "failure", "cancelled"];

/** Parse + validate the optional `status` query filter. Returns undefined when absent/invalid-ignored. */
function parseStatus(raw: unknown): TaskStatus | undefined {
  return typeof raw === "string" && (VALID_STATUSES as readonly string[]).includes(raw) ? (raw as TaskStatus) : undefined;
}

/** Parse a non-negative integer query param, or undefined. */
function parseNonNegInt(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

interface BuildBody { goal: string; repo: string; builderMode?: "agent" | "patch"; priority?: string }
interface FixBody { repo: string; check?: string; goal?: string; allowTestEdits?: boolean }
interface TaskParams { taskId: string }
interface TaskListQ { status?: string; limit?: string; offset?: string }

/**
 * Register all task routes on `app`, bound to `service`. Production calls this from the
 * registerRoutes seam with the live singleton; tests call it on a bare app with a fake service.
 */
export function registerTaskRoutes(app: FastifyInstance, service: TaskService): void {
  app.addHook("preHandler", apiAuth);

  app.post<{ Body: BuildBody }>("/api/build", { schema: { body: buildBodySchema } }, async (request, reply) => {
    const { goal, repo, builderMode, priority } = request.body;
    if (!repoExists(repo)) {
      reply.code(400);
      return { error: `repo "${repo}" does not exist or is not a directory` };
    }
    if (!service.credentialsConfigured()) {
      reply.code(503);
      return { error: "build unavailable: IKBI_OPERATOR_TOKEN and IKBI_WORKER_TOKEN must be configured" };
    }
    if (service.atCapacity()) {
      reply.code(429);
      return { error: "too many concurrent tasks (limit 3); retry once a running task finishes" };
    }
    const taskId = service.submitBuild({ goal, repo, ...(builderMode !== undefined ? { builderMode } : {}), ...(priority !== undefined ? { priority } : {}) });
    reply.code(202);
    return { taskId, status: "accepted", message: "Build task accepted" };
  });

  app.post<{ Body: FixBody }>("/api/fix", { schema: { body: fixBodySchema } }, async (request, reply) => {
    const { repo, check, goal, allowTestEdits } = request.body;
    if (!repoExists(repo)) {
      reply.code(400);
      return { error: `repo "${repo}" does not exist or is not a directory` };
    }
    if (!service.credentialsConfigured()) {
      reply.code(503);
      return { error: "fix unavailable: IKBI_OPERATOR_TOKEN and IKBI_WORKER_TOKEN must be configured" };
    }
    if (service.atCapacity()) {
      reply.code(429);
      return { error: "too many concurrent tasks (limit 3); retry once a running task finishes" };
    }
    const taskId = service.submitFix({ repo, ...(check !== undefined ? { check } : {}), ...(goal !== undefined ? { goal } : {}), ...(allowTestEdits !== undefined ? { allowTestEdits } : {}) });
    reply.code(202);
    return { taskId, status: "accepted", message: "Fix task accepted" };
  });

  app.get<{ Querystring: TaskListQ }>("/api/tasks", async (request, reply) => {
    const status = parseStatus(request.query.status);
    const limit = parseNonNegInt(request.query.limit);
    const offset = parseNonNegInt(request.query.offset);
    const { tasks, total } = service.registry.list({ ...(status !== undefined ? { status } : {}), ...(limit !== undefined ? { limit } : {}), ...(offset !== undefined ? { offset } : {}) });
    reply.code(200);
    return { tasks: tasks.map(toPublicTask), total };
  });

  app.get<{ Params: TaskParams }>("/api/tasks/:taskId", async (request, reply) => {
    const state = service.registry.get(request.params.taskId);
    if (state === undefined) {
      reply.code(404);
      return { error: `task "${request.params.taskId}" not found` };
    }
    reply.code(200);
    return toPublicTask(state);
  });

  app.post<{ Params: TaskParams }>("/api/tasks/:taskId/cancel", async (request, reply) => {
    const { taskId } = request.params;
    const state = service.registry.get(taskId);
    if (state === undefined) {
      reply.code(404);
      return { error: `task "${taskId}" not found` };
    }
    if (state.status !== "running") {
      reply.code(409);
      return { error: `task "${taskId}" is not running (status: ${state.status})` };
    }
    service.cancel(taskId);
    reply.code(200);
    return { taskId, status: "cancelled" };
  });

  // SSE progress stream — shares this registrar's encapsulation context + auth pre-handler.
  registerTaskStream(app, service);
}

// Register the LIVE routes against the global registry (the server composes them; no
// server/index.ts edit). The modules barrel imports the server module set, exposing them.
registerRoutes("tasks", (app: FastifyInstance) => {
  registerTaskRoutes(app, taskService);
});
