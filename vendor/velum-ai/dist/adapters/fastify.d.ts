/**
 * Velum — Fastify adapter
 * ============================================================
 * Registers Velum hooks on a Fastify instance. Structural types are used
 * instead of importing `fastify` so Velum keeps zero dependencies; the shapes
 * match Fastify's hook signatures.
 *
 *   import { velumFastify } from "velum-ai/adapters/fastify";
 *   velumFastify(fastify, { defaultPiiLevel: 2 });
 *
 * Hooks:
 *   onRequest  — classify req.body.message (credentials redacted, injection flagged)
 *   preHandler — scanContext over req.body.messages (secrets redacted in place)
 *   onSend     — applyOutputGuard over the serialized response payload
 * ============================================================
 */
import type { VelumConfig } from "../config/schema.js";
export interface VelumFastifyOptions extends Partial<VelumConfig> {
    inCharacter?: boolean;
    messageField?: string;
    messagesField?: string;
}
type HookDone = (err?: unknown) => void;
interface FastifyLike {
    decorateRequest?: (name: string, value: unknown) => void;
    addHook(name: "onRequest" | "preHandler", handler: (req: any, reply: any, done: HookDone) => void): void;
    addHook(name: "onSend", handler: (req: any, reply: any, payload: any, done: (err: unknown, payload?: any) => void) => void): void;
}
export declare function velumFastify(fastify: FastifyLike, opts?: VelumFastifyOptions): void;
export {};
//# sourceMappingURL=fastify.d.ts.map