/**
 * Velum — Guarded Tool-Call Wrapper
 * ============================================================
 * The credential buffer is Velum's killer feature, but today every product
 * wires the hand-off by hand. `guardToolCall` packages the full orchestrator
 * flow into one call:
 *
 *   1. Scan the tool *arguments* for injection/secrets before dispatch. A
 *      poisoned argument (e.g. injected instructions smuggled through a search
 *      query) blocks the call.
 *   2. Auto-resolve `[REDACTED-CREDENTIAL]` placeholders in the args back to the
 *      real values from the credential buffer right before the tool runs — so
 *      the model never sees the secret, but the tool still authenticates.
 *   3. Scan the tool's *return value* via scanContext before it re-enters the
 *      model context.
 *
 * Pehlichi (the orchestrator) passes `req.credentialBufferIds` from guardRequest
 * straight into `bufferIds` here. Buffer values are single-use, so each
 * placeholder consumes one id in order.
 * ============================================================
 */
import { type ContextScanResult, type Decision } from "./guard.js";
import { type PatternRegistry } from "./patterns.js";
/** The literal placeholder classify() leaves in place of a redacted secret. */
export declare const CREDENTIAL_PLACEHOLDER = "[REDACTED-CREDENTIAL]";
export interface GuardToolCallInput {
    toolName: string;
    /** Tool arguments — object, array, or string. Walked for string leaves. */
    args: unknown;
    /** Credential buffer ids from guardRequest, consumed to fill placeholders. */
    bufferIds?: string[];
    /**
     * Optional dispatcher. When provided, guardToolCall runs the whole flow:
     * scan args → resolve placeholders → dispatch(resolvedArgs) → scan result.
     * When omitted, the caller dispatches and may scan the return value via the
     * returned `scanResult` helper.
     */
    dispatch?: (resolvedArgs: unknown) => unknown | Promise<unknown>;
}
export interface GuardToolCallResult {
    toolName: string;
    /** False when the args were blocked (injection/secret) — do not dispatch. */
    allowed: boolean;
    /** Decision from scanning the arguments. */
    decision: Decision;
    /** Args with credential placeholders resolved (only when allowed). */
    resolvedArgs: unknown;
    /** The context scan over the arguments. */
    argsScan: ContextScanResult;
    reasons: string[];
    /** Guarded tool return value (only present when `dispatch` was provided). */
    result?: unknown;
    /** Context scan over the tool's return value. */
    resultScan?: ContextScanResult;
    /** Scan an arbitrary tool return value through the context guard. */
    scanResult: (value: unknown) => {
        value: unknown;
        scan: ContextScanResult;
    };
}
/**
 * Guard a tool call end-to-end. See {@link GuardToolCallInput}.
 */
export declare function guardToolCall(input: GuardToolCallInput, registry?: PatternRegistry): Promise<GuardToolCallResult>;
//# sourceMappingURL=tool-guard.d.ts.map