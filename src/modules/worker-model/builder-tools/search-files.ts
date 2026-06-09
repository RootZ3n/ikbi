/**
 * ikbi builder tool — search_files (ripgrep over the worktree).
 *
 * A READ-ONLY codebase search confined to the worktree. It shells `rg` directly
 * (execFileSync, array args — NEVER a shell string, so the pattern can't inject
 * commands) and returns the matching lines. The search ROOT is confined to the
 * worktree exactly like every other builder path; rg's own recursion stays inside
 * that root, so the tool can never read files outside the tree.
 *
 * TRUST: the output is repo CONTENT — UNTRUSTED data. The builder feeds it back
 * through the neutralization chokepoint (same as read_file), so a match line that
 * embeds "ignore your instructions" is inert. This tool only PRODUCES the string.
 *
 * It is synchronous (like read_file/list_dir) — no governance needed for a bounded,
 * read-only, worktree-confined search. Only `terminal` (arbitrary execution) is
 * routed through governed-exec.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { ModelTool } from "../../../core/provider/contract.js";
import { confinePath, type BuilderToolResult } from "./confine.js";

/** Default cap on matches returned (keeps untrusted output bounded before the model). */
const DEFAULT_MAX_RESULTS = 100;
/** Hard cap on the result string handed back (defense-in-depth alongside --max-count). */
const MAX_OUTPUT_BYTES = 24_000;
/** rg wall-clock budget — a pathological repo can't hang the builder loop. */
const RG_TIMEOUT_MS = 10_000;

/** The tool declared to the model. */
export const searchFilesTool: ModelTool = {
  name: "search_files",
  description:
    "Search file CONTENTS for a regex pattern across the worktree using ripgrep. Returns matching lines as `path:line:text`. Optionally scope to a sub-path or a file glob (e.g. *.ts). Read-only.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Sub-directory of the worktree to search in (default: whole worktree)." },
      file_glob: { type: "string", description: "Limit to files matching this glob, e.g. *.ts" },
      max_results: { type: "number", description: `Max matching lines to return (default ${DEFAULT_MAX_RESULTS}).` },
    },
    required: ["pattern"],
  },
};

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") out += ".*";
    else if (ch === "?") out += ".";
    else out += ch.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

function fallbackSearch(worktreeReal: string, root: string, pattern: string, fileGlob: string | undefined, maxResults: number): string {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    return `ERROR: search failed: invalid regex (${e instanceof Error ? e.message : String(e)})`;
  }
  const glob = fileGlob !== undefined && fileGlob.length > 0 ? globToRegExp(fileGlob) : undefined;
  const matches: string[] = [];
  const visit = (dir: string): void => {
    if (matches.length >= maxResults) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (glob !== undefined && !glob.test(entry.name)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size > 1_000_000) continue;
      let text;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const rel = relative(worktreeReal, full).split(sep).join("/");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && matches.length < maxResults; i += 1) {
        if (re.test(lines[i] ?? "")) matches.push(`${rel}:${i + 1}:${lines[i] ?? ""}`);
      }
    }
  };
  visit(root);
  return matches.length === 0 ? `No matches for "${pattern}"` : matches.join("\n").slice(0, MAX_OUTPUT_BYTES);
}

/**
 * Run a ripgrep search confined to the worktree. Pure: produces a result string
 * and (on a bad sub-path) a rejection — it never throws past the call boundary.
 */
export function runSearchFiles(worktreeReal: string, args: Record<string, unknown>): BuilderToolResult {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (pattern.length === 0) {
    return { output: "ERROR: search_files requires a non-empty 'pattern'", rejection: { tool: "search_files", error: "missing pattern" } };
  }

  // Confine the search ROOT to the worktree. An absent/empty path searches the whole tree.
  const rawPath = typeof args.path === "string" && args.path.length > 0 ? args.path : ".";
  const c = confinePath(worktreeReal, rawPath);
  if (!c.ok) {
    return { output: `ERROR: ${c.error}`, rejection: { tool: "search_files", path: String(args.path ?? ""), error: c.error } };
  }

  const maxResults = typeof args.max_results === "number" && args.max_results > 0 ? Math.floor(args.max_results) : DEFAULT_MAX_RESULTS;
  const rgArgs = ["--no-heading", "--line-number", "--color", "never", "--max-count", String(maxResults)];
  if (typeof args.file_glob === "string" && args.file_glob.length > 0) {
    rgArgs.push("--glob", args.file_glob);
  }
  // `--` terminates flag parsing so a pattern beginning with `-` is treated as a pattern.
  rgArgs.push("--", pattern, c.full);

  try {
    const out = execFileSync("rg", rgArgs, {
      encoding: "utf8",
      cwd: worktreeReal,
      timeout: RG_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const trimmed = out.trim();
    const body = trimmed.length === 0 ? `No matches for "${pattern}"` : trimmed.slice(0, MAX_OUTPUT_BYTES);
    return { output: body };
  } catch (e) {
    // rg exits 1 when there are NO matches — that is a normal, non-error outcome.
    const status = (e as { status?: number }).status;
    if (status === 1) {
      return { output: `No matches for "${pattern}"` };
    }
    const code = (e as { code?: unknown }).code;
    if (code === "EPERM" || code === "ENOENT") {
      return { output: fallbackSearch(worktreeReal, c.full, pattern, typeof args.file_glob === "string" ? args.file_glob : undefined, maxResults) };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { output: `ERROR: search failed: ${msg}` };
  }
}
