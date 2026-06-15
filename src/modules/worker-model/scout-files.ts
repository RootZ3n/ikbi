/**
 * ikbi scout — extracted file-gathering helpers (shared between scout and multi-audit).
 *
 * These functions were originally private inside scout.ts. Extracted here so the
 * multi-model audit can reuse the same bounded, read-only file-gathering logic
 * without duplicating it. The behavior is byte-for-byte identical.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** One entry in the scout's STRUCTURE index — a scanned file with its size. */
export interface ScoutFileEntry {
  readonly path: string;
  readonly lines: number;
  readonly bytes: number;
}

/** Hard cap on files visited — scout never walks the whole tree. */
const MAX_FILES_SCANNED = 40;
/** Per-file byte cap fed to the model. */
const MAX_FILE_BYTES = 4_000;
/** Total byte cap of gathered context. */
const MAX_TOTAL_BYTES = 60_000;

export const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md"]);
export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);

/** Bounded, read-only directory walk. Stops at MAX_FILES_SCANNED; skips heavy dirs. */
export function gatherFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_FILES_SCANNED) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip (read-only, never fail the walk on one dir)
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES_SCANNED) break;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && SCAN_EXTENSIONS.has(extname(e.name))) {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * Read a bounded slice of each file into a single context string. Read-only. Also
 * returns the STRUCTURE index (each scanned file's path + line/byte size).
 */
export function buildContext(files: readonly string[], root: string): { text: string; used: number; structure: ScoutFileEntry[] } {
  const parts: string[] = [];
  const structure: ScoutFileEntry[] = [];
  let total = 0;
  let used = 0;
  for (const f of files) {
    if (total >= MAX_TOTAL_BYTES) break;
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    const slice = content.slice(0, MAX_FILE_BYTES);
    const rel = relative(root, f);
    parts.push(`--- ${rel} ---\n${slice}`);
    structure.push({ path: rel, lines: content.split("\n").length, bytes: Buffer.byteLength(content, "utf8") });
    total += Buffer.byteLength(slice, "utf8");
    used += 1;
  }
  return { text: parts.join("\n\n"), used, structure };
}

/** Exported constants for test visibility. */
export const SCOUT_MAX_FILES_SCANNED = MAX_FILES_SCANNED;
export const SCOUT_MAX_FILE_BYTES = MAX_FILE_BYTES;
export const SCOUT_MAX_TOTAL_BYTES = MAX_TOTAL_BYTES;
