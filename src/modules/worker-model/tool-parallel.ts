/**
 * ikbi worker — parallel tool dispatch (the safe subset).
 *
 * When a model emits several tool calls in ONE round, the worktree-INDEPENDENT async read tools
 * (web research, vision) can run CONCURRENTLY: they never touch the worktree, so there is no
 * write↔read race and no reordering of side effects. This helper pre-starts those calls so they
 * run in parallel; the builder's serial loop then awaits each in CALL ORDER, so results still
 * append deterministically (and every result still re-enters via the neutralization chokepoint).
 *
 * Deliberately narrow: file reads are synchronous (no async benefit), and every worktree-touching
 * or side-effecting tool (terminal / git / lsp / delegate / brain / mcp / writes / done / run_checks)
 * stays strictly serial. Each pre-started promise is PRE-SETTLED to a string so an early loop
 * `break` (e.g. a `done` before a pre-started tool is awaited) can never leave an unhandled rejection.
 */

import type { ToolCall } from "../../core/provider/contract.js";

/**
 * Pre-start the parallelizable calls in `calls`, returning a map from each such call to its
 * already-running, never-rejecting promise. Only fires when there is MORE THAN ONE call in the
 * round (a lone call has nothing to overlap with). A non-parallelizable call is absent from the
 * map — the caller runs it serially where it appears.
 *
 * @param calls        the round's tool calls, in emission order
 * @param isParallel   predicate: is this call a worktree-independent async read (safe to overlap)?
 * @param run          the async executor for a call (returns the raw, un-neutralized result string)
 */
export function preStartParallelReads(
  calls: readonly ToolCall[],
  isParallel: (call: ToolCall) => boolean,
  run: (call: ToolCall) => Promise<string>,
): Map<ToolCall, Promise<string>> {
  const started = new Map<ToolCall, Promise<string>>();
  if (calls.length <= 1) return started; // nothing to overlap with
  for (const call of calls) {
    if (isParallel(call)) {
      // PRE-SETTLE: map any rejection to an error string so the promise never rejects — an early
      // `break` that skips the await can then never surface an unhandled rejection.
      started.set(call, run(call).then((s) => s, (e) => `ERROR: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return started;
}
