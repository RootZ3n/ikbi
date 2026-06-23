/**
 * ikbi context indexer — a fast, lightweight file-tree index.
 *
 * On session start the agent needs to know what's in the repo WITHOUT reading every file.
 * `indexFileTree` walks the tree once and records only cheap metadata per file (relative
 * path, byte size, extension, mtime). It skips the usual heavy/irrelevant directories
 * (node_modules, .git, dist, …) and bounds itself with `maxFiles`/`maxDepth` so it stays
 * well under a second even on 1000+ file repos. The index feeds relevance scoring + lazy
 * loading (see loader.ts) so only the files that matter for a prompt are read into context.
 */

import { readdirSync, statSync, type Dirent, type Stats } from "node:fs";
import { extname, join, relative, sep } from "node:path";

/** Cheap per-file metadata — never file CONTENT (that is lazy-loaded on demand). */
export interface IndexedFile {
  /** Path relative to the index root, using forward slashes. */
  readonly path: string;
  /** Absolute path on disk. */
  readonly absPath: string;
  /** File size in bytes. */
  readonly size: number;
  /** Lower-cased extension including the dot (e.g. ".ts"), or "" if none. */
  readonly ext: string;
  /** Last-modified time (ms epoch). */
  readonly mtimeMs: number;
}

/** The result of an index walk. */
export interface FileIndex {
  readonly root: string;
  readonly files: readonly IndexedFile[];
  /** True if the walk hit `maxFiles` and stopped early (the index is partial). */
  readonly truncated: boolean;
}

export interface IndexOptions {
  /** Stop after this many files (default 5000). Keeps the walk bounded on huge trees. */
  readonly maxFiles?: number;
  /** Maximum directory depth to descend (default 16). */
  readonly maxDepth?: number;
  /** Directory names to skip entirely (merged with the defaults). */
  readonly ignoreDirs?: Iterable<string>;
}

/** Directories that are never worth indexing for code context. */
export const DEFAULT_IGNORE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".ikbi",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".idea",
  ".vscode",
  ".DS_Store",
]);

const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_DEPTH = 16;

/**
 * Walk `root` and return a lightweight index of its files. Synchronous and bounded:
 * directories in the ignore set are pruned, the walk stops at `maxDepth`, and collection
 * halts (with `truncated: true`) once `maxFiles` is reached. Unreadable entries are skipped,
 * never thrown — indexing is best-effort and must not abort a session.
 */
export function indexFileTree(root: string, opts: IndexOptions = {}): FileIndex {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const ignore = new Set(DEFAULT_IGNORE_DIRS);
  if (opts.ignoreDirs !== undefined) for (const d of opts.ignoreDirs) ignore.add(d);

  const files: IndexedFile[] = [];
  let truncated = false;

  // BFS over directories so a broad-but-shallow tree is covered before a deep one,
  // and the maxFiles cap favours top-level (usually more relevant) files.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        return { root, files, truncated };
      }
      const name = entry.name;
      const abs = join(dir, name);
      if (entry.isDirectory()) {
        if (ignore.has(name)) continue;
        if (depth + 1 <= maxDepth) queue.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue; // skip symlinks/sockets/fifos
      let st: Stats;
      try {
        st = statSync(abs);
      } catch {
        continue; // vanished/unreadable — skip
      }
      files.push({
        path: relative(root, abs).split(sep).join("/"),
        absPath: abs,
        size: st.size,
        ext: extname(name).toLowerCase(),
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return { root, files, truncated };
}
