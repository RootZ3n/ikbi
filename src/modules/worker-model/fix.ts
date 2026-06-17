/**
 * ikbi worker-model — THE FIX PIPELINE (docs/FIX-MODE-DESIGN.md).
 *
 *   build = "Create or change something to satisfy a goal."
 *   fix   = "A check failed. Diagnose why. Repair narrowly. Do not cheat."
 *
 * fix mode is ADDITIVE to build mode — it does not touch the 5-role build pipeline. It runs a
 * 12-stage, DIAGNOSIS-FIRST pipeline: stages 1-4 are READ-ONLY (snapshot → reproduce → parse →
 * classify); stage 4 GATES everything (a non-fixable category jumps straight to RESULT as a
 * first-class CORRECT_REFUSAL / TOOL_LIMITATION, with no edits). Only stages 7+ mutate files,
 * and only after an explicit, recorded diagnosis. Anti-cheat runs on EVERY attempt — even a
 * refusal (with no changes, it trivially passes). The receipt records every stage: if it is
 * not in the receipt, it did not happen.
 *
 * NEVER promotes: this slice hardcodes `promoted: false`. Promotion requires explicit human
 * approval (a future flag), by design (§6 `require_approval: true`).
 *
 * The pipeline is fully INJECTABLE (deps pattern, like the builder): the model seam
 * (`invokeModel`, the SAME provider build mode uses) and the check runner (`runCheck`) are
 * supplied by the caller, so the whole pipeline is testable without a live model or a real
 * subprocess.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { neutralizeUntrusted, toUntrustedMessage } from "../../core/injection/index.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/contract.js";
import type { AgentIdentity, ModelMessage, ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { resolveChecks } from "./checks.js";
import { parseCheckOutput } from "../check-triage/index.js";
import { confinePath } from "./builder-tools/confine.js";
import { antiCheatCheck, isTestFile, type FileChange } from "./fix-anti-cheat.js";
import { diagnoseFailure, type Diagnosis, type DiagnosisFile } from "./fix-diagnosis.js";
import { FixReceiptBuilder, type FixReceipt, type FixResult, type ParsedOutcomes } from "./fix-receipt.js";
import { applyFilePatch, extractDiff, parseUnifiedDiff } from "./patchsmith.js";
import { builderModel } from "./role-models.js";

/** A check command fix mode runs to reproduce/verify (e.g. `pytest -q`). */
export interface FixCheckCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/** Result of running a check: its exit code + combined output. */
export interface CheckRun {
  readonly exitCode: number;
  readonly output: string;
}

/** The LAST-RESORT check when project-type detection fails (no recognizable manifest). */
export const DEFAULT_FIX_CHECK: FixCheckCommand = { command: "python3", args: ["-m", "pytest", "-q"] };

/**
 * Resolve the default reproduce/verify check for a repo by DETECTING its project type — the same
 * detection the verifier and `audit` use (`resolveChecks`: Node→pnpm/npm/yarn test, Rust→cargo test,
 * Go→go test, Python→pytest, Godot→godot --headless). A Node.js repo no longer defaults to pytest
 * (the M1 bug). Picks the suite check (the one named "test", else the last resolved check — typecheck
 * comes first), and honors an operator-set `IKBI_CHECKS`. Falls back to pytest (DEFAULT_FIX_CHECK)
 * ONLY when no project type can be detected, preserving the original thin-slice behavior.
 */
export function defaultFixCheckFor(repo: string, env: NodeJS.ProcessEnv = process.env): FixCheckCommand {
  let root = repo;
  try {
    root = realpathSync(repo);
  } catch {
    /* unresolvable path — resolveChecks will fail closed and we fall back below */
  }
  const resolution = resolveChecks(root, env);
  if (!resolution.ok || resolution.checks.length === 0) return DEFAULT_FIX_CHECK;
  const test = resolution.checks.find((c) => c.name === "test") ?? resolution.checks[resolution.checks.length - 1]!;
  return { command: test.command, args: [...test.args] };
}

const PATCH_TEMPERATURE = 0;
const PATCH_MAX_TOKENS = 4_096;
const MAX_FILE_BYTES = 24_000;
const DEFAULT_IDENTITY: AgentIdentity = { agentId: "fix", functionalRole: "fix" };

/** Config files a fix may not touch without `--allow-config-edits` (alters test discovery). */
const CONFIG_FILE_RE = /(^|\/)(pyproject\.toml|setup\.cfg|setup\.py|pytest\.ini|tox\.ini|conftest\.py|package\.json|tsconfig[^/]*\.json|jest\.config\.[cm]?js|vitest\.config\.[cm]?[jt]s|\.coveragerc)$/;

export interface FixOptions {
  /** Absolute path to the target repo. */
  readonly repo: string;
  /** The failing check to reproduce + verify. Default: `pytest -q`. */
  readonly check?: FixCheckCommand;
  /** Allow editing test files (default false — tests are ground truth). */
  readonly allowTestEdits?: boolean;
  /** Allow editing config files that alter test discovery (default false). */
  readonly allowConfigEdits?: boolean;
  /** Hard cap on files the fix may modify (default 5). */
  readonly maxFiles?: number;
  /** Stages 1-4 only (diagnose, no edits). Default false. */
  readonly diagnoseOnly?: boolean;
  /** Optional free-form context handed to diagnosis (e.g. an operator note). */
  readonly goal?: string;
}

export interface FixDeps {
  /** Run a check in the repo (gate-wall/governed in production; a fake in tests). REQUIRED. */
  readonly runCheck: (repo: string, check: FixCheckCommand) => Promise<CheckRun>;
  /** The model seam — the SAME `invokeModel` build mode uses. Default: the live provider (lazy). */
  readonly invokeModel?: (request: ModelRequest) => Promise<ModelResponse>;
  /** #8 neutralization seam. Default: the core chokepoint. */
  readonly neutralize?: (content: string, context: UntrustedContext) => NeutralizedContent;
  /** Read a worktree-relative file. Default: confined fs read (null when absent/unreadable). */
  readonly readFile?: (repo: string, rel: string) => string | null;
  /** Write a worktree-relative file. Default: confined fs write. */
  readonly writeFile?: (repo: string, rel: string, content: string) => void;
  /** Resolve the repo HEAD sha for the snapshot. Default: `git rev-parse HEAD`. */
  readonly head?: (repo: string) => string;
  /** Wall-clock for receipt timestamps. Default: ISO now. */
  readonly now?: () => string;
  /** Gather candidate code+test files for diagnosis. Default: a bounded repo scan. */
  readonly candidateFiles?: (repo: string) => DiagnosisFile[];
  /** Model id. Default: the configured builder model. */
  readonly modelId?: string;
  /** Identity for model calls. Default: a fix-role identity. */
  readonly identity?: AgentIdentity;
}

export interface FixOutcome {
  readonly result: FixResult;
  readonly receipt: FixReceipt;
  /** ALWAYS false in this slice — promote requires explicit approval. */
  readonly promoted: boolean;
  readonly filesModified: readonly string[];
  readonly diagnosis: Diagnosis;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Stringify a check command for the receipt. */
function checkLabel(c: FixCheckCommand): string {
  return `${c.command} ${c.args.join(" ")}`.trim();
}

/** Detect a COLLECTION / tool crash (import/syntax/internal error) — distinct from an assertion failure. */
export function detectCollectionError(output: string): boolean {
  if (/errors during collection|ERROR collecting|INTERNALERROR|=+\s*ERRORS\s*=+/i.test(output)) return true;
  if (/\bE\s+(ImportError|ModuleNotFoundError|SyntaxError|IndentationError|TabError)\b/.test(output)) return true;
  return false;
}

/** Parse a check run into structured outcomes (deterministic — uses the check-triage parser). */
export function parseOutcomes(check: FixCheckCommand, run: CheckRun): ParsedOutcomes {
  const triage = parseCheckOutput({ name: "test", command: checkLabel(check), exitCode: run.exitCode, stdout: run.output });
  const framework = triage.detectedFrameworks[0];
  return {
    passed: triage.passed,
    failingTests: triage.failures,
    collectionError: detectCollectionError(run.output),
    summary: triage.errorSummary,
    ...(framework !== undefined ? { framework } : {}),
  };
}

/** Default candidate-file scan: bounded recursive walk for code+test sources. */
function defaultCandidateFiles(repo: string): DiagnosisFile[] {
  const exts = [".py", ".js", ".ts", ".jsx", ".tsx"];
  const skip = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".venv", "venv", ".next", ".cache"]);
  const out: DiagnosisFile[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || out.length >= 40) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= 40) return;
      if (e.name.startsWith(".") && e.name !== ".") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(full, depth + 1);
      } else if (exts.some((x) => e.name.endsWith(x))) {
        try {
          const content = readFileSync(full, "utf8").slice(0, MAX_FILE_BYTES);
          const rel = full.slice(repo.length + 1);
          out.push({ path: rel, content, isTest: isTestFile(rel) });
        } catch {
          /* unreadable — skip */
        }
      }
    }
  };
  walk(repo, 0);
  return out;
}

/** Default confined fs read (worktree-relative). */
function fsReadFile(repo: string, rel: string): string | null {
  const c = confinePath(realpathSync(repo), rel);
  if (!c.ok || !existsSync(c.full)) return null;
  try {
    return readFileSync(c.full, "utf8");
  } catch {
    return null;
  }
}

/** Default confined fs write (worktree-relative). Throws on a confinement violation. */
function fsWriteFile(repo: string, rel: string, content: string): void {
  const c = confinePath(realpathSync(repo), rel);
  if (!c.ok) throw new Error(c.error);
  mkdirSync(dirname(c.full), { recursive: true });
  writeFileSync(c.full, content, "utf8");
}

/** Default HEAD resolution (read-only). */
function gitHead(repo: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** The trusted patch-generator instruction (mirrors the patchsmith — cheap models choke on long rules). */
export const FIX_PATCH_SYSTEM =
  "You are a code repair engine. You have a CONFIRMED diagnosis and the file(s) to repair. Produce a " +
  "MINIMAL unified diff that fixes ONLY the diagnosed problem.\n\n" +
  "RULES:\n" +
  "- Return ONLY a unified diff: `--- a/path`, `+++ b/path`, then `@@ ... @@` hunks.\n" +
  "- Change the SMALLEST number of lines. Do not touch unrelated code.\n" +
  "- Do NOT weaken or delete tests. Do NOT wrap code in try/except to silence the failure.\n" +
  "- No commentary outside the diff.";

/** Map a non-fixable / refusal diagnosis category to its terminal result. */
function refusalResult(d: Diagnosis, allowTestEdits: boolean): FixResult | undefined {
  switch (d.category) {
    case "tool_limitation":
    case "parser_bug":
      return "TOOL_LIMITATION";
    case "verifier_environment_missing":
      return "ENVIRONMENT_MISSING";
    case "test_bug":
      return allowTestEdits ? undefined : "CORRECT_REFUSAL";
    case "implementation_bug":
    case "fixture_bug":
      return undefined; // fixable — proceed to repair
    case "unresolved":
      return "UNRESOLVED";
    default:
      return "NEEDS_HUMAN";
  }
}

/**
 * Run the 12-stage fix pipeline. NEVER throws past the boundary — an infrastructure failure
 * surfaces as a SAFE_FAIL/UNRESOLVED outcome with a complete receipt. Never promotes.
 */
export async function runFixPipeline(opts: FixOptions, deps: FixDeps): Promise<FixOutcome> {
  const check = opts.check ?? defaultFixCheckFor(opts.repo);
  const allowTestEdits = opts.allowTestEdits ?? false;
  const allowConfigEdits = opts.allowConfigEdits ?? false;
  const maxFiles = opts.maxFiles ?? 5;

  const invokeModel = deps.invokeModel ?? (async (req: ModelRequest) => (await import("../../core/provider/index.js")).invokeModel(req));
  const neutralize = deps.neutralize ?? neutralizeUntrusted;
  const readFile = deps.readFile ?? fsReadFile;
  const writeFile = deps.writeFile ?? fsWriteFile;
  const headOf = deps.head ?? gitHead;
  const now = deps.now ?? (() => new Date().toISOString());
  const candidateFiles = deps.candidateFiles ?? defaultCandidateFiles;
  const modelId = deps.modelId ?? builderModel();
  const identity = deps.identity ?? DEFAULT_IDENTITY;

  // ── STAGE 1: SNAPSHOT ──────────────────────────────────────────────────────
  const builder = new FixReceiptBuilder({ timestamp: now(), repo: opts.repo, check: checkLabel(check), head: headOf(opts.repo) });

  // A refusal/terminal that ran NO edits still runs anti-cheat (over zero changes) — §"anti-cheat
  // runs on EVERY attempt". Returns the assembled outcome.
  const terminalNoEdit = (result: FixResult, diagnosis: Diagnosis): FixOutcome => {
    const verdict = antiCheatCheck({ changes: [], allowedFiles: diagnosis.affectedFiles, allowTestEdits });
    builder.recordAntiCheat(verdict.passed, verdict.checks);
    return { result, receipt: builder.finalize(result), promoted: false, filesModified: [], diagnosis };
  };

  // ── STAGE 2: REPRODUCE ─────────────────────────────────────────────────────
  let reproduce: CheckRun;
  try {
    reproduce = await deps.runCheck(opts.repo, check);
  } catch (e) {
    const diagnosis: Diagnosis = { category: "unresolved", confidence: 0, evidence: `could not run the check: ${errMsg(e)}`, affectedFiles: [] };
    builder.recordReproduce(-1, { passed: false, failingTests: [], collectionError: true, summary: `check execution failed: ${errMsg(e)}` }, errMsg(e));
    builder.recordDiagnosis(diagnosis);
    return terminalNoEdit("UNRESOLVED", diagnosis);
  }

  // ── STAGE 3: PARSE ─────────────────────────────────────────────────────────
  const outcomes = parseOutcomes(check, reproduce);
  builder.recordReproduce(reproduce.exitCode, outcomes, reproduce.output);

  // ── STAGE 4: CLASSIFY ──────────────────────────────────────────────────────
  const files = candidateFiles(opts.repo);
  const diagnosis = await diagnoseFailure(
    { outcomes, rawOutput: reproduce.output, files, ...(opts.goal !== undefined ? { goal: opts.goal } : {}) },
    { invokeModel, neutralize, modelId, identity },
  );
  builder.recordDiagnosis(diagnosis);

  // GATE: a non-fixable category (or diagnose-only) terminates here with NO edits.
  const refusal = refusalResult(diagnosis, allowTestEdits);
  if (refusal !== undefined) return terminalNoEdit(refusal, diagnosis);
  if (opts.diagnoseOnly === true) return terminalNoEdit("NEEDS_HUMAN", diagnosis);

  // ── STAGE 5: GROUND_TRUTH ──────────────────────────────────────────────────
  // For the thin slice the ground-truth set is the single failing check.

  // ── STAGE 6: PLAN ──────────────────────────────────────────────────────────
  const planFiles = [...diagnosis.affectedFiles].slice(0, maxFiles);
  const plan = {
    files: planFiles,
    change: `Repair ${diagnosis.category} by editing ${planFiles.join(", ") || "(no file identified)"}`,
    why: diagnosis.evidence,
  };
  builder.recordPlan(plan);
  if (planFiles.length === 0) return terminalNoEdit("NEEDS_HUMAN", diagnosis);
  if (diagnosis.affectedFiles.length > maxFiles) return terminalNoEdit("NEEDS_HUMAN", diagnosis);

  // ── STAGE 7: APPLY ─────────────────────────────────────────────────────────
  // Snapshot the planned files' BEFORE content, generate a minimal diff, validate every path
  // (confinement + scope + test/config posture), apply, and record before/after for anti-cheat.
  const before = new Map<string, string | null>();
  const fileBlocks: Array<{ path: string; body: string }> = [];
  for (const f of planFiles) {
    const content = readFile(opts.repo, f);
    before.set(f, content);
    if (content !== null) fileBlocks.push({ path: f, body: content.slice(0, MAX_FILE_BYTES) });
  }

  const patchResult = await generateFixPatch({ diagnosis, files: fileBlocks, rawOutput: reproduce.output }, { invokeModel, neutralize, modelId, identity });
  if (!patchResult.ok) {
    builder.recordPatch("", []);
    builder.recordTargetedCheck(false, `(no patch applied: ${patchResult.reason})`);
    // SAFE_FAIL: we tried, could not produce a usable patch, but changed nothing (no cheat).
    const verdict = antiCheatCheck({ changes: [], allowedFiles: planFiles, allowTestEdits });
    builder.recordAntiCheat(verdict.passed, verdict.checks);
    return { result: "SAFE_FAIL", receipt: builder.finalize("SAFE_FAIL"), promoted: false, filesModified: [], diagnosis };
  }

  const worktreeReal = (() => {
    try {
      return realpathSync(opts.repo);
    } catch {
      return opts.repo;
    }
  })();
  const parsed = parseUnifiedDiff(patchResult.diff);
  if (!parsed.ok) {
    builder.recordPatch(patchResult.diff, []);
    builder.recordTargetedCheck(false, `(patch did not parse: ${parsed.error})`);
    const verdict = antiCheatCheck({ changes: [], allowedFiles: planFiles, allowTestEdits });
    builder.recordAntiCheat(verdict.passed, verdict.checks);
    return { result: "SAFE_FAIL", receipt: builder.finalize("SAFE_FAIL"), promoted: false, filesModified: [], diagnosis };
  }

  // VALIDATE every touched path BEFORE writing a byte (reject the patch WHOLE on any violation).
  const planSet = new Set(planFiles.map((p) => p.replace(/\\/g, "/")));
  const changes: FileChange[] = [];
  const filesModified: string[] = [];
  let violation: string | undefined;
  const writes: Array<{ rel: string; content: string }> = [];
  for (const fp of parsed.files) {
    const c = confinePath(worktreeReal, fp.path);
    if (!c.ok) {
      violation = c.error;
      break;
    }
    const rel = c.rel.replace(/\\/g, "/");
    if (!planSet.has(rel)) {
      violation = `patch touches a file outside the diagnosed scope: ${rel}`;
      break;
    }
    if (!allowTestEdits && isTestFile(rel)) {
      violation = `patch edits a test file without --allow-test-edits: ${rel}`;
      break;
    }
    if (!allowConfigEdits && CONFIG_FILE_RE.test(rel)) {
      violation = `patch edits a config file without --allow-config-edits: ${rel}`;
      break;
    }
    const original = before.has(rel) ? before.get(rel) ?? "" : readFile(opts.repo, rel) ?? "";
    const applied = applyFilePatch(original, fp);
    if (!applied.ok) {
      violation = applied.error;
      break;
    }
    writes.push({ rel, content: applied.content });
  }

  if (violation !== undefined) {
    builder.recordPatch(patchResult.diff, []);
    builder.recordTargetedCheck(false, `(patch rejected: ${violation})`);
    // A rejected patch wrote NOTHING — anti-cheat over zero changes; SAFE_FAIL (we refused to apply).
    const verdict = antiCheatCheck({ changes: [], allowedFiles: planFiles, allowTestEdits });
    builder.recordAntiCheat(verdict.passed, verdict.checks);
    return { result: "SAFE_FAIL", receipt: builder.finalize("SAFE_FAIL"), promoted: false, filesModified: [], diagnosis };
  }

  for (const w of writes) {
    writeFile(opts.repo, w.rel, w.content);
    filesModified.push(w.rel);
    changes.push({ path: w.rel, before: before.get(w.rel) ?? null, after: w.content });
  }
  builder.recordPatch(patchResult.diff, filesModified);

  // ── STAGE 8: TARGETED_CHECK ────────────────────────────────────────────────
  const targeted = await deps.runCheck(opts.repo, check);
  const targetedOutcomes = parseOutcomes(check, targeted);
  builder.recordTargetedCheck(targetedOutcomes.passed, targeted.output);

  // ── STAGE 9: FULL_CHECK ────────────────────────────────────────────────────
  // The slice's ground-truth set is the single check — reuse the targeted run, 0 other checks.
  builder.recordFullCheck(targetedOutcomes.passed, 0);

  // ── STAGE 10: ANTI_CHEAT ───────────────────────────────────────────────────
  const verdict = antiCheatCheck({ changes, allowedFiles: planFiles, allowTestEdits });
  builder.recordAntiCheat(verdict.passed, verdict.checks);

  // ── STAGE 11: RESULT ───────────────────────────────────────────────────────
  let result: FixResult;
  if (!verdict.passed) result = "UNSAFE_FAIL";
  else if (targetedOutcomes.passed) result = "FIXED_NARROWLY";
  else result = "SAFE_FAIL";

  // ── STAGE 12: RECEIPT ──────────────────────────────────────────────────────
  return { result, receipt: builder.finalize(result), promoted: false, filesModified, diagnosis };
}

/** Patch-generation deps (a subset of FixDeps, already defaulted). */
interface PatchDeps {
  readonly invokeModel: (request: ModelRequest) => Promise<ModelResponse>;
  readonly neutralize: (content: string, context: UntrustedContext) => NeutralizedContent;
  readonly modelId: string;
  readonly identity: AgentIdentity;
}

/** Ask the model for a minimal unified diff that repairs the diagnosed problem. */
export async function generateFixPatch(
  args: { diagnosis: Diagnosis; files: ReadonlyArray<{ path: string; body: string }>; rawOutput: string },
  deps: PatchDeps,
): Promise<{ ok: true; diff: string } | { ok: false; reason: string }> {
  const fileBlocks = args.files.length > 0 ? args.files.map((f) => `--- ${f.path} ---\n${f.body}`).join("\n\n") : "(no source files were located)";
  const contextBody = [
    `DIAGNOSIS: ${args.diagnosis.category} (confidence ${args.diagnosis.confidence.toFixed(2)})`,
    `EVIDENCE: ${args.diagnosis.evidence}`,
    `REPAIR THESE FILE(S): ${args.diagnosis.affectedFiles.join(", ")}`,
    "",
    "FAILING CHECK OUTPUT:",
    args.rawOutput.length > 0 ? args.rawOutput : "(none)",
    "",
    "FILES:",
    fileBlocks,
  ].join("\n");

  const untrusted: ModelMessage = toUntrustedMessage(deps.neutralize(contextBody, { source: "external", identity: deps.identity, origin: "fix_patch" }), { role: "user" });
  const messages: ModelMessage[] = [{ role: "system", content: FIX_PATCH_SYSTEM }, untrusted];

  let raw: string;
  try {
    const response = await deps.invokeModel({ model: deps.modelId, temperature: PATCH_TEMPERATURE, maxTokens: PATCH_MAX_TOKENS, identity: deps.identity, messages, metadata: { fixStage: "patch" } });
    raw = response.content;
  } catch (e) {
    return { ok: false, reason: `patch model call failed: ${errMsg(e)}` };
  }

  const extracted = extractDiff(raw);
  if (extracted.kind === "diff") return { ok: true, diff: extracted.text };
  if (extracted.kind === "need_context") return { ok: false, reason: `model requested more context: ${extracted.files.join(", ")}` };
  return { ok: false, reason: extracted.reason };
}
