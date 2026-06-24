/**
 * ikbi LSP module — project language detection.
 *
 * Detection is config-first (a manifest is the strongest signal a project uses a language),
 * with a shallow extension scan as a fallback so a config-less script directory is still
 * covered. Pure, read-only, and bounded: it never recurses into dependency/build dirs and
 * caps how many entries it scans, so detection on a huge tree stays cheap.
 *
 * Results are CACHED per project directory (the work order's "cache LSP instances per project
 * directory") — detection is idempotent for a given tree and the cache is invalidated only by
 * an explicit `clearDetectionCache()` (used by tests).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { DetectedLanguage, LspLanguage } from "./contract.js";

/** Config manifests that unambiguously mark a language at the project root. */
const CONFIG_MARKERS: ReadonlyArray<{ readonly file: string; readonly language: LspLanguage }> = [
  { file: "tsconfig.json", language: "typescript" },
  { file: "jsconfig.json", language: "typescript" },
  { file: "pyproject.toml", language: "python" },
  { file: "setup.py", language: "python" },
  { file: "setup.cfg", language: "python" },
  { file: "requirements.txt", language: "python" },
  { file: "go.mod", language: "go" },
  { file: "Cargo.toml", language: "rust" },
];

/** File extensions that map to a language (the fallback signal when no manifest is present). */
const EXTENSION_MARKERS: ReadonlyMap<string, LspLanguage> = new Map([
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".py", "python"],
  [".pyi", "python"],
  [".go", "go"],
  [".rs", "rust"],
]);

/** Directories never worth scanning for source extensions. */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".git", "dist", "build", "target", ".next", ".cache", "vendor", "__pycache__", ".venv", "venv",
]);

/** Max directory entries scanned during the extension fallback (keeps detection cheap on huge trees). */
const MAX_SCAN_ENTRIES = 2_000;

/**
 * Max distinct project directories kept in the detection cache (RC5). A long-running server can see
 * an unbounded number of project roots over its lifetime; without a cap the cache grows forever.
 * Bounded LRU: on overflow the least-recently-used entry is evicted. Override with
 * `IKBI_LSP_DETECT_CACHE_MAX` (positive integer); defaults to 256.
 */
const DETECTION_CACHE_MAX = ((): number => {
  const raw = Number(process.env.IKBI_LSP_DETECT_CACHE_MAX);
  return Number.isInteger(raw) && raw > 0 ? raw : 256;
})();

// Insertion order doubles as recency order (a Map preserves it): the FIRST key is the LRU victim,
// and a read re-inserts its key to mark it most-recently-used.
const detectionCache = new Map<string, readonly DetectedLanguage[]>();

/** Clear the per-directory detection cache (tests use this to avoid cross-test bleed). */
export function clearDetectionCache(): void {
  detectionCache.clear();
}

/** Current number of cached directories (exposed for tests asserting the cap holds). */
export function detectionCacheSize(): number {
  return detectionCache.size;
}

/** LRU read: return the cached value and bump it to most-recently-used, or undefined on a miss. */
function cacheGet(dir: string): readonly DetectedLanguage[] | undefined {
  const value = detectionCache.get(dir);
  if (value === undefined) return undefined;
  detectionCache.delete(dir);
  detectionCache.set(dir, value);
  return value;
}

/** LRU write: insert (most-recent), evicting the least-recently-used entry once over the cap. */
function cacheSet(dir: string, value: readonly DetectedLanguage[]): void {
  if (detectionCache.has(dir)) {
    detectionCache.delete(dir);
  } else if (detectionCache.size >= DETECTION_CACHE_MAX) {
    const lru = detectionCache.keys().next().value;
    if (lru !== undefined) detectionCache.delete(lru);
  }
  detectionCache.set(dir, value);
}

/**
 * Detect which languages a project directory uses. Config manifests at the root win; if none
 * are found, a bounded recursive extension scan supplies the fallback. The result is cached
 * per directory. Ordering is stable: typescript, python, go, rust.
 */
export function detectLanguages(rootDir: string): readonly DetectedLanguage[] {
  const cached = cacheGet(rootDir);
  if (cached !== undefined) return cached;

  const found = new Map<LspLanguage, string>();

  // 1) Config-first: a root manifest is the strongest signal.
  for (const marker of CONFIG_MARKERS) {
    if (found.has(marker.language)) continue;
    if (existsSync(join(rootDir, marker.file))) found.set(marker.language, marker.file);
  }

  // 2) Extension fallback (bounded) for languages no manifest revealed.
  if (found.size < EXTENSION_MARKERS.size) {
    scanExtensions(rootDir, found);
  }

  const ordered: LspLanguage[] = ["typescript", "python", "go", "rust"];
  const result: DetectedLanguage[] = ordered
    .filter((lang) => found.has(lang))
    .map((lang) => ({ language: lang, marker: found.get(lang) as string }));

  cacheSet(rootDir, result);
  return result;
}

/** Bounded breadth-first extension scan; records the first matching file per language. */
function scanExtensions(rootDir: string, found: Map<LspLanguage, string>): void {
  const queue: string[] = [rootDir];
  let scanned = 0;
  while (queue.length > 0 && scanned < MAX_SCAN_ENTRIES) {
    const dir = queue.shift() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      scanned += 1;
      if (scanned >= MAX_SCAN_ENTRIES) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(join(dir, entry.name));
        continue;
      }
      const dot = entry.name.lastIndexOf(".");
      if (dot < 0) continue;
      const ext = entry.name.slice(dot);
      const lang = EXTENSION_MARKERS.get(ext);
      if (lang !== undefined && !found.has(lang)) found.set(lang, `*${ext}`);
    }
  }
}
