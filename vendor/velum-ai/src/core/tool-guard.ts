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

import { scanContext, type ContextScanResult, type Decision } from "./guard.js";
import { consumeCredential } from "./credential-buffer.js";
import { registry as defaultRegistry, type PatternRegistry } from "./patterns.js";
import { emitReceipt } from "./receipts.js";

/** The literal placeholder classify() leaves in place of a redacted secret. */
export const CREDENTIAL_PLACEHOLDER = "[REDACTED-CREDENTIAL]";

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
  scanResult: (value: unknown) => { value: unknown; scan: ContextScanResult };
}

/** Walk a value, transforming every string leaf (bounded by structure). */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn);
    return out;
  }
  return value;
}

/** Collect string leaves into a context-message array for scanning. */
function toMessages(value: unknown, role: string): { role: string; content: unknown }[] {
  if (typeof value === "string") return [{ role, content: value }];
  return [{ role, content: value }];
}

/**
 * Resolve `[REDACTED-CREDENTIAL]` placeholders to real buffered values. Each
 * occurrence consumes the next available buffer id (single-use), so the secret
 * lands in the tool args without ever passing through the model.
 */
function resolvePlaceholders(args: unknown, bufferIds: string[]): { resolved: unknown; used: number } {
  if (bufferIds.length === 0) return { resolved: args, used: 0 };
  const queue = [...bufferIds];
  let used = 0;
  const resolved = mapStrings(args, (s) => {
    if (!s.includes(CREDENTIAL_PLACEHOLDER)) return s;
    return s.replace(new RegExp(escapeRegExp(CREDENTIAL_PLACEHOLDER), "g"), () => {
      const id = queue.shift();
      if (id === undefined) return CREDENTIAL_PLACEHOLDER; // ran out of values
      const value = consumeCredential(id);
      if (value === null) return CREDENTIAL_PLACEHOLDER; // expired/already used
      used++;
      return value;
    });
  });
  return { resolved, used };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Guard a tool call end-to-end. See {@link GuardToolCallInput}.
 */
export async function guardToolCall(
  input: GuardToolCallInput,
  registry: PatternRegistry = defaultRegistry,
): Promise<GuardToolCallResult> {
  const { toolName, args, bufferIds = [], dispatch } = input;

  // 1. Scan arguments for injection/embedded secrets. Tool args are untrusted
  //    (model-authored), so injection inside them is treated as context-level.
  const argsScan = scanContext(toMessages(args, "tool"), registry);
  const allowed = argsScan.decision !== "block";

  const scanResult = (value: unknown): { value: unknown; scan: ContextScanResult } => {
    const scan = scanContext(toMessages(value, "tool"), registry);
    const safe = scan.redactedMessages ? scan.redactedMessages[0]?.content ?? value : value;
    return { value: safe, scan };
  };

  emitReceipt({ stage: "tool", decision: argsScan.decision, patterns: argsScan.flags, toolName });

  if (!allowed) {
    return {
      toolName,
      allowed: false,
      decision: argsScan.decision,
      resolvedArgs: args,
      argsScan,
      reasons: argsScan.reasons,
      scanResult,
    };
  }

  // 2. Resolve credential placeholders right before dispatch. Base resolution
  //    on the scanned args so any *raw* embedded secret is already redacted
  //    (only buffered placeholders become real values).
  const scannedArgs = argsScan.redactedMessages?.[0]?.content ?? args;
  const { resolved } = resolvePlaceholders(scannedArgs, bufferIds);

  const base: GuardToolCallResult = {
    toolName,
    allowed: true,
    decision: argsScan.decision,
    resolvedArgs: resolved,
    argsScan,
    reasons: argsScan.reasons,
    scanResult,
  };

  // 3. If a dispatcher was provided, run it and guard the return value.
  if (dispatch) {
    const raw = await dispatch(resolved);
    const guarded = scanResult(raw);
    base.result = guarded.value;
    base.resultScan = guarded.scan;
  }

  return base;
}
