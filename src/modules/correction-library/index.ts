/**
 * ikbi correction-library — module entrypoint.
 *
 * Stores reusable lessons learned from build failures. Corrections are PROPOSED
 * (approved=false) and only take effect once an operator APPROVES them — the
 * refuter (and any future analyzer) may file proposals, but governance never lets
 * a self-discovered lesson silently rewrite future behavior (fail-closed).
 *
 * Routes:
 *   POST   /ikbi/corrections            — propose a correction
 *   GET    /ikbi/corrections            — list (query: category, approved)
 *   GET    /ikbi/corrections/:id        — get one
 *   PATCH  /ikbi/corrections/:id/approve — approve
 *   DELETE /ikbi/corrections/:id        — reject / delete
 */

import type { FastifyInstance } from "fastify";
import { registerRoutes } from "../../server/registry.js";
import { isCorrectionCategory, type CorrectionFilter } from "./contract.js";
import {
  createCorrection,
  getCorrection,
  listCorrections,
  approveCorrection,
  rejectCorrection,
} from "./store.js";

export type {
  CorrectionEntry,
  CorrectionCategory,
  CorrectionFilter,
  CorrectionProposeInput,
} from "./contract.js";
export { CORRECTION_CATEGORIES, isCorrectionCategory } from "./contract.js";
export {
  createCorrection,
  getCorrection,
  listCorrections,
  approveCorrection,
  rejectCorrection,
  recordApplication,
  resolveStoreDir,
} from "./store.js";

// ── Route registration ───────────────────────────────────────────────────
registerRoutes("correction-library", (app: FastifyInstance) => {
  // Propose a correction
  app.post("/ikbi/corrections", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (
      !body ||
      typeof body.category !== "string" ||
      !isCorrectionCategory(body.category) ||
      typeof body.finding !== "string" ||
      body.finding.trim().length === 0 ||
      typeof body.correction !== "string" ||
      body.correction.trim().length === 0 ||
      typeof body.regression !== "string" ||
      body.regression.trim().length === 0
    ) {
      void reply.code(400);
      return { error: "category (valid), finding, correction, and regression are required" };
    }
    const entry = createCorrection({
      category: body.category,
      finding: body.finding as string,
      correction: body.correction as string,
      regression: body.regression as string,
      ...(typeof body.sourceRunId === "string" ? { sourceRunId: body.sourceRunId } : {}),
      ...(typeof body.proposedBy === "string" ? { proposedBy: body.proposedBy } : {}),
      ...(typeof body.approved === "boolean" ? { approved: body.approved } : {}),
    });
    void reply.code(201);
    return entry;
  });

  // List corrections (optional category / approved filters)
  app.get("/ikbi/corrections", async (request) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const filter: CorrectionFilter = {};
    if (typeof query.category === "string" && isCorrectionCategory(query.category)) {
      (filter as { category?: typeof filter.category }).category = query.category;
    }
    if (query.approved === "true" || query.approved === "false") {
      (filter as { approved?: boolean }).approved = query.approved === "true";
    }
    const corrections = listCorrections(filter);
    return { corrections, count: corrections.length };
  });

  // Get a single correction
  app.get<{ Params: { id: string } }>("/ikbi/corrections/:id", async (request, reply) => {
    const { id } = request.params;
    const entry = getCorrection(id);
    if (!entry) {
      void reply.code(404);
      return { error: `correction "${id}" not found` };
    }
    return entry;
  });

  // Approve a correction
  app.patch<{ Params: { id: string } }>("/ikbi/corrections/:id/approve", async (request, reply) => {
    const { id } = request.params;
    const updated = approveCorrection(id);
    if (!updated) {
      void reply.code(404);
      return { error: `correction "${id}" not found` };
    }
    return updated;
  });

  // Reject / delete a correction
  app.delete<{ Params: { id: string } }>("/ikbi/corrections/:id", async (request, reply) => {
    const { id } = request.params;
    const deleted = rejectCorrection(id);
    if (!deleted) {
      void reply.code(404);
      return { error: `correction "${id}" not found` };
    }
    return { deleted: true };
  });
});
