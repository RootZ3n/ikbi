/**
 * ikbi context loader — relevance scoring + lazy, budget-bounded file loading.
 *
 * Given a file index (indexer.ts) and the current prompt, `scoreFiles` ranks files by how
 * likely they are to matter — path/keyword matches, source-file weighting, and recency — and
 * `selectContext` walks that ranking, lazily reading file content and admitting each into a
 * token budget (budget.ts) until the budget is spent. Nothing is read until it's selected, so
 * a 1000-file repo costs one cheap index plus a handful of reads per prompt.
 */

import { readFileSync } from "node:fs";

import type { FileIndex, IndexedFile } from "./indexer.js";
import { ContextBudget, estimateTokens } from "./budget.js";

/** A file with its computed relevance to a prompt. */
export interface ScoredFile {
  readonly file: IndexedFile;
  readonly score: number;
}

/** A file whose content has been read for the context window. */
export interface LoadedFile {
  readonly path: string;
  readonly content: string;
  readonly tokens: number;
  readonly score: number;
}

export interface ScoreOptions {
  /** Extra paths to treat as "hot" (already in use) — they get a relevance bonus. */
  readonly hotPaths?: Iterable<string>;
  /** Now (ms epoch) for recency scoring. Defaults to the newest mtime in the index. */
  readonly now?: number;
}

export interface SelectOptions extends ScoreOptions {
  /** Token budget for the selected files (default 24000). */
  readonly maxTokens?: number;
  /** Skip files larger than this many bytes (default 256 KiB) — huge files blow the budget. */
  readonly maxFileBytes?: number;
  /** Only consider files scoring at or above this threshold (default 0 — any positive score). */
  readonly minScore?: number;
  /** Reader injection point (tests). Defaults to fs.readFileSync(utf8). */
  readonly readFile?: (absPath: string) => string;
}

/** Source-code extensions get a base weight — they are far more useful as code context. */
const SOURCE_EXTS: ReadonlySet<string> = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs",
  ".swift", ".scala", ".sh", ".sql", ".vue", ".svelte",
]);
/** Docs/config get a smaller base weight than source but more than the rest. */
const DOC_EXTS: ReadonlySet<string> = new Set([".md", ".json", ".yaml", ".yml", ".toml", ".txt"]);

const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are", "was",
  "but", "not", "can", "use", "using", "add", "fix", "the", "all", "any", "out", "get", "set",
  "have", "has", "will", "should", "would", "make", "made", "when", "then", "than", "what",
  "how", "why", "where", "which", "code", "file", "files", "function", "please", "need",
]);

/** Extract lower-cased keyword tokens from a prompt (length ≥ 3, no stopwords). */
export function extractKeywords(prompt: string): string[] {
  const seen = new Set<string>();
  for (const raw of prompt.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/** The base, prompt-independent weight of a file by kind. */
function baseWeight(file: IndexedFile): number {
  if (SOURCE_EXTS.has(file.ext)) return 1;
  if (DOC_EXTS.has(file.ext)) return 0.5;
  return 0.2;
}

/**
 * Score one file against a set of prompt keywords. Path/basename keyword hits dominate
 * (a file literally named after a keyword is the strongest signal), then base file-kind
 * weight, then a small recency bonus. Returns a non-negative number.
 */
export function scoreFile(
  file: IndexedFile,
  keywords: readonly string[],
  opts: { hot?: boolean; newestMtime?: number } = {},
): number {
  const pathLower = file.path.toLowerCase();
  const baseName = (pathLower.split("/").pop() ?? pathLower);
  let score = baseWeight(file);

  for (const kw of keywords) {
    if (baseName.includes(kw)) {
      // A basename match is the loudest signal; exact stem match (foo.ts ~ "foo") louder still.
      const stem = baseName.replace(/\.[^.]+$/, "");
      score += stem === kw ? 6 : 3;
    } else if (pathLower.includes(kw)) {
      score += 1.5; // somewhere in the directory path
    }
  }

  // Recency: newer files get up to +0.5. Skip if we have no clock reference.
  if (opts.newestMtime !== undefined && opts.newestMtime > 0) {
    const ageRatio = file.mtimeMs / opts.newestMtime; // ~1 for the newest, smaller for older
    if (Number.isFinite(ageRatio)) score += Math.max(0, Math.min(0.5, ageRatio * 0.5));
  }

  if (opts.hot === true) score += 2; // already in use this session — bias toward keeping it

  return score;
}

/** Rank every file in the index by relevance to `prompt`, highest first. */
export function scoreFiles(index: FileIndex, prompt: string, opts: ScoreOptions = {}): ScoredFile[] {
  const keywords = extractKeywords(prompt);
  const hot = new Set(opts.hotPaths ?? []);
  const newestMtime = opts.now ?? index.files.reduce((m, f) => Math.max(m, f.mtimeMs), 0);
  const scored = index.files.map((file) => ({
    file,
    score: scoreFile(file, keywords, { hot: hot.has(file.path), newestMtime }),
  }));
  // Stable, deterministic order: score desc, then path asc as a tiebreak.
  scored.sort((a, b) => (b.score - a.score) || (a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0));
  return scored;
}

const DEFAULT_MAX_TOKENS = 24000;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

/**
 * Select and lazily load the most relevant files that fit within a token budget. Walks the
 * relevance ranking high→low, reading each candidate's content on demand and admitting it to
 * the budget; stops once the budget can admit nothing further. Files that fail to read, are
 * too large, or score below `minScore` are skipped. Returns the loaded files (in selection
 * order) and the budget used.
 */
export function selectContext(
  index: FileIndex,
  prompt: string,
  opts: SelectOptions = {},
): { files: LoadedFile[]; budget: ContextBudget } {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const minScore = opts.minScore ?? 0;
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const budget = new ContextBudget(maxTokens);

  const ranked = scoreFiles(index, prompt, opts);
  const loaded: LoadedFile[] = [];
  for (const { file, score } of ranked) {
    if (score <= minScore) break; // ranking is sorted desc — nothing past here qualifies
    if (file.size > maxFileBytes) continue;
    if (budget.remaining() <= 0) break;
    let content: string;
    try {
      content = read(file.absPath);
    } catch {
      continue; // unreadable now — skip
    }
    const tokens = estimateTokens(content);
    if (!budget.admit(file.path, tokens, score)) continue;
    loaded.push({ path: file.path, content, tokens, score });
  }
  return { files: loaded, budget };
}
