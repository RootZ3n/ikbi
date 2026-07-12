/**
 * ikbi worker — pre-flight context-size check (proactive escalation).
 *
 * Once the scout brief is known but BEFORE the builder's first model call, estimate how much of the
 * builder model's context window the assembled base context (goal + project instructions + scout
 * brief) will already consume. If it fills too much of the window, there is no working room left —
 * a cheap worker attempt would only overflow. Starting the builder on a bigger-window model up front
 * avoids that doomed attempt. This COMPLEMENTS the reactive on-overflow escalation (which recovers a
 * build that overflows anyway): pre-flight avoids the wasted round when the size is obvious in advance.
 *
 * Deliberately conservative: it estimates only what is KNOWN before the build loop (runtime file
 * reads are not counted), uses the same chars/4 heuristic as the context-manager, and bumps only when
 * the base context alone exceeds a high fraction of the window — so it never needlessly upgrades a
 * task the cheap model could have handled. Pure and deterministic.
 */

/** Same chars→token heuristic the context-manager uses (CHARS_PER_TOKEN = 4). */
const CHARS_PER_TOKEN = 4;

/** Rough token estimate for a set of prompt parts (undefined parts contribute nothing). */
export function estimatePromptTokens(parts: ReadonlyArray<string | undefined>): number {
  let chars = 0;
  for (const p of parts) if (typeof p === "string") chars += p.length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * True when `estimatedTokens` already exceeds `fraction` of `contextWindow` — i.e. the base context
 * leaves too little working room, so the builder should start on a bigger-window model. A zero/unknown
 * window never triggers (fail-safe: don't upgrade on missing capability data).
 */
export function contextExceedsWindow(estimatedTokens: number, contextWindow: number, fraction: number): boolean {
  return contextWindow > 0 && estimatedTokens > contextWindow * fraction;
}
