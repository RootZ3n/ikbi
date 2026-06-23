/**
 * ikbi job-cards — module entrypoint.
 *
 * Reusable, named, bounded automations with guardrails, receipts, and trust model integration.
 */

export type {
  AccessPolicy,
  Guardrails,
  JobCard,
  JobCardResult,
  JobCardRun,
  JobCardRunStatus,
  RollbackPolicy,
  SchedulePolicy,
  VerificationPolicy,
} from "./contract.js";

export { BUILTINS, getBuiltin } from "./builtins.js";
export { listCards, getCard, createCard, updateCard, deleteCard, createRun, updateRun, listRuns } from "./store.js";
export { runCard, realRunnerDeps, type RunnerDeps } from "./runner.js";

// ── Route registration ───────────────────────────────────────────────────
import type { FastifyInstance } from "fastify";
import { registerRoutes } from "../../server/registry.js";
import { listCards, getCard, createCard, updateCard, deleteCard, listRuns } from "./store.js";
import { BUILTINS } from "./builtins.js";
import { runCard, realRunnerDeps } from "./runner.js";

registerRoutes("job-cards", (app: FastifyInstance) => {
  // List all cards (builtins + user-created)
  app.get("/ikbi/job-cards", async () => {
    const stored = listCards();
    const all = [...BUILTINS, ...stored];
    return { cards: all, count: all.length };
  });

  // Get a single card
  app.get<{ Params: { id: string } }>("/ikbi/job-cards/:id", async (request, reply) => {
    const { id } = request.params;
    const builtin = BUILTINS.find((c) => c.id === id);
    const card = builtin ?? getCard(id);
    if (!card) {
      void reply.code(404);
      return { error: `job card "${id}" not found` };
    }
    return card;
  });

  // Create a card
  app.post("/ikbi/job-cards", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body.name !== "string" || typeof body.goalTemplate !== "string") {
      void reply.code(400);
      return { error: "name and goalTemplate are required" };
    }
    const card = createCard({
      name: body.name as string,
      description: (body.description as string) ?? "",
      goalTemplate: body.goalTemplate as string,
      accessPolicy: (body.accessPolicy as "read-only" | "write-gated" | "write-auto") ?? "read-only",
      // Default blast-radius cap: 50 changed files. `maxFilesChanged: 0` would mean "no limit"
      // (Bubbles LOW-2) — never the safe default. A read-only card simply never writes; a
      // write-* card without explicit guardrails is still bounded to 50 files.
      guardrails: (body.guardrails as { maxFilesChanged: number; protectedPaths: readonly string[]; requireCleanWorktree: boolean }) ?? { maxFilesChanged: 50, protectedPaths: [], requireCleanWorktree: false },
      verification: (body.verification as "required" | "optional" | "skip") ?? "optional",
      rollback: (body.rollback as "on-failure" | "never" | "always") ?? "on-failure",
      schedule: (body.schedule as "once" | "loop") ?? "once",
      minTrustTier: (body.minTrustTier as string) ?? "provisional",
    });
    void reply.code(201);
    return card;
  });

  // Update a card
  app.patch<{ Params: { id: string } }>("/ikbi/job-cards/:id", async (request, reply) => {
    const { id } = request.params;
    const patch = request.body as Record<string, unknown>;
    const updated = updateCard(id, patch as Parameters<typeof updateCard>[1]);
    if (!updated) {
      void reply.code(404);
      return { error: `job card "${id}" not found` };
    }
    return updated;
  });

  // Delete a card
  app.delete<{ Params: { id: string } }>("/ikbi/job-cards/:id", async (request, reply) => {
    const { id } = request.params;
    if (id.startsWith("builtin-")) {
      void reply.code(400);
      return { error: "cannot delete built-in job cards" };
    }
    const deleted = deleteCard(id);
    if (!deleted) {
      void reply.code(404);
      return { error: `job card "${id}" not found` };
    }
    return { deleted: true };
  });

  // Execute a card
  app.post<{ Params: { id: string } }>("/ikbi/job-cards/:id/run", async (request, reply) => {
    const { id } = request.params;
    const builtin = BUILTINS.find((c) => c.id === id);
    const card = builtin ?? getCard(id);
    if (!card) {
      void reply.code(404);
      return { error: `job card "${id}" not found` };
    }
    const body = (request.body ?? {}) as Record<string, string>;
    const result = await runCard(card, body, realRunnerDeps);
    return result;
  });

  // Run history for a card
  app.get<{ Params: { id: string } }>("/ikbi/job-cards/:id/runs", async (request, reply) => {
    const { id } = request.params;
    const builtin = BUILTINS.find((c) => c.id === id);
    const card = builtin ?? getCard(id);
    if (!card) {
      void reply.code(404);
      return { error: `job card "${id}" not found` };
    }
    const runs = listRuns(id);
    return { runs, count: runs.length };
  });
});
