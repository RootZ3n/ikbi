/**
 * ikbi builder-tools — SHARED path confinement + tool-rejection shape.
 *
 * Extracted from builder.ts so every builder tool (read/write/list AND the new
 * terminal / search_files / patch) confines paths through the SAME canonical
 * resolver. The invariant is unchanged from the original inline version: every
 * tool path is resolved against the (realpath'd) worktree root and REJECTED if it
 * escapes via `..` traversal, an absolute-outside path, or a symlink whose target
 * leaves the tree. A rejected call never touches the real fs outside the worktree.
 *
 * Pure module-scope helpers — no side effects, no I/O beyond `realpathSync` probes.
 */

import { dirname, isAbsolute, relative, resolve } from "node:path";
import { realpathSync } from "node:fs";

/** A tool call that was rejected (bad path / bad args / unknown tool). Lives in the role detail. */
export interface ToolCallError {
  readonly tool: string;
  readonly path?: string;
  readonly error: string;
}

/** True iff `target` is the same as, or nested under, `base`. */
export function isUnder(base: string, target: string): boolean {
  if (target === base) return true;
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Realpath the deepest EXISTING ancestor of `p` (so a not-yet-created file resolves via its parent). */
export function realExistingAncestor(p: string): string {
  let cur = p;
  for (;;) {
    try {
      return realpathSync(cur);
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return cur;
      cur = parent;
    }
  }
}

/** The result of confining a path to the worktree. */
export type Confined = { ok: true; full: string; rel: string } | { ok: false; error: string };

/** Resolve a tool path against the worktree and reject any escape (traversal / absolute / symlink). */
export function confinePath(worktreeReal: string, arg: unknown): Confined {
  if (typeof arg !== "string" || arg.length === 0) return { ok: false, error: "missing or non-string path argument" };
  const resolved = resolve(worktreeReal, arg);
  if (!isUnder(worktreeReal, resolved)) return { ok: false, error: `path "${arg}" escapes the worktree` };
  // Symlink escape: the realpath of the deepest existing ancestor must stay inside.
  if (!isUnder(worktreeReal, realExistingAncestor(resolved))) {
    return { ok: false, error: `path "${arg}" escapes the worktree via symlink` };
  }
  return { ok: true, full: resolved, rel: relative(worktreeReal, resolved) || "." };
}

/**
 * The result of a single builder-tool invocation.
 *
 *  - `output`   — the raw result STRING fed back to the model. For UNTRUSTED tools
 *                 (search_files, terminal) this string still flows through the
 *                 builder's neutralization chokepoint before it becomes a message.
 *  - `rejection`— present when the call was rejected (bad path / bad args); the
 *                 builder records it in `rejectedToolCalls`.
 *  - `wrote`    — the worktree-relative path of a file the tool MODIFIED (patch);
 *                 the builder records it in `filesWritten` so the `done` self-check
 *                 read-back gate covers it.
 */
export interface BuilderToolResult {
  readonly output: string;
  readonly rejection?: ToolCallError;
  readonly wrote?: string;
}
