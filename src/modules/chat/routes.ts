/**
 * ikbi chat — HTTP route registration (the registerRoutes SEAM).
 *
 * Mounts `POST /chat` from this module's own file (the server never names it).
 * The handler is a thin shell over the session store + tool loop in session.ts:
 * it validates the body, resolves/creates the session, runs one turn, and returns
 * { response, session_id, tools? }.
 */

import type { FastifyInstance } from "fastify";

import { registerRoutes } from "../../server/registry.js";
import type { ChatRequest, ChatResponse } from "./contract.js";
import { sessionStore } from "./session.js";

/** JSON body schema for POST /chat — message required, session_id optional. */
const chatBodySchema = {
  type: "object",
  required: ["message"],
  additionalProperties: false,
  properties: {
    message: { type: "string", minLength: 1 },
    session_id: { type: "string" },
  },
} as const;

registerRoutes("chat", (app: FastifyInstance) => {
  app.post<{ Body: ChatRequest; Reply: ChatResponse }>(
    "/chat",
    { schema: { body: chatBodySchema } },
    async (request, reply) => {
      const { message, session_id } = request.body;
      const session = sessionStore.getOrCreate(session_id);
      const { response, tools } = await session.send(message);
      reply.code(200);
      return { response, session_id: session.id, ...(tools.length > 0 ? { tools } : {}) };
    },
  );
});
