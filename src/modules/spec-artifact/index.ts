/**
 * ikbi spec-artifact — module entrypoint.
 *
 * Wires the dormant step-planner module so plans become first-class editable artifacts.
 */

import type { FastifyInstance } from "fastify";
import { registerRoutes } from "../../server/registry.js";
import { decompose } from "../step-planner/implementation.js";
import type { SpecArtifact, SpecCardFields, SpecStep } from "./contract.js";
import { createSpec, getSpec, updateSpec } from "./store.js";
import { parseStructuredSpec } from "./structured.js";

export type { SpecArtifact, SpecStep, SpecStatus, SpecScope, SpecCardFields } from "./contract.js";
export { createSpec, getSpec, updateSpec, listSpecs } from "./store.js";
export { parseStructuredSpec } from "./structured.js";

/** Map a step-planner step onto a SpecStep, omitting undefined optionals (exactOptional). */
function toSpecStep(s: { index: number; goal: string; targetFiles?: readonly string[]; verificationHint?: string }): SpecStep {
  return {
    index: s.index,
    goal: s.goal,
    ...(s.targetFiles !== undefined ? { targetFiles: s.targetFiles } : {}),
    ...(s.verificationHint !== undefined ? { verificationHint: s.verificationHint } : {}),
  };
}

/** Generate a spec from a plain goal using the step-planner. */
export function generateSpec(goal: string, storeDir?: string, overrides?: SpecCardFields): SpecArtifact {
  const plan = decompose(goal);
  const steps: SpecStep[] = plan.steps.map(toSpecStep);
  return createSpec(goal, steps, storeDir, overrides);
}

/**
 * Generate a spec from a STRUCTURED spec card. The card text is parsed into a GOAL plus
 * the optional PROJECT/SCOPE/RULES/OUTPUT/ON_CONFLICT fields; the step-planner decomposes
 * the GOAL into steps. Additional card fields (corrections, maxCostUsd, maxFilesChanged)
 * the parser does not derive from text are passed through `overrides`.
 */
export function generateStructuredSpec(
  card: string,
  storeDir?: string,
  overrides?: SpecCardFields,
): SpecArtifact {
  const parsed = parseStructuredSpec(card);
  const { goal, ...fields } = parsed;
  const plan = decompose(goal);
  const steps: SpecStep[] = plan.steps.map(toSpecStep);
  return createSpec(goal, steps, storeDir, { ...fields, ...overrides });
}

// ── Route registration ───────────────────────────────────────────────────
registerRoutes("spec-artifact", (app: FastifyInstance) => {
  // Generate spec from goal (plain) or a structured spec card (structured: true)
  app.post("/ikbi/spec/generate", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (!body || typeof body.goal !== "string" || body.goal.trim().length === 0) {
      void reply.code(400);
      return { error: "goal is required" };
    }
    // Non-text card fields the structured parser cannot derive from prose, accepted as
    // direct overrides on the request body (corrections / maxCostUsd / maxFilesChanged).
    const overrides: SpecCardFields = {};
    if (Array.isArray(body.corrections)) {
      (overrides as { corrections?: readonly string[] }).corrections = body.corrections.filter(
        (c): c is string => typeof c === "string",
      );
    }
    if (typeof body.maxCostUsd === "number" && Number.isFinite(body.maxCostUsd)) {
      (overrides as { maxCostUsd?: number }).maxCostUsd = body.maxCostUsd;
    }
    if (typeof body.maxFilesChanged === "number" && Number.isFinite(body.maxFilesChanged)) {
      (overrides as { maxFilesChanged?: number }).maxFilesChanged = body.maxFilesChanged;
    }

    const spec =
      body.structured === true
        ? generateStructuredSpec(body.goal as string, undefined, overrides)
        : generateSpec(body.goal as string, undefined, overrides);
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
