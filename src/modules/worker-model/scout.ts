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
import type { ProjectRetrievalApi } from "../project-retrieval/index.js";

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
 * FIRST — top-level directories + the largest scanned files with line counts — so a
 * cheap model gets the lay of the land without the whole codebase dumped on it. It
 * drills into specifics on demand via the builder's `scout_detail` tool.
 */
function buildBrief(structure: readonly ScoutFileEntry[]): string {
  if (structure.length === 0) return "No files were scanned.";
  const dirs = new Set<string>();
  for (const e of structure) {
    const slash = e.path.indexOf("/");
    dirs.add(slash === -1 ? "(root)" : e.path.slice(0, slash) + "/");
  }
  const top = [...structure].sort((a, b) => b.bytes - a.bytes).slice(0, MAX_BRIEF_FILES);
  const lines = [
    `Repository structure (${structure.length} file(s) scanned).`,
    `Top-level: ${[...dirs].sort().join(", ")}`,
    "Key files (largest first):",
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

/** Parse the model's bullet output into structured findings; fall back to one finding. */
function parseFindings(content: string): ScoutFinding[] {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const bullets = lines.filter((l) => /^[-*]\s+/.test(l) || /^\d+[.)]\s+/.test(l));
  if (bullets.length > 0) {
    return bullets.map((l, i) => {
      const detail = l.replace(/^([-*]|\d+[.)])\s+/, "");
      const ref = extractPathRef(detail);
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

/** Injectable scout dependencies. Defaults preserve the legacy behavior exactly. */
export interface ScoutDeps {
  /** Index-backed retrieval, used ONLY when IKBI_RETRIEVAL=index. Default: the lazy singleton. */
  readonly retrieval?: ProjectRetrievalApi;
  /** Env source for the IKBI_RETRIEVAL flag (tests inject). Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
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
      const wantIndex = (env.IKBI_RETRIEVAL ?? "").trim().toLowerCase() === "index";

      let files: string[];
      let retrievalMode: "index" | "legacy" = "legacy";
      let modeNote = "via legacy scan";
      let retrievalDetail: { selected: Array<{ path: string; reasons: readonly string[]; why: string }>; receipts: readonly string[] } | undefined;

      if (wantIndex) {
        try {
          const retrieval = deps.retrieval ?? (await import("../project-retrieval/index.js")).projectRetrieval;
          const res = await retrieval.retrieve({ repoPath: root, goal: ctx.task.goal, budgetBytes: MAX_TOTAL_BYTES, perFileCapBytes: MAX_FILE_BYTES, maxFiles: MAX_FILES_SCANNED });
          if (res.files.length === 0) throw new Error("retrieval selected no files");
          files = res.files.map((f) => join(root, f.path));
          retrievalMode = "index";
          modeNote = "via index retrieval";
          retrievalDetail = { selected: res.files.map((f) => ({ path: f.path, reasons: f.reasons, why: f.why })), receipts: res.receipts };
        } catch (e) {
          // FAIL-SAFE: never let the index path make scout worse — fall back to the legacy scan.
          files = gatherFiles(root);
          retrievalMode = "legacy";
          modeNote = `index retrieval unavailable (${e instanceof Error ? e.message : String(e)}); fell back to legacy scan`;
        }
      } else {
        files = gatherFiles(root); // bounded, read-only — the unchanged default
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
      const findings = parseFindings(response.content);
      const brief = buildBrief(structure);
      return {
        role: "scout",
        outcome: "success",
        summary: `scouted ${used} file(s) ${modeNote}; produced ${findings.length} finding(s)`,
        // `brief` + `structure` drive PROGRESSIVE DISCLOSURE downstream: the builder shows the
        // brief first and pulls a finding's full `detail` only on demand (scout_detail tool).
        // `retrievalMode` (+ `retrieval` when index-backed) records HOW context was selected.
        detail: { findings, filesScanned: used, brief, structure, retrievalMode, ...(retrievalDetail !== undefined ? { retrieval: retrievalDetail } : {}) },
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
