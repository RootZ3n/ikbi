/**
 * Velum — Express adapter
 * ============================================================
 * Drop-in middleware. Structural types are used instead of importing `express`
 * so Velum keeps zero dependencies; the shapes match Express's req/res/next.
 *
 *   import { velumExpress } from "velum-ai/adapters/express";
 *   app.use(velumExpress({ defaultPiiLevel: 2 }));
 *
 * On each request it:
 *   - classifies `req.body.message` (credentials redacted, injection flagged)
 *   - scans `req.body.messages` context (secrets redacted in place)
 *   - exposes the result on `req.velum`
 *   - guards the JSON/string response body via res.json / res.send
 * ============================================================
 */

import { createVelum, type Velum } from "./generic.js";
import type { VelumConfig } from "../config/schema.js";
import type { ContextScanInput } from "../core/guard.js";
import type { ClassificationResult } from "../core/classify.js";

export interface VelumRequestState {
  velum: Velum;
  classification?: ClassificationResult;
  contextFlags?: string[];
}

interface ExpressRequest {
  body?: unknown;
  [key: string]: unknown;
}

interface ExpressResponse {
  json?: (body: unknown) => unknown;
  send?: (body: unknown) => unknown;
  [key: string]: unknown;
}

type NextFn = (err?: unknown) => void;

export interface VelumExpressOptions extends Partial<VelumConfig> {
  /** Treat refusals as in-character text (default false → neutral refusal). */
  inCharacter?: boolean;
  /** Field on the body holding the single user message (default "message"). */
  messageField?: string;
  /** Field on the body holding the message array (default "messages"). */
  messagesField?: string;
}

export function velumExpress(
  options: VelumExpressOptions = {},
): (req: ExpressRequest, res: ExpressResponse, next: NextFn) => void {
  const { inCharacter = false, messageField = "message", messagesField = "messages", ...config } = options;
  const velum = createVelum(config);

  return function velumMiddleware(req: ExpressRequest, res: ExpressResponse, next: NextFn): void {
    const state = req as unknown as VelumRequestState;
    state.velum = velum;

    if (!velum.enabled) return next();

    const body = (req.body ?? {}) as Record<string, unknown>;

    // Stage 1 — input classification.
    const message = body[messageField];
    if (typeof message === "string") {
      const result = velum.classify(message);
      state.classification = result;
      body[messageField] = result.sanitizedMessage;
    }

    // Stage 2 — context scan.
    const messages = body[messagesField];
    if (Array.isArray(messages)) {
      const ctx = velum.scanContext(messages as ContextScanInput[]);
      state.contextFlags = ctx.flags;
      if (ctx.redactedMessages) body[messagesField] = ctx.redactedMessages;
    }

    // Stage 3 — output guard via res.json / res.send wrappers.
    const originalJson = typeof res.json === "function" ? res.json.bind(res) : undefined;
    const originalSend = typeof res.send === "function" ? res.send.bind(res) : undefined;

    if (originalJson) {
      res.json = (payload: unknown) => originalJson(guardJsonPayload(velum, payload, inCharacter));
    }
    if (originalSend) {
      res.send = (payload: unknown) =>
        originalSend(typeof payload === "string" ? velum.applyOutputGuard(payload, { inCharacter }).text : payload);
    }

    next();
  };
}

/** Guard common response shapes: a bare string, or { text }/{ content }/{ message }. */
function guardJsonPayload(velum: Velum, payload: unknown, inCharacter: boolean): unknown {
  if (typeof payload === "string") return velum.applyOutputGuard(payload, { inCharacter }).text;
  if (payload && typeof payload === "object") {
    const obj = { ...(payload as Record<string, unknown>) };
    for (const key of ["text", "content", "message", "response", "output"]) {
      if (typeof obj[key] === "string") {
        obj[key] = velum.applyOutputGuard(obj[key] as string, { inCharacter }).text;
      }
    }
    return obj;
  }
  return payload;
}
