/**
 * ikbi builder tool — patch (surgical find-and-replace within the worktree).
 *
 * A targeted edit: read a worktree-confined file, replace ONE exact occurrence of
 * `old_string` with `new_string`, write it back. Unlike write_file (whole-file
 * overwrite) this preserves everything around the edit, so the builder can make a
 * minimal change without re-emitting the entire file.
 *
 * SAFETY RAILS:
 *  - PATH CONFINEMENT: the path is confined to the worktree (same resolver as every
 *    other builder tool) — a `..`/symlink escape is rejected, nothing outside touched.
 *  - UNIQUE MATCH REQUIRED: if `old_string` occurs zero times → rejected (nothing to
 *    do); more than once → rejected (ambiguous — the model must add surrounding
 *    context to make it unique). This is EXACT matching only; no fuzzy/whitespace-
 *    normalized fallback, which could silently edit the wrong place. The disciplined
 *    contract is: give me a uniquely-identifying anchor and I change exactly it.
 *  - The edited file is recorded in `wrote` so the builder's `done` read-back gate
 *    (you must read back every file you changed) covers patched files too.
 */

import { readFileSync, writeFileSync } from "node:fs";

import type { ModelTool } from "../../../core/provider/contract.js";
import { confinePath, type BuilderToolResult } from "./confine.js";

/** The tool declared to the model. */
export const patchTool: ModelTool = {
  name: "patch",
  description:
    "Make a surgical edit to a file in the worktree: replace one EXACT occurrence of old_string with new_string. old_string must match exactly (including whitespace) and be UNIQUE in the file — add surrounding context if it is not. Use this instead of write_file for small, targeted changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path under the worktree." },
      old_string: { type: "string", description: "The exact text to find (must be unique in the file)." },
      new_string: { type: "string", description: "The replacement text (may be empty to delete)." },
    },
    required: ["path", "old_string", "new_string"],
  },
};

/**
 * Apply a single exact find-and-replace to a worktree file. Pure aside from the one
 * file write; never throws past the call boundary — failures surface as an `output`
 * ERROR string (and a `rejection` for bad path / bad match).
 */
export function runPatch(worktreeReal: string, args: Record<string, unknown>): BuilderToolResult {
  const c = confinePath(worktreeReal, args.path);
  if (!c.ok) {
    return { output: `ERROR: ${c.error}`, rejection: { tool: "patch", path: String(args.path ?? ""), error: c.error } };
  }
  // DEPENDENCY GUARD: same as write_file — block writes to build/dependency directories.
  const BLOCKED_PATHS = ["node_modules/", ".git/", "dist/", ".next/", ".cache/"];
  const relPath = c.rel.replace(/\\/g, "/");
  if (BLOCKED_PATHS.some((bp) => relPath.startsWith(bp) || relPath.includes(`/${bp}`))) {
    return { output: `ERROR: cannot patch dependency/build directory: ${c.rel}`, rejection: { tool: "patch", path: c.rel, error: `cannot patch dependency directory: ${c.rel}` } };
  }
  // new_string may legitimately be "" (a deletion); old_string must be a non-empty anchor.
  const oldString = typeof args.old_string === "string" ? args.old_string : "";
  const newString = typeof args.new_string === "string" ? args.new_string : "";
  if (oldString.length === 0) {
    return { output: "ERROR: patch requires a non-empty 'old_string'", rejection: { tool: "patch", path: c.rel, error: "empty old_string" } };
  }

  let content: string;
  try {
    content = readFileSync(c.full, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `ERROR: patch read failed: ${msg}`, rejection: { tool: "patch", path: c.rel, error: msg } };
  }

  // EXACT, UNIQUE match. Count occurrences via split (n occurrences → n+1 parts).
  const occurrences = content.split(oldString).length - 1;
  if (occurrences === 0) {
    return {
      output: `ERROR: old_string not found in ${c.rel}. The text must match exactly, including whitespace.`,
      rejection: { tool: "patch", path: c.rel, error: "old_string not found" },
    };
  }
  if (occurrences > 1) {
    return {
      output: `ERROR: old_string occurs ${occurrences} times in ${c.rel}; it must be unique. Add surrounding context so it matches exactly one place.`,
      rejection: { tool: "patch", path: c.rel, error: `old_string not unique (${occurrences} matches)` },
    };
  }

  const next = content.replace(oldString, newString);
  try {
    writeFileSync(c.full, next, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `ERROR: patch write failed: ${msg}`, rejection: { tool: "patch", path: c.rel, error: msg } };
  }
  return {
    output: `patched ${c.rel} (replaced ${oldString.length} chars with ${newString.length})`,
    wrote: c.rel,
  };
}
