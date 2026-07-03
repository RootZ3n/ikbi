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
import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";

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
  // NOTE: Known TOCTOU window between realpath check and file operation.
  // Exploitation requires attacker write access to worktree + microsecond timing.
  // Node.js lacks atomic path resolution; this is an accepted risk.
  if (!isUnder(worktreeReal, realExistingAncestor(resolved))) {
    return { ok: false, error: `path "${arg}" escapes the worktree via symlink` };
  }
  return { ok: true, full: resolved, rel: relative(worktreeReal, resolved) || "." };
}

/**
 * Write a file after revalidating confinement immediately before the mutating open.
 *
 * This closes the practical symlink escape for `write_file`: mkdir can create the parent, then an
 * attacker with concurrent worktree access could replace that parent or final path with a symlink
 * between the earlier `confinePath` check and `writeFileSync`. We re-check the parent realpath,
 * reject a final symlink, and open with O_NOFOLLOW where the platform exposes it.
 *
 * Residual TOCTOU risk: POSIX path traversal is still not a single kernel-level "open beneath root"
 * operation in Node. A same-UID attacker racing parent replacement at exactly the open boundary can
 * only be fully eliminated with openat2/RESOLVE_BENEATH-style APIs or an OS sandbox.
 */
export function writeConfinedFile(worktreeReal: string, confined: Extract<Confined, { ok: true }>, content: string): void {
  mkdirSync(dirname(confined.full), { recursive: true });
  if (!isUnder(worktreeReal, realExistingAncestor(confined.full))) {
    throw new Error(`path "${confined.rel}" escapes the worktree via symlink`);
  }
  try {
    if (lstatSync(confined.full).isSymbolicLink()) {
      throw new Error(`path "${confined.rel}" escapes the worktree via symlink`);
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") throw err;
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(confined.full, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o666);
  try {
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
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
