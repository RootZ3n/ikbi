/**
 * ikbi spec-artifact — module entrypoint.
 *
 * Wires the dormant step-planner module so plans become first-class editable artifacts.
 */

import type { FastifyInstance } from "fastify";
import { registerRoutes } from "../../server/registry.js";
import { decompose } from "../step-planner/implementation.js";
import type { SpecArtifact, SpecStep } from "./contract.js";
import { createSpec, getSpec, updateSpec } from "./store.js";

export type { SpecArtifact, SpecStep, SpecStatus } from "./contract.js";
export { createSpec, getSpec, updateSpec, listSpecs } from "./store.js";

/** Generate a spec from a goal using the step-planner. */
export function generateSpec(goal: string, storeDir?: string): SpecArtifact {
  const plan = decompose(goal);
  const steps: SpecStep[] = plan.steps.map((s) => ({
    index: s.index,
    goal: s.goal,
    targetFiles: s.targetFiles,
    verificationHint: s.verificationHint,
  }));
  return createSpec(goal, steps, storeDir);
}

// ── Route registration ───────────────────────────────────────────────────
registerRoutes("spec-artifact", (app: FastifyInstance) => {
  // Generate spec from goal
  app.post("/ikbi/spec/generate", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body.goal !== "string" || body.goal.trim().length === 0) {
      void reply.code(400);
      return { error: "goal is required" };
    }
    const spec = generateSpec(body.goal as string);
    void reply.code(201);
    return spec;
  });

  // Get a spec
  app.get<{ Params: { id: string } }>("/ikbi/spec/:id", async (request, reply) => {
    const { id } = request.params;
    const spec = getSpec(id);
    if (!spec) {
      void reply.code(404);
      return { error: `spec "${id}" not found` };
    }
    return spec;
  });

  // Edit a spec (user can modify steps before execution)
  app.patch<{ Params: { id: string } }>("/ikbi/spec/:id", async (request, reply) => {
    const { id } = request.params;
    const patch = request.body as Record<string, unknown>;
    const existing = getSpec(id);
    if (!existing) {
      void reply.code(404);
      return { error: `spec "${id}" not found` };
    }
    if (existing.status !== "draft") {
      void reply.code(400);
      return { error: "can only edit specs in draft status" };
    }
    const updated = updateSpec(id, patch as Parameters<typeof updateSpec>[1]);
    return updated;
  });

  // Execute a spec
  app.post<{ Params: { id: string } }>("/ikbi/spec/:id/execute", async (request, reply) => {
    const { id } = request.params;
    const spec = getSpec(id);
    if (!spec) {
      void reply.code(404);
      return { error: `spec "${id}" not found` };
    }
    if (spec.status === "executing") {
      void reply.code(409);
      return { error: "spec is already executing" };
    }

    // Mark as executing
    updateSpec(id, { status: "executing" });

    // Execute each step (placeholder — would delegate to worker-model)
    try {
      const outputs: string[] = [];
      for (const step of spec.steps) {
        outputs.push(`Step ${step.index}: ${step.goal} — received`);
      }
      const result = updateSpec(id, { status: "completed", output: outputs.join("\n") });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const result = updateSpec(id, { status: "failed", error });
      return result;
    }
  });
});
