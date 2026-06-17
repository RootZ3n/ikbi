/**
 * ikbi builder tool — glob (find files by name/path pattern within the worktree).
 *
 * Cheap models lean hard on filename discovery ("where is the config?"), which `list_dir`
 * (one level) and `search_files` (content) don't cover. glob walks the worktree (confined),
 * matches relative paths against a shell-style pattern (`**`, `*`, `?`), and returns the hits,
 * bounded. Read-only — it touches nothing.
 */

import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { ModelTool } from "../../../core/provider/contract.js";
import { confinePath } from "./confine.js";

/** Directories never worth walking for source discovery. */
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".next", ".cache", "coverage", ".turbo"]);
/** Cap on returned matches (with a truncation notice) and on dirs walked (runaway guard). */
const MAX_MATCHES = 300;
const MAX_ENTRIES_WALKED = 50_000;

/** The tool declared to the model. */
export const globTool: ModelTool = {
  name: "glob",
  description:
    "Find files by NAME/PATH pattern within the worktree (e.g. `src/**/*.ts`, `**/*.json`, `**/Dockerfile`). `**` matches across directories, `*` within a path segment, `?` one char. Returns matching relative paths. Read-only; use it to locate files before reading them.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob, e.g. `src/**/*.ts` or `**/*.test.ts`." },
      path: { type: "string", description: "Optional subdirectory under the worktree to search from (default: the worktree root)." },
    },
    required: ["pattern"],
  },
};

/** Convert a shell-style glob into an anchored RegExp over POSIX-separated relative paths. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**` (optionally followed by `/`) → match across directory boundaries.
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Run a glob over the worktree. Returns a newline-joined list of matching relative paths (or a
 * "no files match" / ERROR string). Never throws past the call boundary.
 */
export function runGlob(worktreeReal: string, args: Record<string, unknown>): string {
  const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
  if (pattern.length === 0) return "ERROR: glob requires a non-empty 'pattern'";

  // Optional starting subdirectory is confined like every other path operand.
  let baseFull = worktreeReal;
  if (typeof args.path === "string" && args.path.trim().length > 0) {
    const c = confinePath(worktreeReal, args.path);
    if (!c.ok) return `ERROR: ${c.error}`;
    baseFull = c.full;
  }

  let regex: RegExp;
  try {
    regex = globToRegExp(pattern);
  } catch (e) {
    return `ERROR: invalid glob pattern: ${e instanceof Error ? e.message : String(e)}`;
  }

  const matches: string[] = [];
  let walked = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (matches.length >= MAX_MATCHES || walked >= MAX_ENTRIES_WALKED) {
      truncated = true;
      return;
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    for (const e of entries) {
      walked += 1;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
        if (matches.length >= MAX_MATCHES) { truncated = true; return; }
      } else if (e.isFile()) {
        const rel = relative(worktreeReal, join(dir, e.name)).split(sep).join("/");
        if (regex.test(rel)) {
          matches.push(rel);
          if (matches.length >= MAX_MATCHES) { truncated = true; return; }
        }
      }
    }
  };
  walk(baseFull);

  if (matches.length === 0) return `no files match ${pattern}`;
  matches.sort();
  const body = matches.join("\n");
  return truncated ? `${body}\n[truncated — showing the first ${matches.length} matches; narrow the pattern]` : body;
}
