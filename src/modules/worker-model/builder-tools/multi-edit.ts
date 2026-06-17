/**
 * ikbi builder tool — multi_edit (multiple surgical edits to ONE file, atomically).
 *
 * Like `patch`, but applies an ORDERED list of exact find/replace edits to a single file
 * in ONE call — and ALL-OR-NOTHING: if any edit's `find` does not match exactly once (against
 * the running, partially-edited content), nothing is written and the whole call is rejected.
 * This cuts the round-trips a cheap model spends on a multi-spot change while keeping `patch`'s
 * disciplined unique-anchor contract (no fuzzy matching, no silent partial application).
 *
 * SAFETY RAILS: identical to patch — worktree path confinement, dependency-dir guard, exact
 * unique match per edit. The edited file is reported in `wrote` for the done read-back gate.
 */

import { readFileSync, writeFileSync } from "node:fs";

import type { ModelTool } from "../../../core/provider/contract.js";
import { confinePath, type BuilderToolResult } from "./confine.js";

/** The tool declared to the model. */
export const multiEditTool: ModelTool = {
  name: "multi_edit",
  description:
    "Apply MULTIPLE exact find/replace edits to ONE file in a single, ATOMIC call (all-or-nothing). Each edit's `find` must match exactly (including whitespace) and be UNIQUE in the file at the time it is applied; edits apply in order. If ANY edit fails to match uniquely, NOTHING is written. Use this instead of several `patch` calls when changing several spots in the same file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path under the worktree." },
      edits: {
        type: "array",
        description: "Ordered edits, each { find, replace }. `find` must be a unique anchor; `replace` may be empty to delete.",
        items: {
          type: "object",
          properties: {
            find: { type: "string", description: "Exact text to find (unique at apply time)." },
            replace: { type: "string", description: "Replacement text (may be empty)." },
          },
          required: ["find", "replace"],
        },
      },
    },
    required: ["path", "edits"],
  },
};

interface Edit {
  readonly find: string;
  readonly replace: string;
}

/** Validate the raw `edits` arg into a typed list, or return an error string. */
function parseEdits(raw: unknown): Edit[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "multi_edit requires a non-empty 'edits' array";
  const out: Edit[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const e = raw[i] as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null) return `edit ${i} is not an object`;
    const find = typeof e.find === "string" ? e.find : "";
    const replace = typeof e.replace === "string" ? e.replace : "";
    if (find.length === 0) return `edit ${i} has an empty 'find' (a non-empty anchor is required)`;
    out.push({ find, replace });
  }
  return out;
}

/**
 * Apply an ordered list of exact find/replace edits to a worktree file, atomically. Never
 * throws past the call boundary; failures surface as an `output` ERROR string + a `rejection`.
 */
export function runMultiEdit(worktreeReal: string, args: Record<string, unknown>): BuilderToolResult {
  const c = confinePath(worktreeReal, args.path);
  if (!c.ok) {
    return { output: `ERROR: ${c.error}`, rejection: { tool: "multi_edit", path: String(args.path ?? ""), error: c.error } };
  }
  const BLOCKED_PATHS = ["node_modules/", ".git/", "dist/", ".next/", ".cache/"];
  const relPath = c.rel.replace(/\\/g, "/");
  if (BLOCKED_PATHS.some((bp) => relPath.startsWith(bp) || relPath.includes(`/${bp}`))) {
    return { output: `ERROR: cannot edit dependency/build directory: ${c.rel}`, rejection: { tool: "multi_edit", path: c.rel, error: `cannot edit dependency directory: ${c.rel}` } };
  }
  const edits = parseEdits(args.edits);
  if (typeof edits === "string") {
    return { output: `ERROR: ${edits}`, rejection: { tool: "multi_edit", path: c.rel, error: edits } };
  }

  let content: string;
  try {
    content = readFileSync(c.full, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `ERROR: multi_edit read failed: ${msg}`, rejection: { tool: "multi_edit", path: c.rel, error: msg } };
  }

  // Apply in order against the RUNNING content; every edit must match exactly once at its turn.
  // All-or-nothing: we build the final string fully before writing, so a later failure writes nothing.
  let next = content;
  for (let i = 0; i < edits.length; i += 1) {
    const { find, replace } = edits[i]!;
    const occurrences = next.split(find).length - 1;
    if (occurrences === 0) {
      return { output: `ERROR: edit ${i} — text not found in ${c.rel} (it must match exactly, and may have been altered by an earlier edit). No changes written.`, rejection: { tool: "multi_edit", path: c.rel, error: `edit ${i}: not found` } };
    }
    if (occurrences > 1) {
      return { output: `ERROR: edit ${i} — anchor occurs ${occurrences} times in ${c.rel}; it must be unique. Add surrounding context. No changes written.`, rejection: { tool: "multi_edit", path: c.rel, error: `edit ${i}: not unique (${occurrences})` } };
    }
    next = next.replace(find, replace);
  }

  try {
    writeFileSync(c.full, next, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `ERROR: multi_edit write failed: ${msg}`, rejection: { tool: "multi_edit", path: c.rel, error: msg } };
  }
  return { output: `multi_edit applied ${edits.length} edit(s) to ${c.rel}`, wrote: c.rel };
}
