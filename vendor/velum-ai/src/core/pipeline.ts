/**
 * Velum — Safe Pipeline API
 * ============================================================
 * One-call guard functions that wire the full Velum pipeline:
 *
 *   guardRequest:  classify input → scanContext → apply PII → return sanitized
 *   guardResponse: deep scan output → apply PII → demask → return safe response
 *
 * These are the recommended entry points for new integrations.
 * ============================================================
 */

import { classify, type ClassificationResult } from "./classify.js";
import {
  scanContext,
  applyOutputGuardSync,
  deepScanOutput,
  maxDecision,
  type ContextScanInput,
  type ContextScanResult,
  type Decision,
  type ScanResult,
} from "./guard.js";
import { processWithPii, demask, sanitizePii, type PiiLevel, type PiiResult } from "./pii.js";
import { type PatternRegistry, registry as defaultRegistry } from "./patterns.js";
import { emitReceipt } from "./receipts.js";

// ── Request pipeline ─────────────────────────────────────────────────────────

export interface GuardRequestInput {
  /** Raw user input text. */
  input?: string;
  /** Full message array going to the model (system, user, assistant, tool). */
  messages?: ContextScanInput[];
  /** PII level override (default: 1 = observe only). */
  piiLevel?: PiiLevel;
  /** Optional pattern registry override. */
  registry?: PatternRegistry;
}

export interface GuardRequestResult {
  input: {
    classification: ClassificationResult;
    decision: Decision;
  };
  messages: {
    /** Sanitized message array (secrets redacted, injection flagged). */
    messages: ContextScanInput[];
    contextScan: ContextScanResult;
    /** Overall context decision. */
    decision: Decision;
  };
  pii: {
    result: PiiResult;
    /** Placeholder map for demasking responses (only at level 2). */
    placeholderMap?: Map<string, string>;
  };
  /** All credential buffer IDs from this request. */
  credentialBufferIds: string[];
  /** Highest decision across all stages. */
  decision: Decision;
}

/**
 * Full request guard. Classifies user input, scans the context array,
 * applies PII processing, and returns everything sanitized.
 */
export function guardRequest(input: GuardRequestInput = {}): GuardRequestResult {
  const piiLevel = input.piiLevel ?? 1;
  const reg = input.registry ?? defaultRegistry;
  const credentialBufferIds: string[] = [];
  let overallDecision: Decision = "allow";

  // Stage 1: Classify user input
  let inputResult: ClassificationResult;
  if (input.input !== undefined) {
    inputResult = classify(input.input, undefined, { registry: reg });
    if (inputResult.credentialBufferIds.length > 0) {
      credentialBufferIds.push(...inputResult.credentialBufferIds);
    }
    const inputDecision = classificationToDecision(inputResult.classification);
    overallDecision = maxDecision(overallDecision, inputDecision);
  } else {
    inputResult = {
      classification: "SAFE",
      action: "passed",
      sanitizedMessage: "",
      warnings: [],
      patternsMatched: [],
      credentialBufferIds: [],
    };
  }

  // Stage 2: Scan context messages
  let contextResult: ContextScanResult;
  let messages = input.messages ?? [];
  if (messages.length > 0) {
    contextResult = scanContext(messages, reg);
    if (contextResult.redactedMessages) {
      messages = contextResult.redactedMessages;
    }
    overallDecision = maxDecision(overallDecision, contextResult.decision);
  } else {
    contextResult = { decision: "allow", reasons: [], flags: [] };
  }

  // Stage 3: Apply PII processing
  let piiResult: PiiResult;
  let placeholderMap: Map<string, string> | undefined;
  if (piiLevel >= 2 && messages.length > 0) {
    const processed: ContextScanInput[] = [];
    const combinedMap = new Map<string, string>();
    for (const msg of messages) {
      if (typeof msg.content === "string") {
        const r = processWithPii(msg.content, piiLevel, reg);
        processed.push({ role: msg.role, content: r.maskedText ?? msg.content });
        if (r.placeholderMap) {
          for (const [k, v] of r.placeholderMap) combinedMap.set(k, v);
        }
      } else {
        processed.push(msg);
      }
    }
    messages = processed;
    piiResult = { detections: [], masked: true, level: piiLevel };
    if (combinedMap.size > 0) placeholderMap = combinedMap;
  } else {
    piiResult = { detections: [], masked: false, level: piiLevel };
  }

  emitReceipt({
    stage: "request",
    decision: overallDecision,
    patterns: [...inputResult.patternsMatched, ...contextResult.flags],
    counts: { credentials: credentialBufferIds.length, piiMasked: placeholderMap ? placeholderMap.size : 0 },
  });

  return {
    input: {
      classification: inputResult,
      decision: classificationToDecision(inputResult.classification),
    },
    messages: {
      messages,
      contextScan: contextResult,
      decision: contextResult.decision,
    },
    pii: {
      result: piiResult,
      placeholderMap,
    },
    credentialBufferIds,
    decision: overallDecision,
  };
}

// ── Response pipeline ────────────────────────────────────────────────────────

export interface GuardResponseInput {
  /** Model output as text. */
  text?: string;
  /** Model output as structured object (e.g. OpenAI response shape). */
  object?: unknown;
  /** PII placeholder map from guardRequest (for demasking). */
  piiPlaceholderMap?: Map<string, string>;
  /** PII level override. */
  piiLevel?: PiiLevel;
  /** Optional pattern registry override. */
  registry?: PatternRegistry;
}

export interface GuardResponseResult {
  /** Safe text (redacted/blocked as needed). */
  text: string;
  /** Safe structured object (if input.object was provided). */
  object?: unknown;
  /** The output scan result. */
  outputScan: ScanResult;
  /** True if the response was blocked (secrets detected). */
  blocked: boolean;
  /** True if content was redacted. */
  redacted: boolean;
}

/**
 * Full response guard. Scans model output for secrets, PII, and dangerous
 * patterns. Supports both text and structured object responses (e.g.
 * `{choices: [{message: {content: "..."}}]}`).
 */
export function guardResponse(input: GuardResponseInput = {}): GuardResponseResult {
  const piiLevel = input.piiLevel ?? 1;
  const reg = input.registry ?? defaultRegistry;

  // If structured object provided, deep scan it
  if (input.object !== undefined) {
    const obj = input.object as string | Record<string, unknown>;
    const deepResult = deepScanOutput(obj, {}, reg);
    let safeObj = deepResult.value;

    // Apply PII if level >= 2
    if (piiLevel >= 2) {
      safeObj = applyPiiToValue(safeObj, piiLevel, reg);
    }

    // Demask if placeholder map provided
    if (input.piiPlaceholderMap && input.piiPlaceholderMap.size > 0) {
      safeObj = demaskValue(safeObj, input.piiPlaceholderMap);
    }

    const objText = typeof safeObj === "string" ? safeObj : JSON.stringify(safeObj);
    emitReceipt({ stage: "response", decision: deepResult.scan.decision, patterns: deepResult.scan.flags });
    return {
      text: objText,
      object: safeObj,
      outputScan: deepResult.scan,
      blocked: deepResult.scan.decision === "block",
      redacted: !!deepResult.scan.redacted,
    };
  }

  // Text-only path
  let text = input.text ?? "";
  const guardResult = applyOutputGuardSync(text, { inCharacter: false }, reg);

  // Apply PII if level >= 2
  if (piiLevel >= 2) {
    text = sanitizePii(guardResult.text, reg);
  } else {
    text = guardResult.text;
  }

  // Demask if placeholder map provided
  if (input.piiPlaceholderMap && input.piiPlaceholderMap.size > 0) {
    text = demask(text, input.piiPlaceholderMap);
  }

  emitReceipt({ stage: "response", decision: guardResult.scan.decision, patterns: guardResult.scan.flags });
  return {
    text,
    outputScan: guardResult.scan,
    blocked: guardResult.blocked,
    redacted: guardResult.redacted,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function classificationToDecision(c: ClassificationResult["classification"]): Decision {
  switch (c) {
    case "SAFE":
      return "allow";
    case "CREDENTIAL":
      return "block";
    case "PROMPT_INJECTION":
    case "INSTRUCTION_OVERRIDE":
    case "MEMORY_MANIPULATION":
      return "block";
    case "BOUNDARY_PROBE":
      return "review";
    case "UNSAFE_CONTENT":
      return "warn";
    default:
      return "allow";
  }
}

/** Recursively apply PII sanitization to all string values in a structure. */
function applyPiiToValue(value: unknown, level: PiiLevel, reg: PatternRegistry): unknown {
  if (typeof value === "string") return sanitizePii(value, reg);
  if (Array.isArray(value)) return value.map((v) => applyPiiToValue(v, level, reg));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = applyPiiToValue(v, level, reg);
    }
    return out;
  }
  return value;
}

/** Recursively demask all string values in a structure. */
function demaskValue(value: unknown, map: Map<string, string>): unknown {
  if (typeof value === "string") return demask(value, map);
  if (Array.isArray(value)) return value.map((v) => demaskValue(v, map));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = demaskValue(v, map);
    }
    return out;
  }
  return value;
}
