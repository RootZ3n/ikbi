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

import { neutralizeUntrusted } from "../../core/injection/index.js";
import type { UntrustedBoundary } from "../core/builder.js";

/** Build THE boundary. One per process is fine; it holds no per-run state. */
export function createUntrustedBoundary(): UntrustedBoundary {
  return {
    wrap(input): string {
      const neutralized = neutralizeUntrusted(input.content, {
        source: input.source,
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      });
      // The canonical wrapped form — header + preamble + fenced verbatim body + footer.
      // The builder places this inside a data-role `tool` message; we return only the
      // string so the boundary owns wrapping and the builder owns message shape.
      return neutralized.wrapped;
    },
  };
}
