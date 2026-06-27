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
import { type Velum } from "./generic.js";
import type { VelumConfig } from "../config/schema.js";
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
export declare function velumExpress(options?: VelumExpressOptions): (req: ExpressRequest, res: ExpressResponse, next: NextFn) => void;
export {};
//# sourceMappingURL=express.d.ts.map