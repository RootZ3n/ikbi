/**
 * ikbi v2 — THE DETERMINISTIC RETRIEVAL AUTHORITY.
 *
 * RETRIEVAL DISCOVERS. THE CONTEXT AUTHORITY ADMITS.
 *
 * Until now a task that named no file got almost no repository evidence: the assembler
 * could only offer the goal and the repo's instruction files. v1 does have deterministic
 * relevance ranking, but it reaches a builder only through the MODEL-DRIVEN SCOUT — so
 * adopting it naively would hide a model call inside "context", which v2 forbids.
 *
 * This module ranks. It does not assemble, does not build a prompt, does not decide what
 * fits, and calls no model. It proposes candidates; `assembleContext` still applies the
 * one budget and the one priority policy, and still records every omission.
 *
 * IT IS PURE. It is handed paths and already-read content — never a repository path — so
 * it physically cannot reread a working tree that has moved on since the snapshot. The
 * runtime source (`src/v2/runtime/retrieval-source.ts`) does the reading, through the
 * run's `SourceSnapshotReader` and nothing else.
 *
 * DETERMINISM IS THE POINT. Identical snapshot + identical task ⇒ identical ranking, in
 * any process: every sort is total (score descending, then path ascending), no clock, no
 * randomness, no traversal order, no model. The `retrievalId` is a content address over
 * exactly the inputs that decide the outcome.
 *
 * ADOPTED FROM v1 (`modules/project-retrieval`): the goal-token mining shape, the stopword
 * idea, the reason-with-weight vocabulary and the decision trail. REPLACED: its input
 * boundary — v1 ranks over a filesystem-walking, separately-cached `project-index`, which
 * is precisely the mutable-source reread this design removes.
 */

import { contentDigest, type V2RetrievalDigest, type V2RunId, type V2SnapshotDigest, type V2TaskId } from "./identity.js";

/** Bumped whenever scoring changes semantics. Part of the retrieval identity. */
export const RETRIEVAL_ALGORITHM = "v2.deterministic.1";

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Prose words that carry no retrieval signal. Deliberately small: an aggressive stoplist
 * silently deletes meaning, and a term that matches nothing simply scores nothing.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "when", "then", "than",
  "add", "fix", "make", "use", "run", "get", "set", "new", "old", "not", "but", "all",
  "any", "can", "has", "have", "was", "are", "its", "it's", "you", "your", "our", "should",
  "please", "also", "just", "some", "more", "most", "very", "code", "file", "files",
  "change", "update", "issue", "bug", "problem", "error", "support", "implement",
]);

/** The deterministic query derived from the accepted task. No model, no expansion. */
export interface RetrievalQuery {
  /** Path-shaped tokens: `src/auth/login.ts`, `login.ts`. Strong, precise evidence. */
  readonly pathTokens: readonly string[];
  /** Lower-cased prose/identifier terms, stopworded. */
  readonly terms: readonly string[];
  /** Identifier fragments split out of CamelCase/snake_case, lower-cased. */
  readonly identifierParts: readonly string[];
}

/**
 * Normalize task text into a query.
 *
 * Prose is case-folded and stopworded, but IDENTIFIERS are preserved and additionally
 * split: `UserService.getUser` yields `userservice` and `getuser` AND the parts `user`,
 * `service`, `get`. Over-normalizing would lose the identifier; not splitting would miss
 * `user-service.ts`. Both are kept, and the parts score lower than whole terms.
 */
export function normalizeQuery(goal: string): RetrievalQuery {
  const pathTokens = new Set<string>();
  for (const match of goal.matchAll(/[\w.@-]*\/[\w.@/-]+|[\w.-]+\.[A-Za-z0-9]{1,6}\b/g)) {
    pathTokens.add(match[0].replace(/^\.\//, ""));
  }

  // A written path is already precise evidence, so its text is REMOVED before prose is
  // mined. Otherwise "src/widget.ts" would also contribute the free-floating term "src",
  // and every file under `src/` would score as a directory match — which is how a
  // retriever ends up "finding" a whole tree because the operator named one file in it.
  let prose = goal;
  for (const token of pathTokens) prose = prose.split(token).join(" ");

  const terms = new Set<string>();
  const identifierParts = new Set<string>();
  const addWord = (piece: string, intoParts: boolean): void => {
    const lower = piece.toLowerCase();
    if (lower.length < 3 || /^\d+$/.test(lower) || STOPWORDS.has(lower)) return;
    terms.add(lower);
    if (!intoParts) return;
    // CamelCase / snake_case / kebab fragments, so `getUser` also finds `get-user.ts`.
    for (const part of piece.split(/(?=[A-Z])|_|-/)) {
      const lowerPart = part.toLowerCase();
      if (lowerPart.length >= 3 && !STOPWORDS.has(lowerPart) && lowerPart !== lower) identifierParts.add(lowerPart);
    }
  };

  for (const word of prose.split(/[^A-Za-z0-9_.]+/)) {
    for (const piece of word.split(".")) addWord(piece, true);
  }

  // The BASENAME STEM of a named path is kept as a term, so a task that names a file
  // which does not exist under that exact path can still find the one that does.
  for (const token of pathTokens) {
    const basename = token.split("/").pop() ?? token;
    addWord(basename.replace(/\.[^.]+$/, ""), true);
  }

  return {
    pathTokens: [...pathTokens].sort(),
    terms: [...terms].sort(),
    identifierParts: [...identifierParts].sort(),
  };
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Why a file was ranked. Closed set, each with a fixed weight — a score is always
 * explainable as a sum of named reasons rather than an opaque number.
 */
export type RetrievalReason =
  | "path-named-in-task"
  | "filename-matches-term"
  | "directory-matches-term"
  | "content-covers-term"
  | "test-of-ranked-file"
  | "imports-ranked-file"
  | "imported-by-ranked-file";

export const REASON_WEIGHT: Readonly<Record<RetrievalReason, number>> = Object.freeze({
  "path-named-in-task": 40,
  "filename-matches-term": 16,
  "directory-matches-term": 6,
  "content-covers-term": 3,
  "test-of-ranked-file": 8,
  "imports-ranked-file": 4,
  "imported-by-ranked-file": 5,
});

/** One scored file, with the evidence that scored it. */
export interface RetrievalCandidate {
  readonly path: string;
  readonly contentSha256: string;
  readonly byteLength: number;
  readonly score: number;
  /** Each reason and how many times it fired. Sorted for a stable identity. */
  readonly reasons: readonly { readonly reason: RetrievalReason; readonly hits: number }[];
  readonly rank: number;
}

/** Why a path in the source universe was not even scored. */
export type RetrievalExclusionReason =
  | "binary"
  | "lockfile"
  | "vendored"
  | "too_large"
  | "unreadable_in_snapshot"
  | "not_source_text";

export interface RetrievalExclusion {
  readonly path: string;
  readonly reason: RetrievalExclusionReason;
}

// ---------------------------------------------------------------------------
// Request / result
// ---------------------------------------------------------------------------

/** Ranking limits. Deliberately SEPARATE from the context token budget. */
export interface RetrievalBudget {
  /** How many ranked candidates the retriever will return at most. */
  readonly maxCandidates: number;
  /** Files above this size are not scored — a megabyte of source is not evidence. */
  readonly maxFileBytes: number;
  /** A candidate must clear this to be offered at all. */
  readonly minScore: number;
}

export const DEFAULT_RETRIEVAL_BUDGET: RetrievalBudget = Object.freeze({
  maxCandidates: 20,
  maxFileBytes: 256 * 1024,
  minScore: 3,
});

export interface RetrievalRequest {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly goal: string;
  readonly budget: RetrievalBudget;
  /** Paths the assembler already has. Offered candidates never duplicate these. */
  readonly alreadyIncluded: readonly string[];
}

export interface RetrievalResult {
  readonly retrievalId: V2RetrievalDigest;
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly algorithm: string;
  readonly queryDigest: string;
  readonly query: RetrievalQuery;
  /** Ranked, best first. Never longer than `budget.maxCandidates`. */
  readonly candidates: readonly RetrievalCandidate[];
  /** How many source paths were considered at all. */
  readonly examinedCount: number;
  /** How many scored above `minScore` before the candidate limit was applied. */
  readonly matchedCount: number;
  readonly exclusions: readonly RetrievalExclusion[];
  /** Paths suppressed because the assembler already has them. */
  readonly duplicatesSuppressed: readonly string[];
}

/** One file as the retriever sees it: a path and the bytes the snapshot served. */
export interface RetrievableFile {
  readonly path: string;
  readonly content: string;
  readonly byteLength: number;
  readonly contentSha256: string;
}

// ---------------------------------------------------------------------------
// Exclusion policy
// ---------------------------------------------------------------------------

const LOCKFILES: ReadonlySet<string> = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock",
  "Gemfile.lock", "composer.lock", "go.sum", "bun.lockb",
]);

const VENDORED_SEGMENTS: readonly string[] = ["node_modules", "vendor", "third_party", ".venv", "site-packages"];

/** Extensions worth reading as source text. Anything else is not evidence for a coder. */
const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "yaml", "yml", "toml", "ini", "cfg",
  "py", "rs", "go", "java", "kt", "rb", "php", "cs", "c", "h", "cc", "cpp", "hpp", "swift",
  "sh", "bash", "zsh", "sql", "graphql", "css", "scss", "html", "vue", "svelte", "txt",
]);

/** Should this path be scored at all? Returns the exclusion reason when not. */
export function excludePath(path: string, byteLength: number, budget: RetrievalBudget): RetrievalExclusionReason | undefined {
  const segments = path.split("/");
  const basename = segments[segments.length - 1] ?? "";
  if (segments.some((segment) => VENDORED_SEGMENTS.includes(segment))) return "vendored";
  if (LOCKFILES.has(basename)) return "lockfile";
  const extension = basename.includes(".") ? (basename.split(".").pop() ?? "").toLowerCase() : "";
  if (!SOURCE_EXTENSIONS.has(extension)) return "not_source_text";
  if (byteLength > budget.maxFileBytes) return "too_large";
  return undefined;
}

/** A NUL byte means this is not text, whatever its extension claims. */
export function looksBinary(content: string): boolean {
  return content.includes("\0");
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

const stemOf = (path: string): string => {
  const basename = path.split("/").pop() ?? path;
  return basename.replace(/\.[^.]+$/, "").toLowerCase();
};

/**
 * The name that actually identifies a file to a person.
 *
 * Usually the basename stem — but in the extremely common `<module>/index.ts` layout the
 * basename says nothing and the DIRECTORY is the module's name. Without this, a task about
 * "the gate wall" scores `modules/gate-wall/index.ts` only as a weak directory match and
 * loses to files that merely mention the words.
 */
const identifyingStem = (path: string): string => {
  const stem = stemOf(path);
  if (stem !== "index" && stem !== "mod" && stem !== "__init__") return stem;
  const parent = path.split("/").at(-2);
  return parent !== undefined ? parent.toLowerCase() : stem;
};

/** Split a filename stem into comparable fragments: `login-token` → [login, token]. */
const stemParts = (stem: string): string[] => stem.split(/[-_.]/).filter((p) => p.length >= 3);

/** Import specifiers a file references. Regex-based on purpose: no parser, no language server. */
export function importSpecifiers(content: string): string[] {
  const out = new Set<string>();
  for (const re of [/\bfrom\s*["']([^"']+)["']/g, /\brequire\s*\(\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g]) {
    for (const match of content.matchAll(re)) if (match[1] !== undefined) out.add(match[1]);
  }
  return [...out];
}

/** Does `specifier`, as written in `fromPath`, plausibly name `targetPath`? */
export function resolvesTo(fromPath: string, specifier: string, targetPath: string): boolean {
  if (!specifier.startsWith(".")) return false;
  const fromDir = fromPath.split("/").slice(0, -1);
  const parts = specifier.split("/");
  const resolved: string[] = [...fromDir];
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  const base = resolved.join("/").replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, "");
  const targetBase = targetPath.replace(/\.[^./]+$/, "");
  return base === targetBase || `${base}/index` === targetBase;
}

/**
 * The distinct WORDS a file's text contains, lower-cased.
 *
 * Whole-word matching, deliberately: a substring search reports that a file about
 * "nothing" is evidence for a task about "things", and "art" would match "start". The
 * camel/snake fragments of each word are included too, so a task about "session" still
 * finds `refreshSessionToken`.
 */
export function contentWords(content: string): Set<string> {
  const words = new Set<string>();
  for (const raw of content.split(/[^A-Za-z0-9_]+/)) {
    if (raw.length === 0) continue;
    words.add(raw.toLowerCase());
    for (const part of raw.split(/(?=[A-Z])|_/)) if (part.length >= 3) words.add(part.toLowerCase());
  }
  return words;
}

const isTestPath = (path: string): boolean => /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[a-z]+$/.test(path);

/**
 * Score every file, then enrich the top of the list with relationship signals.
 *
 * Two passes on purpose: `test-of` and import edges are defined RELATIVE to the files
 * that already matched, so they cannot be computed until a first ranking exists. The
 * second pass looks only at the leaders, which keeps the work bounded and the outcome
 * independent of how many files the repository happens to have.
 */
export function rankFiles(files: readonly RetrievableFile[], query: RetrievalQuery, budget: RetrievalBudget): RetrievalCandidate[] {
  const hits = new Map<string, Map<RetrievalReason, number>>();
  const add = (path: string, reason: RetrievalReason, count = 1): void => {
    const forPath = hits.get(path) ?? new Map<RetrievalReason, number>();
    forPath.set(reason, (forPath.get(reason) ?? 0) + count);
    hits.set(path, forPath);
  };

  const searchTerms = [...query.terms, ...query.identifierParts];

  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const stem = identifyingStem(file.path);
    const stemFragments = stemParts(stem);
    const directories = file.path.split("/").slice(0, -1).map((d) => d.toLowerCase());

    // PATH NAMED IN THE TASK — the strongest evidence there is.
    for (const token of query.pathTokens) {
      const lowerToken = token.toLowerCase();
      if (lowerPath === lowerToken || lowerPath.endsWith(`/${lowerToken}`)) add(file.path, "path-named-in-task");
    }

    // A TEST FILE EARNS NO FILENAME CREDIT. `session.test.ts` matches the word "session"
    // only because `session.ts` does — paying it separately would rank derived evidence
    // alongside the thing it derives from, and a test would routinely displace the
    // implementation it exists to check. It still earns content coverage, still earns
    // `test-of-ranked-file`, and is still found outright when the task NAMES it.
    const derived = isTestPath(file.path);

    for (const term of query.terms) {
      if (!derived && (stem === term || stemFragments.includes(term))) add(file.path, "filename-matches-term");
      if (directories.includes(term)) add(file.path, "directory-matches-term");
    }
    // Identifier fragments are weaker evidence: they count for the filename only.
    for (const part of query.identifierParts) {
      if (!derived && (stem === part || stemFragments.includes(part))) add(file.path, "filename-matches-term");
    }

    if (searchTerms.length > 0) {
      const words = contentWords(file.content);
      // COVERAGE, NOT FREQUENCY. How many of the task's DISTINCT terms a file mentions is
      // evidence; how often it repeats one of them is not. Counting occurrences would let
      // a file that names an identifier five times outrank the file that DEFINES it —
      // and would make relevance a function of verbosity.
      let covered = 0;
      for (const term of searchTerms) if (words.has(term)) covered += 1;
      if (covered > 0) add(file.path, "content-covers-term", covered);
    }
  }

  const scoreOf = (path: string): number => {
    let total = 0;
    for (const [reason, count] of hits.get(path) ?? []) total += REASON_WEIGHT[reason] * count;
    return total;
  };

  // The leaders, by the same total order the final result uses.
  const leaders = files
    .map((f) => f.path)
    .filter((p) => scoreOf(p) >= budget.minScore)
    .sort((a, b) => scoreOf(b) - scoreOf(a) || a.localeCompare(b))
    .slice(0, budget.maxCandidates);
  const leaderSet = new Set(leaders);

  // SECOND PASS — relationships to the leaders.
  for (const file of files) {
    const stem = stemOf(file.path);
    // ONE RELATIONSHIP, ONE CREDIT. A colocated test necessarily imports its subject, so
    // paying it for both facts would count the same relationship twice — which is how a
    // test ends up ranked above the code it exists to check.
    const subjects = new Set<string>();
    if (isTestPath(file.path)) {
      const subject = stem.replace(/\.(test|spec)$/, "");
      for (const leader of leaders) {
        if (leader !== file.path && stemOf(leader) === subject) {
          add(file.path, "test-of-ranked-file");
          subjects.add(leader);
        }
      }
    }
    const specifiers = importSpecifiers(file.content);
    for (const leader of leaders) {
      if (leader === file.path || subjects.has(leader)) continue;
      if (specifiers.some((spec) => resolvesTo(file.path, spec, leader))) add(file.path, "imports-ranked-file");
    }
  }
  // `imported-by` is the mirror: a leader importing a file makes that file relevant.
  for (const file of files) {
    if (!leaderSet.has(file.path)) continue;
    const specifiers = importSpecifiers(file.content);
    for (const other of files) {
      if (other.path === file.path) continue;
      if (specifiers.some((spec) => resolvesTo(file.path, spec, other.path))) add(other.path, "imported-by-ranked-file");
    }
  }

  const byPath = new Map(files.map((f) => [f.path, f]));
  return [...hits.keys()]
    .map((path) => {
      const file = byPath.get(path)!;
      const reasons = [...(hits.get(path) ?? [])]
        .map(([reason, count]) => ({ reason, hits: count }))
        .sort((a, b) => a.reason.localeCompare(b.reason));
      return { path, contentSha256: file.contentSha256, byteLength: file.byteLength, score: scoreOf(path), reasons, rank: 0 };
    })
    .filter((c) => c.score >= budget.minScore)
    // TOTAL ORDER: score descending, then path ascending. Never traversal order.
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, budget.maxCandidates)
    .map((c, index) => ({ ...c, rank: index + 1 }));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/** Content address of the query alone — published so a receipt need not carry task text. */
export function queryDigest(query: RetrievalQuery): string {
  return contentDigest("retrieval", { pathTokens: query.pathTokens, terms: query.terms, identifierParts: query.identifierParts });
}

/**
 * Content address of the retrieval OUTCOME: which source state was searched, by which
 * algorithm, for which query, producing exactly which ranked files in which order.
 * Timestamps, checkout location and pre-sort iteration order are all excluded.
 */
export function retrievalDigest(input: {
  readonly sourceSnapshotId: V2SnapshotDigest;
  readonly algorithm: string;
  readonly query: RetrievalQuery;
  readonly budget: RetrievalBudget;
  readonly candidates: readonly RetrievalCandidate[];
}): V2RetrievalDigest {
  return contentDigest("retrieval", {
    sourceSnapshotId: input.sourceSnapshotId,
    algorithm: input.algorithm,
    query: { pathTokens: input.query.pathTokens, terms: input.query.terms, identifierParts: input.query.identifierParts },
    budget: input.budget,
    candidates: input.candidates.map((c) => ({
      path: c.path,
      contentSha256: c.contentSha256,
      score: c.score,
      rank: c.rank,
      reasons: c.reasons,
    })),
  });
}

/**
 * How the retrieval a run performed reaches that run's receipt.
 *
 * Retrieval is deliberately shaped as an ordinary context contributor, so it has no
 * channel back to the lifecycle — and inventing one inside the assembler would make the
 * assembler know about retrieval specifically. This seam keeps that knowledge out: the run
 * holds the reporter it wired in and asks it, once, after context is assembled.
 */
export interface RetrievalReporter {
  /** The retrieval this instance most recently performed, or undefined if it did none. */
  lastResult(): RetrievalResult | undefined;
}

/** A receipt-safe account of a retrieval. Paths, scores and counts — never file bodies. */
export interface RetrievalSummary {
  readonly retrievalId: string;
  readonly sourceSnapshotId: string;
  readonly algorithm: string;
  readonly queryDigest: string;
  readonly examined: number;
  readonly matched: number;
  readonly offered: number;
  readonly excluded: number;
  readonly duplicatesSuppressed: number;
  /** The leaders, for audit: path, score and the reasons that produced it. */
  readonly top: readonly { readonly path: string; readonly score: number; readonly reasons: readonly string[] }[];
}

export function summarizeRetrieval(result: RetrievalResult, offered: number, topN = 5): RetrievalSummary {
  return {
    retrievalId: result.retrievalId,
    sourceSnapshotId: result.sourceSnapshotId,
    algorithm: result.algorithm,
    queryDigest: result.queryDigest,
    examined: result.examinedCount,
    matched: result.matchedCount,
    offered,
    excluded: result.exclusions.length,
    duplicatesSuppressed: result.duplicatesSuppressed.length,
    top: result.candidates.slice(0, topN).map((c) => ({
      path: c.path,
      score: c.score,
      reasons: c.reasons.map((r) => `${r.reason}×${r.hits}`),
    })),
  };
}
