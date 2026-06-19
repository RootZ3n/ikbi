/**
 * ikbi HTTP task SSE stream — GET /api/tasks/:taskId/stream (Phase 10.1).
 *
 * A Server-Sent Events stream of a single task's live progress. It subscribes to the
 * `worker.*` and `task.*` event buses, filters to THIS task's id, and translates each event
 * into a named SSE event (role_started / tool_activity / role_completed / escalation /
 * task_completed). The subscription is torn down on ANY terminal signal — natural completion
 * (worker.completed/failed, task.completed), cancellation (task.cancelled), an error
 * (task.error) — on client disconnect, OR after an idle timeout (H4), so a stream can never
 * leak a subscription + open socket when its task stops emitting.
 *
 * The handler HIJACKS the Fastify reply and writes raw SSE frames to the socket, so the
 * normal serializer / error handler never touches the response.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { events as coreEvents } from "../core/events/index.js";
import type { EventBusSurface, IkbiEvent, Subscription } from "../core/events/index.js";
import type { TaskService } from "./task-service.js";
import { toPublicTask } from "./task-registry.js";

/** Map a worker event to its SSE (event-name, data) pair, or null when it carries no stream signal. */
export function mapWorkerEventToSse(e: IkbiEvent): { event: string; data: Record<string, unknown> } | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case "worker.role.dispatched":
      return { event: "role_started", data: { role: String(p.role ?? "?"), ...(typeof p.tier === "string" ? { tier: p.tier } : {}) } };
    case "worker.builder.activity":
      return {
        event: "tool_activity",
        data: { tool: "builder", summary: `${String(p.toolRounds ?? 0)} tool round(s), ${String(p.filesWritten ?? 0)} file(s) written` },
      };
    case "worker.role.completed":
      return { event: "role_completed", data: { role: String(p.role ?? "?"), outcome: String(p.outcome ?? "?"), ...(typeof p.costUsd === "number" ? { cost: p.costUsd } : {}) } };
    case "worker.escalation.retried":
      return { event: "escalation", data: { from: p.fromModel ?? null, to: String(p.toModel ?? "?"), reason: p.success === true ? "cheap-tier builder failed; escalated retry" : "cheap-tier builder failed; escalated retry did not converge" } };
    default:
      return null; // verification / trust / approval etc. are reflected in the polled state, not the stream
  }
}

/** Write one SSE frame (named event + JSON data) to a raw socket. */
function writeSse(raw: NodeJS.WritableStream, event: string, data: Record<string, unknown>): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Terminal event types that close the stream (natural completion, cancellation, error). */
const TERMINAL_EVENT_TYPES = new Set(["worker.completed", "worker.failed", "task.completed", "task.cancelled", "task.error"]);

/** Default idle timeout (ms) before an inactive stream is force-closed. Overridable via env (H4). */
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 30_000;

/** Resolve the SSE idle timeout, read per request so an operator can tune it without a restart. */
function sseIdleTimeoutMs(): number {
  const raw = Number(process.env.IKBI_SSE_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SSE_IDLE_TIMEOUT_MS;
}

/**
 * Register the SSE stream route on `app`, bound to `service`. Called from the tasks
 * registrar (so it shares the same encapsulation context + auth pre-handler).
 */
export function registerTaskStream(app: FastifyInstance, service: TaskService, bus: EventBusSurface = coreEvents): void {
  app.get<{ Params: { taskId: string } }>("/api/tasks/:taskId/stream", async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
    const { taskId } = request.params;
    const state = service.registry.get(taskId);
    if (state === undefined) {
      reply.code(404);
      return { error: `task "${taskId}" not found` };
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Take over the response — Fastify will not serialize or finalize it for us.
    reply.hijack();
    const raw = reply.raw;

    let closed = false;
    let sub: Subscription | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const idleMs = sseIdleTimeoutMs();
    const close = (): void => {
      if (closed) return;
      closed = true;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      sub?.unsubscribe();
      raw.end();
    };
    // (Re)arm the idle timeout — any frame resets it; an idle stream is force-closed (H4). The
    // timer is unref'd so it never holds the process open on its own.
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (closed) return;
        writeSse(raw, "timeout", { reason: "idle", afterMs: idleMs });
        close();
      }, idleMs);
      idleTimer.unref?.();
    };
    const emit = (event: string, data: Record<string, unknown>): void => {
      writeSse(raw, event, data);
      armIdle();
    };

    // Replay the current snapshot so a late subscriber immediately knows where the task stands.
    emit("snapshot", toPublicTask(state));

    // If the task already finished (or is cancelling), emit the terminal frame and close now.
    if (state.status !== "running") {
      writeSse(raw, "task_completed", { status: state.status, totalCost: state.totalCost });
      close();
      return reply;
    }

    // Subscribe to BOTH worker.* progress and task.* terminal signals (cancel/error/completed).
    sub = bus.subscribe(
      { predicate: (e) => e.type.startsWith("worker.") || e.type.startsWith("task."), label: `sse:${taskId}` },
      (e: IkbiEvent) => {
        if (closed) return;
        const p = (e.payload ?? {}) as Record<string, unknown>;
        if (p.taskId !== taskId) return;
        if (TERMINAL_EVENT_TYPES.has(e.type)) {
          const current = service.registry.get(taskId);
          writeSse(raw, "task_completed", { status: current?.status ?? "failure", totalCost: current?.totalCost ?? 0 });
          close();
          return;
        }
        const mapped = mapWorkerEventToSse(e);
        if (mapped !== null) emit(mapped.event, mapped.data);
      },
    );

    // Clean up when the client disconnects.
    request.raw.on("close", close);
    return reply;
  });
}
