/**
 * ikbi worker-model — SCOUT role (Pass A: read-only investigation, model-driven).
 *
 * Scoped (pending 3-eyes): gather repo/context relevant to the goal and produce
 * findings. STRICTLY READ-ONLY — scout never writes, stages, or mutates anything
 * under the workspace or target repo; it only lists/reads a BOUNDED set of files
 * and asks a model to analyze them.
 *
 * UNTRUSTED INPUT (C4): the goal, task metadata, and especially the repository
 * EXCERPTS (raw file contents — a malicious repo file could embed instructions) are
 * untrusted DATA. Each enters the prompt through `ctx.engine.neutralizeUntrusted` +
 * `toUntrustedMessage` (a structurally-isolated data-role message, `untrusted: true`),
 * never raw-concatenated into the trusted SYSTEM instructions. Same chokepoint the
 * newer modules use (agent-router / cognition).
 *
 * Every model call carries `identity: ctx.identity` — the spawned, ceiling-clamped
 * role identity (#10).
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

import { toUntrustedMessage } from "../../core/injection/index.js";
import type { ModelMessage, ModelRequest } from "../../core/provider/contract.js";
import type { RoleFn } from "./contract.js";
import { driverModel } from "./role-models.js";
import { goalTokens, type ProjectRetrievalApi } from "../project-retrieval/index.js";
import { resolveRetrievalMode, type RetrievalMode } from "./modes.js";

/** A single thing scout learned. Lives in the open `detail` bag — NOT a contract type. */
export interface ScoutFinding {
  readonly title: string;
  readonly detail: string;
  readonly files?: readonly string[];
  /** PROGRESSIVE DISCLOSURE: the primary file this finding references, if one was named. */
  readonly path?: string;
  /** The line range within `path` the finding points at, as [start, end] (1-based), if given. */
  readonly lines?: readonly [number, number];
}

/** One entry in the scout's STRUCTURE index — a scanned file with its size. The brief is built from these. */
export interface ScoutFileEntry {
  readonly path: string;
  readonly lines: number;
  readonly bytes: number;
}

// --- named constants (no magic values inline) ------------------------------
// The model id is DRIVER-tier and config-driven (see role-models.ts) — resolved at
// request time so an operator's IKBI_MODEL_DRIVER takes effect without a roster alias.
const SCOUT_TEMPERATURE = 0.2;
const SCOUT_MAX_TOKENS = 1024;
/** Hard cap on files visited — scout never walks the whole tree. */
const MAX_FILES_SCANNED = 40;
/** Per-file byte cap fed to the model. */
const MAX_FILE_BYTES = 4_000;
/** Total byte cap of gathered context. */
const MAX_TOTAL_BYTES = 60_000;
const DEFAULT_INDEX_FALLBACK_BLOCK_MIN_FILES = 500;
const SCAN_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".jsx", ".json", ".md"]);
const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);

const SCOUT_SYSTEM =
  "You are the SCOUT in a build pipeline. Investigate the provided repository " +
  "excerpts against the stated goal and list concise, concrete findings (one per " +
  "line, starting with '- '): what exists, what's relevant, and what the builder " +
  "should know. When a finding is about a specific file, START the line with its " +
  "path and (if you can) a line number, like `- src/foo.ts:42 — does X`, so the " +
  "builder can drill straight to it. Read-only — do not propose edits.";
/** Max files listed in the deterministic structure brief (keeps the brief cheap-model sized). */
const MAX_BRIEF_FILES = 15;

/** Bounded, read-only directory walk. Stops at MAX_FILES_SCANNED; skips heavy dirs. */
function gatherFiles(root: string): string[] {
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
 * GOAL-AWARE legacy ordering. The legacy walk (`gatherFiles`) returns files in raw
 * filesystem-traversal order with zero goal relevance — so the first 40 are whatever the
 * walk happened to hit. This re-orders the SAME bounded set (cap unchanged) so files whose
 * repo-relative path contains a goal token sort first; ties keep their original walk order
 * (stable). When the goal yields no usable tokens, order is left exactly as-is.
 */
function sortByGoalRelevance(files: readonly string[], root: string, goal: string): string[] {
  const { pathTokens, nameTokens } = goalTokens(goal);
  const tokens = [...pathTokens, ...nameTokens].map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (tokens.length === 0) return [...files];
  const score = (full: string): number => {
    const rel = relative(root, full).toLowerCase();
    let s = 0;
    for (const t of tokens) if (rel.includes(t)) s += 1;
    return s;
  };
  return files
    .map((f, i) => ({ f, i, s: score(f) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f);
}

function fallbackBlockThreshold(env: NodeJS.ProcessEnv): number {
  const raw = env.IKBI_RETRIEVAL_FALLBACK_BLOCK_MIN_FILES;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_INDEX_FALLBACK_BLOCK_MIN_FILES;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INDEX_FALLBACK_BLOCK_MIN_FILES;
}

function reachesFileThreshold(root: string, threshold: number): boolean {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile() && SCAN_EXTENSIONS.has(extname(e.name))) {
        count += 1;
        if (count >= threshold) return true;
      }
    }
  }
  return false;
}

/** Read a bounded slice of each file into a single context string. Read-only. Also
 *  returns the STRUCTURE index (each scanned file's path + line/byte size). */
function buildContext(files: readonly string[], root: string): { text: string; used: number; structure: ScoutFileEntry[] } {
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

/**
 * PROGRESSIVE DISCLOSURE: a compact, DETERMINISTIC structure brief the builder sees
 * FIRST — top-level directories + the most important scanned files with line counts —
 * so a cheap model gets the lay of the land without the whole codebase dumped on it. It
 * drills into specifics on demand via the builder's `scout_detail` tool.
 *
 * RANKING: when `scores` is supplied (index mode, where project-retrieval already computed
 * per-file relevance), Key files are ordered by relevance DESC. Without scores (legacy mode),
 * we fall back to the old behavior — largest files first.
 */
function buildBrief(structure: readonly ScoutFileEntry[], scores?: ReadonlyMap<string, number>): string {
  if (structure.length === 0) return "No files were scanned.";
  const dirs = new Set<string>();
  for (const e of structure) {
    const slash = e.path.indexOf("/");
    dirs.add(slash === -1 ? "(root)" : e.path.slice(0, slash) + "/");
  }
  const byRelevance = scores !== undefined;
  // Index mode: relevance DESC (ties → larger first for stability). Legacy: bytes DESC.
  const top = [...structure]
    .sort((a, b) => (byRelevance ? (scores.get(b.path) ?? 0) - (scores.get(a.path) ?? 0) || b.bytes - a.bytes : b.bytes - a.bytes))
    .slice(0, MAX_BRIEF_FILES);
  const lines = [
    `Repository structure (${structure.length} file(s) scanned).`,
    `Top-level: ${[...dirs].sort().join(", ")}`,
    byRelevance ? "Key files (most relevant first):" : "Key files (largest first):",
    ...top.map((e) => `  - ${e.path} (${e.lines} lines)`),
  ];
  return lines.join("\n");
}

/** Extract a leading `path[:line[-line]]` reference from a finding line, if present. */
function extractPathRef(text: string): { path?: string; lines?: [number, number] } {
  // A path-like token: contains a slash or a dotted extension, optionally `:line` or `:line-line`.
  const m = text.match(/(?:^|\s)([\w./-]+\.[A-Za-z0-9]+)(?::(\d+)(?:-(\d+))?)?/);
  if (m === null || m[1] === undefined) return {};
  const path = m[1];
  if (m[2] === undefined) return { path };
  const start = Number.parseInt(m[2], 10);
  const end = m[3] !== undefined ? Number.parseInt(m[3], 10) : start;
  return { path, lines: [start, end] };
}

/**
 * Locate the structure-index entry a finding's path ref points at, matching exactly or by path
 * suffix. When several scanned files share a basename (e.g. `src/a/login.ts` and `src/b/login.ts`)
 * a bare-basename ref is ambiguous — disambiguate deterministically: an EXACT path match wins;
 * otherwise prefer the candidate whose path differs LEAST from the ref (fewest extra leading
 * segments), then the shortest path overall. This keeps canonicalization stable and predictable.
 */
function findStructureEntry(path: string, structure: readonly ScoutFileEntry[]): ScoutFileEntry | undefined {
  const lower = path.toLowerCase();
  const matches = structure.filter((e) => {
    const p = e.path.toLowerCase();
    return p === lower || p.endsWith(`/${lower}`) || lower.endsWith(`/${p}`);
  });
  if (matches.length <= 1) return matches[0];
  return [...matches].sort((a, b) => {
    const ap = a.path.toLowerCase();
    const bp = b.path.toLowerCase();
    const aExact = ap === lower ? 0 : 1;
    const bExact = bp === lower ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact; // exact path match wins outright
    const aDiff = Math.abs(ap.length - lower.length);
    const bDiff = Math.abs(bp.length - lower.length);
    if (aDiff !== bDiff) return aDiff - bDiff; // smallest path difference next
    return ap.length - bp.length; // final tiebreak: shortest path
  })[0];
}

/**
 * Validate an extracted path:line ref against the STRUCTURE index so hallucinated references
 * never flow to the builder. A path that names no scanned file is DROPPED entirely (the finding's
 * prose survives, but its drill-down ref does not). A path that exists but cites an out-of-range
 * line keeps the path and drops only the bogus line range.
 *
 * CANONICALIZATION: when the model names a file by a SUFFIX (e.g. "login.ts" for the scanned
 * "src/auth/login.ts"), the surviving ref is rewritten to the matched entry's FULL repo-relative
 * path. Downstream path-based drilldown (scout_detail) keys on the scanned path, so handing it the
 * short form could fail to resolve the file — always emit the canonical path.
 */
function validateRef(ref: { path?: string; lines?: [number, number] }, structure: readonly ScoutFileEntry[]): { path?: string; lines?: [number, number] } {
  if (ref.path === undefined) return {};
  const entry = findStructureEntry(ref.path, structure);
  if (entry === undefined) return {}; // hallucinated path — drop the whole ref
  const canonical = entry.path; // rewrite suffix/case-variant refs to the scanned file's full path
  if (ref.lines === undefined) return { path: canonical };
  const [start, end] = ref.lines;
  const inRange = start >= 1 && end >= start && end <= entry.lines;
  return inRange ? { path: canonical, lines: ref.lines } : { path: canonical }; // out-of-range — drop only the lines
}

/**
 * Parse the model's bullet output into structured findings; fall back to one finding.
 * Each extracted path:line ref is VALIDATED against `structure` (the file list the scout actually
 * scanned) — refs to nonexistent files or out-of-range lines are dropped rather than handed downstream.
 */
function parseFindings(content: string, structure: readonly ScoutFileEntry[]): ScoutFinding[] {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l) || /^\d+[.)]\s+/.test(l));
  if (bullets.length > 0) {
    return bullets.map((l, i) => {
      const detail = l.replace(/^([-*]|\d+[.)])\s+/, "");
      const ref = validateRef(extractPathRef(detail), structure);
      return {
        title: `finding-${i + 1}`,
        detail,
        ...(ref.path !== undefined ? { path: ref.path } : {}),
        ...(ref.lines !== undefined ? { lines: ref.lines } : {}),
      };
    });
  }
  const detail = content.trim();
  return [{ title: "investigation", detail: detail.length > 0 ? detail : "(no analysis returned)" }];
}

// ── LAYER 2: Scout-level goal-file alignment ────────────────────────────────────

/** Assessment of whether the goal maps to specific files in the repo. */
export interface GoalFileAlignment {
  /** Files explicitly mentioned in the goal that were found in the repo. */
  readonly matchedFiles: readonly string[];
  /** Files explicitly mentioned in the goal that were NOT found in the repo. */
  readonly missingFiles: readonly string[];
  /** Overall alignment: "aligned" (goal maps to found files), "broad" (no specific files mentioned), or "misaligned" (goal mentions files not found). */
  readonly status: "aligned" | "broad" | "misaligned";
  /** Human-readable summary of the alignment. */
  readonly summary: string;
}

/**
 * Assess whether the goal mentions specific files that the scout found (or didn't find).
 * PURE — no model calls. Extracts file-like references from the goal and checks against
 * the scout's structure index.
 */
export function assessGoalFileAlignment(goal: string, structure: readonly ScoutFileEntry[]): GoalFileAlignment {
  const repoFiles = structure.map((f) => f.path.toLowerCase());

  // Extract file-like references from the goal (paths, filenames with extensions)
  const filePattern = /[\w\-./]+\.\w{1,10}/g;
  const mentioned = goal.match(filePattern) ?? [];

  const matchedFiles: string[] = [];
  const missingFiles: string[] = [];

  for (const ref of mentioned) {
    const refLower = ref.toLowerCase();
    // Check if the file exists in the repo (exact match or suffix match)
    const found = repoFiles.some((f) => f === refLower || f.endsWith(`/${refLower}`) || refLower.endsWith(`/${f}`) || f.includes(refLower));
    if (found) {
      matchedFiles.push(ref);
    } else {
      missingFiles.push(ref);
    }
  }

  // Determine status
  let status: "aligned" | "broad" | "misaligned";
  let summary: string;

  if (mentioned.length === 0) {
    status = "broad";
    summary = "Goal does not reference specific files — builder will need to determine targets from context";
  } else if (missingFiles.length > 0) {
    status = "misaligned";
    summary = `Goal references ${missingFiles.join(", ")} but ${missingFiles.length === 1 ? "this file was" : "these files were"} not found in the repository`;
  } else {
    status = "aligned";
    summary = `Goal maps to ${matchedFiles.join(", ")} — found in repository`;
  }

  return { matchedFiles, missingFiles, status, summary };
}

/** Injectable scout dependencies. Defaults preserve the legacy behavior exactly. */
export interface ScoutDeps {
  /** Index-backed retrieval, used ONLY when IKBI_RETRIEVAL=index. Default: the lazy singleton. */
  readonly retrieval?: ProjectRetrievalApi;
  /** Env source for the IKBI_RETRIEVAL flag (tests inject). Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Explicit retrieval mode, set by the PRODUCTION wiring (orchestrator) so production
   * defaults to the HARDENED index retrieval. When set it WINS over env; when omitted, the
   * mode is env-derived with legacy as the bare-construction default (so direct
   * `createScout()` callers / existing tests are byte-unchanged). The index path remains
   * FAIL-SAFE: any retrieval failure/empty selection still falls back to the legacy scan.
   */
  readonly mode?: RetrievalMode;
}

/**
 * Build the scout role.
 *
 * DEFAULT BEHAVIOR IS UNCHANGED: a bounded legacy traversal sample (`gatherFiles`). When
 * `IKBI_RETRIEVAL=index`, file selection is delegated to the deterministic, index-backed
 * project-retrieval — which finds goal-relevant files anywhere in the tree instead of the first 40
 * traversal files. ANY index/retrieval failure (or an empty selection) falls back to the legacy
 * scan, so the flag can never make scout worse than before. The result records which path ran
 * (`detail.retrievalMode` + the summary that the orchestrator writes into the role receipt).
 */
export function createScout(deps: ScoutDeps = {}): RoleFn {
  return async (ctx) => {
    try {
      const root = ctx.workspace.path;
      const env = deps.env ?? process.env;
      // Mode precedence: an explicit production `mode` wins; otherwise env-derived with legacy
      // as the bare-construction default (resolveRetrievalMode(..., { production: false })).
      const wantIndex = (deps.mode ?? resolveRetrievalMode(env, { production: false })) === "index";

      let files: string[];
      // "legacy" = flag off (the unchanged default). "index" = retrieval used. "index-fallback" =
      // flag ON but retrieval failed/empty and we fell back to legacy (F4: surfaced loudly).
      let retrievalMode: "index" | "legacy" | "index-fallback" = "legacy";
      let retrievalFallbackReason: string | undefined;
      let modeNote = "via legacy scan";
      let retrievalDetail: { selected: Array<{ path: string; reasons: readonly string[]; why: string }>; receipts: readonly string[] } | undefined;
      // Index mode only: project-retrieval's per-file relevance scores, keyed by repo-relative path.
      // Drives buildBrief ordering so the brief leads with the most goal-relevant files, not the biggest.
      let relevanceScores: Map<string, number> | undefined;

      if (wantIndex) {
        try {
          const retrieval = deps.retrieval ?? (await import("../project-retrieval/index.js")).projectRetrieval;
          const res = await retrieval.retrieve({ repoPath: root, goal: ctx.task.goal, budgetBytes: MAX_TOTAL_BYTES, perFileCapBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES_SCANNED });
          if (res.files.length === 0) throw new Error("retrieval selected no files");
          files = res.files.map((f) => join(root, f.path));
          retrievalMode = "index";
          modeNote = "via index retrieval";
          relevanceScores = new Map(res.files.map((f) => [f.path, f.score]));
          retrievalDetail = { selected: res.files.map((f) => ({ path: f.path, reasons: f.reasons, why: f.why })), receipts: res.receipts };
        } catch (e) {
          // FAIL-SAFE + LOUD (F4): never let the index path make scout worse — fall back to the legacy
          // scan, but record a DISTINCT mode + reason so a persistently-broken index isn't silent.
          const reason = e instanceof Error ? e.message : String(e);
          const threshold = fallbackBlockThreshold(env);
          if (reachesFileThreshold(root, threshold)) {
            throw new Error(`index retrieval failed on a large repo (>=${threshold} scanned source files); refusing silent legacy fallback. Reason: ${reason}`);
          }
          files = sortByGoalRelevance(gatherFiles(root), root, ctx.task.goal);
          retrievalMode = "index-fallback";
          retrievalFallbackReason = reason;
          modeNote = `IKBI_RETRIEVAL=index but index retrieval FAILED — fell back to legacy scan (reason: ${retrievalFallbackReason})`;
        }
      } else {
        // bounded, read-only — the unchanged default walk, now re-ordered so goal-relevant
        // files lead the (still 40-capped) set instead of raw traversal order.
        files = sortByGoalRelevance(gatherFiles(root), root, ctx.task.goal);
      }

      const { text, used, structure } = buildContext(files, root);

      // C4: each untrusted block is neutralized + wrapped as an isolated data-role
      // message (untrusted:true) — never raw-concatenated into the trusted system prompt.
      const untrusted = (raw: string, origin: string): ModelMessage =>
        toUntrustedMessage(ctx.engine.neutralizeUntrusted(raw, { source: "external", identity: ctx.identity, origin }), { role: "user" });

      const request: ModelRequest = {
        model: driverModel(),
        temperature: SCOUT_TEMPERATURE,
        maxTokens: SCOUT_MAX_TOKENS,
        identity: ctx.identity, // the spawned, ceiling-clamped role identity (#10)
        messages: [
          { role: "system", content: SCOUT_SYSTEM },
          untrusted(`Goal:\n${ctx.task.goal}`, "scout_goal"),
          untrusted(`Task metadata: ${JSON.stringify(ctx.task.metadata ?? {})}`, "scout_metadata"),
          untrusted(`Repository excerpts (${used} file(s)):\n${text}`, "scout_repo_excerpts"),
        ],
      };

      const response = await ctx.engine.invokeModel(request);
      const findings = parseFindings(response.content, structure);
      const brief = buildBrief(structure, relevanceScores);

      // ── LAYER 2: Scout-level ambiguity detection ───────────────────────────
      // Check if the goal mentions specific files that the scout found (or didn't find).
      const goalAlignment = assessGoalFileAlignment(ctx.task.goal, structure);

      return {
        role: "scout",
        outcome: "success",
        summary: `scouted ${used} file(s) ${modeNote}; produced ${findings.length} finding(s); goal alignment: ${goalAlignment.summary}`,
        // `brief` + `structure` drive PROGRESSIVE DISCLOSURE downstream: the builder shows the
        // brief first and pulls a finding's full `detail` only on demand (scout_detail tool).
        // `retrievalMode` (+ `retrieval` when index-backed) records HOW context was selected.
        detail: { findings, filesScanned: used, brief, structure, retrievalMode, goalAlignment, ...(retrievalFallbackReason !== undefined ? { retrievalFallbackReason } : {}), ...(retrievalDetail !== undefined ? { retrieval: retrievalDetail } : {}) },
      };
    } catch (err) {
      // IO / model failure: report at the role boundary, do not throw past it.
      return {
        role: "scout",
        outcome: "failure",
        summary: `scout failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

/** The default scout (legacy by default; index-backed only under IKBI_RETRIEVAL=index). */
export const scout: RoleFn = createScout();
