/**
 * THE UNTRUSTED-DATA BOUNDARY — v1's neutralization fence, behind the v2 seam.
 *
 * This is the single adapter that turns repository/tool-derived content into
 * structurally-isolated untrusted data before it re-enters the builder conversation. It
 * is the ONLY v2 file permitted to import `neutralizeUntrusted`, and the builder's one
 * chokepoint is its only caller.
 *
 * WHAT IS ADOPTED, AND WHY IT IS NOT REBUILT. v1's chokepoint
 * (`core/injection/index.ts`) is mature and exactly right for this: an UNGUESSABLE,
 * VERIFIED-ABSENT nonce fence — the terminator embeds a 128-bit nonce proven not to occur
 * in the content, so untrusted bytes provably cannot close their own wrapper — plus a
 * strong preamble telling the model the block is inert data, risk-aware defanging of
 * control primitives, and a size cap. Reimplementing that would be strictly worse.
 *
 * SOURCE MAPPING, deliberately:
 *
 *   "repo"        → v1 `source: "repo"` — LOSSLESS. Defang is off, so source code survives
 *                   byte-for-byte between the fence markers and stays recoverable. The
 *                   observation hash (computed elsewhere, over the real bytes) is not
 *                   touched, so it still corresponds to the file, not to the wrapper.
 *   "tool_result" → v1 `source: "tool_result"` — defanged. A failure/rejection message is
 *                   not source code we must keep byte-exact; breaking any control token it
 *                   carries is the safer default.
 *
 * The v1 helper logs to the shared logger (stderr) and reads injection config; that is why
 * this lives in the runtime layer and is injected, never imported by pure `core/`.
 */

import { neutralizeUntrusted, type NeutralizedContent } from "../../core/injection/index.js";
import type { UntrustedBoundary } from "../core/builder.js";

/**
 * What the fence OBSERVED, alongside what it produced.
 *
 * `neutralizeUntrusted` already scans every byte it fences; the adapter used to return only the
 * wrapped string and drop the verdict on the floor. For the builder that is fine — the fence is
 * the defence and the telemetry is incidental. For a LOCAL ADVISORY packet it is not: the operator
 * is being handed evidence produced from repository and log material by an unqualified worker, and
 * "this log contained something that looks like an instruction" is part of what they need to know
 * when they read the answer. Fenced AND reported, not fenced and forgotten.
 */
export interface InspectedUntrusted {
  readonly wrapped: string;
  /** True when the scanner flagged injection-shaped content in the ORIGINAL bytes. */
  readonly injectionSuspected: boolean;
  /** The scanner's verdict, verbatim. */
  readonly verdict: string;
  /** Highest finding confidence; 0 when nothing was found. */
  readonly maxConfidence: number;
  /** The scanner's own rule names, deduplicated and sorted. Empty when it flagged nothing. */
  readonly signals: readonly string[];
  /** Control primitives the defang stage neutralized inside the body. */
  readonly defangedCount: number;
  /** True when the content was too large and the fenced body was truncated. */
  readonly truncated: boolean;
}

/** A boundary that also reports what it saw. `wrap` is unchanged, so the builder is unaffected. */
export interface InspectingUntrustedBoundary extends UntrustedBoundary {
  inspect(input: { readonly content: string; readonly source: "repo" | "tool_result"; readonly origin?: string }): InspectedUntrusted;
}

/** Build THE boundary. One per process is fine; it holds no per-run state. */
export function createUntrustedBoundary(): InspectingUntrustedBoundary {
  const neutralize = (input: { content: string; source: "repo" | "tool_result"; origin?: string }) =>
    neutralizeUntrusted(input.content, {
      source: input.source,
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    });

  return {
    inspect(input): InspectedUntrusted {
      const n: NeutralizedContent = neutralize(input);
      // The scan contract is v1's and this adapter owns the translation. `verdict` is the scanner's
      // own judgement and `findings[].rule` are its named detections — read them as the contract
      // defines them rather than guessing at field names, which is how the first version of this
      // reported a clean packet for content the scanner had flagged twice.
      const scan = n.scan;
      const signals = scan.findings.map((f) => f.rule);
      return {
        wrapped: n.wrapped,
        injectionSuspected: scan.verdict !== "clean" || signals.length > 0,
        verdict: scan.verdict,
        maxConfidence: scan.maxConfidence,
        signals: Object.freeze([...new Set(signals)].sort()),
        defangedCount: n.defangedCount,
        // EITHER truncation matters: a body cut for size, or a scan that stopped early. Both mean
        // the report covers less than the whole packet, and saying so is the point.
        truncated: n.truncated || scan.truncated,
      };
    },

    wrap(input): string {
      const neutralized = neutralize(input);
      // The canonical wrapped form — header + preamble + fenced verbatim body + footer.
      // The builder places this inside a data-role `tool` message; we return only the
      // string so the boundary owns wrapping and the builder owns message shape.
      return neutralized.wrapped;
    },
  };
}
