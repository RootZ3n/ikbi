/**
 * ikbi context manager — smart context loading for large repos.
 *
 * Ties the three pieces together into one session-scoped object:
 *   • indexer  — walk the tree once on construction (cheap metadata only)
 *   • loader   — score files by relevance to the prompt, lazily read the top ones
 *   • budget   — admit them under a hard token budget, evicting cold files
 *
 * Across a session it tracks which files have actually been used ("hot" files) and biases
 * them upward on subsequent prompts so they stay loaded. This is what lets the agent loop
 * work on 1000+ file repos without dumping the whole tree into the model.
 *
 * Frozen-core note: this module is pure (fs reads only, no provider/network), so wiring it
 * into the agent loop adds no new runtime dependency and cannot break governance.
 */

import { indexFileTree, type FileIndex, type IndexOptions } from "./indexer.js";
import { scoreFiles, selectContext, type LoadedFile, type ScoredFile, type SelectOptions } from "./loader.js";
import type { ContextBudget } from "./budget.js";

export {
  indexFileTree,
  DEFAULT_IGNORE_DIRS,
  type FileIndex,
  type IndexedFile,
  type IndexOptions,
} from "./indexer.js";
export {
  scoreFile,
  scoreFiles,
  selectContext,
  extractKeywords,
  type ScoredFile,
  type LoadedFile,
  type ScoreOptions,
  type SelectOptions,
} from "./loader.js";
export {
  ContextBudget,
  estimateTokens,
  type BudgetEntry,
} from "./budget.js";

/** The context selected for a single prompt. */
export interface SelectedContext {
  readonly files: readonly LoadedFile[];
  /** Total estimated tokens of the selected files. */
  readonly tokens: number;
  /** True if the underlying index was truncated (repo larger than the index cap). */
  readonly indexTruncated: boolean;
}

export interface ContextManagerOptions {
  /** Token budget per prompt (default 24000). */
  readonly maxTokens?: number;
  /** Index walk options (maxFiles, maxDepth, ignoreDirs). */
  readonly index?: IndexOptions;
  /** Default per-file size cap for content loading (bytes). */
  readonly maxFileBytes?: number;
  /** Reader injection point (tests). */
  readonly readFile?: (absPath: string) => string;
}

/**
 * A session-scoped context manager rooted at a repo directory. Indexes lazily on first use
 * (and cached thereafter; call `reindex()` after large file-tree changes), then `select(prompt)`
 * returns the most relevant files that fit the budget — remembering "hot" files across prompts.
 */
export class ContextManager {
  readonly root: string;
  private readonly opts: ContextManagerOptions;
  private idx: FileIndex | undefined;
  /** Files actually selected on a previous prompt — biased upward next time. */
  private readonly hot = new Set<string>();

  constructor(root: string, opts: ContextManagerOptions = {}) {
    this.root = root;
    this.opts = opts;
  }

  /** The current index, building it on first access. */
  index(): FileIndex {
    if (this.idx === undefined) this.idx = indexFileTree(this.root, this.opts.index ?? {});
    return this.idx;
  }

  /** Force a fresh tree walk (e.g. after the agent created/deleted many files). */
  reindex(): FileIndex {
    this.idx = indexFileTree(this.root, this.opts.index ?? {});
    return this.idx;
  }

  /** Paths currently marked hot (used on a prior prompt this session). */
  hotPaths(): readonly string[] {
    return [...this.hot];
  }

  /**
   * The most relevant files for `prompt`, ranked, WITHOUT reading any content (scoring only).
   * Cheap enough to call every turn — used to give the agent file-tree awareness (a "here are
   * the files that look relevant" map) so it can lazily `read_file` the ones it needs.
   */
  relevant(prompt: string, limit = 12): ScoredFile[] {
    return scoreFiles(this.index(), prompt, { hotPaths: this.hot })
      .filter((s) => s.score > 0)
      .slice(0, Math.max(0, limit));
  }

  /**
   * Select the most relevant files for `prompt` that fit the token budget. Files chosen here
   * become "hot" so they're biased upward on the next prompt (keeping the working set loaded).
   */
  select(prompt: string, overrides: Partial<SelectOptions> = {}): SelectedContext {
    const selOpts: SelectOptions = {
      hotPaths: this.hot,
      ...(this.opts.maxTokens !== undefined ? { maxTokens: this.opts.maxTokens } : {}),
      ...(this.opts.maxFileBytes !== undefined ? { maxFileBytes: this.opts.maxFileBytes } : {}),
      ...(this.opts.readFile !== undefined ? { readFile: this.opts.readFile } : {}),
      ...overrides,
    };
    const { files }: { files: LoadedFile[]; budget: ContextBudget } = selectContext(this.index(), prompt, selOpts);
    for (const f of files) this.hot.add(f.path);
    const tokens = files.reduce((sum, f) => sum + f.tokens, 0);
    return { files, tokens, indexTruncated: this.index().truncated };
  }
}

/** Convenience factory mirroring the rest of core's `create*`/singleton style. */
export function createContextManager(root: string, opts: ContextManagerOptions = {}): ContextManager {
  return new ContextManager(root, opts);
}
