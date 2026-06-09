/**
 * ikbi chat — HTTP route registration (the registerRoutes SEAM).
 *
 * Mounts `POST /chat` from this module's own file (the server never names it).
 * The handler is a thin shell over the session store + tool loop in session.ts:
 * it validates the body, resolves/creates the session, runs one turn, and returns
 * { response, session_id, tools? }.
 *
 * GOVERNANCE BOUNDARY (SG-8): this endpoint is the SINGLE governed boundary external
 * clients (notably the standalone `tui/` package) cross. They never execute tools or
 * import ikbi internals — they POST here, and the tool loop runs SERVER-SIDE inside the
 * governed ChatSession (identity-resolved parent context → governed-exec/gate-wall for
 * `terminal`, the neutralization chokepoint for every result, worktree-confined files).
 * So a TUI tool call is governed identically to a CLI/worker tool call. See SECURITY.md.
 */

import type { FastifyInstance } from "fastify";

import { registerRoutes } from "../../server/registry.js";
import type { ChatRequest, ChatResponse } from "./contract.js";
import { sessionStore } from "./session.js";

/** JSON body schema for POST /chat — message required; session_id + images + mode optional. */
const chatBodySchema = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1 },
    session_id: { type: "string" },
    // Operator-pasted images (data-URLs or http(s) URLs); attached to the turn as multimodal parts.
    images: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 8 },
    // Turn mode: "plan" restricts the loop to read-only tools and returns a plan without changes.
    mode: { type: "string", enum: ["agent", "plan"] },
  },
} as const;

registerRoutes("chat", (app: FastifyInstance) => {
  app.post<{ Body: ChatRequest; Reply: ChatResponse }>(
    "/chat",
    { schema: { body: chatBodySchema } },
    async (request, reply) => {
      const { message, session_id, images, mode } = request.body;
      const session = sessionStore.getOrCreate(session_id);
      const { response, tools, cost, contextPercent } = await session.send(message, images, mode ?? "agent");
      reply.code(200);
      return {
        response,
        session_id: session.id,
        ...(tools.length > 0 ? { tools } : {}),
        cost,
        context_percent: contextPercent,
      };
    },
  );
});
