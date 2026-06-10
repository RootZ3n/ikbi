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

import { timingSafeEqual } from "node:crypto";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { registerRoutes } from "../../server/registry.js";
import type { ChatRequest, ChatResponse } from "./contract.js";
// NOTE (L10): the HTTP endpoint uses the IN-MEMORY `sessionStore` (RAM-only, LRU-evicted), while
// the REPL (`ikbi repl`, cli.ts) uses the disk-backed `persistentStore`. This split is INTENTIONAL:
// HTTP sessions are ephemeral request/response state that should not survive a restart or leak a
// transcript to disk, whereas REPL sessions are long-lived and resumable (`--continue`/`--resume`).
// The two stores are deliberately NOT unified.
import { sessionStore, type PermissionMode } from "./session.js";

/**
 * The shared chat auth token (IKBI_CHAT_TOKEN), read PER REQUEST so the env can be set/cleared
 * by the operator (and by tests) without a process restart. Trimmed; empty ⇒ "no token configured".
 */
function chatToken(): string | undefined {
  const t = process.env.IKBI_CHAT_TOKEN?.trim();
  return t !== undefined && t.length > 0 ? t : undefined;
}

/** Constant-time compare of a presented secret against the configured token (length-safe). */
function tokenMatches(presented: string, token: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(token, "utf8");
  // timingSafeEqual requires equal lengths; compare lengths first (this leak is acceptable — the
  // token length is not the secret), then a constant-time byte compare on equal-length buffers.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the bearer credential from an `Authorization: Bearer <token>` header, or undefined. */
function bearerOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim();
}

/**
 * AUTH PRE-HANDLER for POST /chat (H1). The /chat endpoint runs the SERVER-SIDE tool loop —
 * including mutating tools — so an unauthenticated caller on a Tailscale/public bind must never
 * reach "auto" permissions.
 *
 *  - IKBI_CHAT_TOKEN set: require `Authorization: Bearer <token>`; reject 401 on missing/mismatch.
 *  - IKBI_CHAT_TOKEN unset: the request is allowed but DOWNGRADED to readonly (see resolvePermissionMode).
 */
async function chatAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = chatToken();
  if (token === undefined) return; // no token configured ⇒ allowed, but forced readonly downstream
  const presented = bearerOf(request.headers.authorization);
  if (presented === undefined || !tokenMatches(presented, token)) {
    reply.code(401);
    await reply.send({ error: "unauthorized: POST /chat requires a valid Bearer token (IKBI_CHAT_TOKEN)" });
  }
}

/**
 * The permission mode a network-originated /chat turn runs at: an authenticated request (token
 * configured AND verified by chatAuth) gets full "auto"; with NO token configured, the endpoint
 * is open but every session is forced to "readonly" so no mutating tool executes (H1).
 */
function resolvePermissionMode(): PermissionMode {
  return chatToken() !== undefined ? "auto" : "readonly";
}

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
    { schema: { body: chatBodySchema }, preHandler: chatAuth },
    async (request, reply) => {
      const { message, session_id, images, mode } = request.body;
      const session = sessionStore.getOrCreate(session_id);
      // H1: network-originated turns run at the resolved permission mode — "auto" only when an
      // IKBI_CHAT_TOKEN is configured (and was verified by chatAuth); "readonly" otherwise.
      const permissionMode = resolvePermissionMode();
      const { response, tools, cost, contextPercent } = await session.send(message, images, mode ?? "agent", { permissionMode });
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
