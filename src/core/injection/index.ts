/**
 * ikbi prompt-injection chokepoint — public surface (frozen contract #2).
 *
 * THE single entry point for getting untrusted content safely into a model:
 *
 *     const safe = neutralizeUntrusted(rawToolOutput, { source: "tool_result", identity });
 *     messages.push(toUntrustedMessage(safe)); // isolated data-role message
 *
 * `neutralizeUntrusted` ALWAYS scans, ALWAYS wraps, and (for high-risk sources)
 * defangs — none of this is skipped because a scan came back clean. No module
 * hand-rolls wrapping; the canonical form lives here and only here. Untrusted
 * content is carried as a STRUCTURALLY-ISOLATED data-role message, never
 * concatenated into a trusted-instruction message.
 *
 * Honest about limits: see `contract.ts` — this provably contains delimiters and
 * defangs control primitives, but does not eliminate semantic influence.
 */

import { Buffer } from "node:buffer";

import { config } from "../config.js";
import { childLogger } from "../log.js";
import type { ModelMessage } from "../provider/contract.js";
import {
  INJECTION_CONTRACT_VERSION,
  InjectionError,
  type NeutralizedContent,
  type NeutralizeOptions,
  type ScanResult,
  type UntrustedContext,
} from "./contract.js";
import { defangByDefault, defangPrimitives } from "./defang.js";
import { buildWrapped, generateFenceId } from "./fence.js";
import { scanForInjection } from "./scanner.js";

const log = childLogger("injection");

/** Slice a string to at most `maxBytes` UTF-8 bytes, not splitting a code point. */
function truncateToBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  // Use TextDecoder with stream semantics to drop a trailing partial code point.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(buf.subarray(0, maxBytes)).replace(/\uFFFD+$/u, "");
}

/** Compact, log-safe summary of findings (excerpts are already sanitized). */
function summarizeFindings(scan: ScanResult): Array<Record<string, unknown>> {
  return scan.findings.map((f) => ({
    rule: f.rule,
    category: f.category,
    severity: f.severity,
    confidence: f.confidence,
    index: f.index,
    excerpt: f.excerpt,
  }));
}

/**
 * Scan + (risk-aware) defang + neutralize-wrap untrusted content into the single
 * canonical isolated form. Wrapping/isolation are unconditional; defang is
 * source-driven unless `opts.defang` forces it; the scan informs verdict/logs.
 */
export function neutralizeUntrusted(
  content: string,
  context: UntrustedContext,
  opts?: NeutralizeOptions,
): NeutralizedContent {
  const maxContentBytes = opts?.maxContentBytes ?? config.injection.maxContentBytes;

  const rawBytes = Buffer.byteLength(content, "utf8");

  // 1. Size cap (DoS floor): truncate the body with an explicit, honest marker.
  let body = content;
  let truncated = false;
  let omittedBytes = 0;
  if (rawBytes > maxContentBytes) {
    body = truncateToBytes(content, maxContentBytes);
    omittedBytes = rawBytes - Buffer.byteLength(body, "utf8");
    truncated = true;
  }

  // 2. Scan the content as received (telemetry; normalized + byte-capped internally).
  const scan = scanForInjection(content, opts);

  // 3. Risk-aware defang of dangerous primitives in the body.
  const doDefang = opts?.defang ?? defangByDefault(context.source);
  let defangedCount = 0;
  if (doDefang) {
    const d = defangPrimitives(body);
    body = d.text;
    defangedCount = d.count;
  }

  // 4. Fence with a verified-absent nonce (buildWrapped self-enforces the invariant).
  const fenceId = generateFenceId(body, opts?.nonceFn);
  const wrapped = buildWrapped(body, fenceId, context.source, context.origin, {
    defanged: doDefang && defangedCount > 0,
    truncated,
    omittedBytes,
  });

  const result: NeutralizedContent = {
    kind: "ikbi/neutralized-untrusted",
    contractVersion: INJECTION_CONTRACT_VERSION,
    wrapped,
    raw: content,
    body,
    scan,
    source: context.source,
    ...(context.origin !== undefined ? { origin: context.origin } : {}),
    ...(context.label !== undefined ? { label: context.label } : {}),
    ...(context.identity !== undefined ? { identity: context.identity } : {}),
    fenceId,
    bytes: rawBytes,
    defangApplied: doDefang,
    defangedCount,
    truncated,
    omittedBytes,
  };

  const logFields = {
    event: "untrusted_neutralized",
    source: context.source,
    origin: context.origin,
    label: context.label,
    agentId: context.identity?.agentId,
    functionalRole: context.identity?.functionalRole,
    trustTier: context.identity?.trustTier,
    verdict: scan.verdict,
    recommendedAction: scan.recommendedAction,
    maxConfidence: scan.maxConfidence,
    findingCount: scan.findings.length,
    bytes: rawBytes,
    scannedBytes: scan.scannedBytes,
    scanTruncated: scan.truncated,
    defangApplied: doDefang,
    defangedCount,
    contentTruncated: truncated,
    omittedBytes,
    fenceId,
  };

  if (scan.verdict === "clean") {
    log.info(logFields, "neutralized untrusted content (scan clean; wrapped + isolated)");
  } else {
    log.warn(
      { ...logFields, findings: summarizeFindings(scan) },
      `neutralized untrusted content (scan ${scan.verdict}; wrapped + isolated)`,
    );
  }

  return result;
}

/**
 * Carry neutralized untrusted content as a STRUCTURALLY-ISOLATED message. The
 * role is restricted to data roles ("user"/"tool") so untrusted content can
 * never be placed in a system/assistant (instruction) position. This is the
 * sanctioned integration path — do not concatenate `.wrapped` into a trusted
 * instruction message yourself.
 */
export function toUntrustedMessage(
  neutralized: NeutralizedContent,
  opts?: { role?: "user" | "tool"; toolCallId?: string },
): ModelMessage {
  const role = opts?.role ?? "user";
  if (role !== "user" && role !== "tool") {
    throw new InjectionError(
      `untrusted content may only occupy a data role (user/tool), not "${String(role)}"`,
    );
  }
  return {
    role,
    content: neutralized.wrapped,
    untrusted: true,
    ...(opts?.toolCallId !== undefined ? { toolCallId: opts.toolCallId } : {}),
  };
}

// Re-export the scan-only entry point and the frozen contract surface.
export { scanForInjection } from "./scanner.js";
export { defangByDefault, defangPrimitives, DEFANG_BREAK } from "./defang.js";
// NOTE: buildWrapped is intentionally NOT re-exported — modules must go through
// neutralizeUntrusted so the verified-absent fence invariant cannot be bypassed.
export { FENCE_MARKER, FENCE_BEGIN_PREFIX, FENCE_END_PREFIX, extractFenced, generateFenceId } from "./fence.js";
export {
  INJECTION_CONTRACT_VERSION,
  InjectionError,
  type ContentSource,
  type InjectionCategory,
  type InjectionFinding,
  type FindingSeverity,
  type NeutralizedContent,
  type NeutralizeOptions,
  type RecommendedAction,
  type ScanResult,
  type ScanVerdict,
  type UntrustedContext,
} from "./contract.js";
