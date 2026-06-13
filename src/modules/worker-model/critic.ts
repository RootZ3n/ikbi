/**
 * ikbi worker-model — CRITIC role: first-class build gate.
 *
 * Judge whether the builder's work satisfies the task goal, producing a pass/fail
 * verdict + feedback. READ-ONLY — critic inspects the goal, builder result, and
 * workspace diff; it never writes to the workspace.
 *
 * UNTRUSTED INPUT (C4): the goal (user-supplied) and the builder summary/detail
 * (model-derived — a poisoned upstream role could embed instructions) are untrusted
 * DATA. Each enters via `ctx.engine.neutralizeUntrusted` + `toUntrustedMessage`
 * (untrusted:true), never raw-concatenated into the trusted SYSTEM verdict prompt.
 *
 * Every model call carries `identity: ctx.identity` (#10).
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { toUntrustedMessage } from "../../core/injection/index.js";
import type { ModelMessage, ModelRequest } from "../../core/provider/contract.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { RoleFn, RoleResult } from "./contract.js";
import { criticModel } from "./role-models.js";

// The model id is CRITIC-tier and config-driven (see role-models.ts) — resolved at
// request time so an operator's IKBI_MODEL_CRITIC takes effect without a roster alias.
const CRITIC_TEMPERATURE = 0.0; // deterministic judgment
const CRITIC_MAX_TOKENS = 2048;
const MAX_DIFF_CHARS = 36_000;
const MAX_DIFF_FILES = 80;
const MAX_LINES_PER_FILE = 80;

const CRITIC_SYSTEM =
  "You are the CRITIC in an automated build pipeline. You are a strict gate, not a rubber stamp.\n" +
  "Review the actual workspace diff against the stated goal and the builder's claims.\n\n" +
  "The VERIFIER (objective checks: typecheck + tests) has ALREADY RUN — its results are provided.\n" +
  "Do not re-litigate what the verifier already proved. Spend your judgment on what objective\n" +
  "checks CANNOT catch: does the change actually satisfy the GOAL, is it semantically correct,\n" +
  "and is it free of silent regressions, stubs that fake success, or unrelated/suspicious edits?\n" +
  "Green checks are NECESSARY, not sufficient — passing tests on the wrong change still FAILs.\n\n" +
  "Evaluate these dimensions:\n" +
  "1. files_modified: Did the diff actually modify the files the builder claims it wrote?\n" +
  "2. goal_correctness: Do the changes satisfy the stated goal?\n" +
  "3. code_quality: Are there obvious bugs, missing imports, syntax errors, or broken contracts?\n" +
  "4. tests: Were tests updated or added when the change needs them?\n" +
  "5. suspicious_patterns: Does the diff contain hardcoded values, TODO comments, debug code, dead code, or unrelated edits?\n\n" +
  "Return ONLY valid JSON with this shape:\n" +
  '{"verdict":"PASS|FAIL","scores":{"files_modified":0-5,"goal_correctness":0-5,"code_quality":0-5,"tests":0-5,"suspicious_patterns":0-5},"feedback":"concise actionable feedback","issues":["..."]}\n' +
  "PASS only when every material concern is resolved. If uncertain, FAIL.";

export interface CriticDeps {
  /** Workspace diff source. Production wires WorkspaceManager.diff(handle). Missing means fail-closed. */
  readonly diff?: (workspace: WorkspaceHandle) => Promise<string>;
}

interface DiffStats {
  readonly files: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
  readonly text: string;
}

interface ParsedVerdict {
  readonly pass: boolean;
  readonly feedback: string;
  readonly scores?: unknown;
  readonly issues?: readonly string[];
  readonly parseFormat: "json" | "key_value";
}

function detailOf(result: RoleResult | undefined): Record<string, unknown> {
  const d = result?.detail;
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

function pathUnder(root: string, rel: string): string | undefined {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  const back = relative(rootAbs, abs);
  if (back === "" || (!back.startsWith("..") && !isAbsolute(back))) return abs;
  return undefined;
}

function parseDiffStats(diff: string): Omit<DiffStats, "truncated" | "text"> {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    const g = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (g) {
      if (g[1] !== undefined && g[1] !== "/dev/null") files.add(g[1]);
      if (g[2] !== undefined && g[2] !== "/dev/null") files.add(g[2]);
      continue;
    }
    const plus = /^\+\+\+ b\/(.+)$/.exec(line);
    if (plus?.[1] !== undefined && plus[1] !== "/dev/null") files.add(plus[1]);
    const minus = /^--- a\/(.+)$/.exec(line);
    if (minus?.[1] !== undefined && minus[1] !== "/dev/null") files.add(minus[1]);
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { files: [...files].sort(), additions, deletions };
}

function summarizeLargeDiff(diff: string, base: Omit<DiffStats, "truncated" | "text">): DiffStats {
  if (diff.length <= MAX_DIFF_CHARS) return { ...base, truncated: false, text: diff };

  const out: string[] = [
    `DIFF TRUNCATED FOR REVIEW CONTEXT (${diff.length} chars).`,
    `Files changed (${base.files.length}): ${base.files.slice(0, MAX_DIFF_FILES).join(", ")}${base.files.length > MAX_DIFF_FILES ? ", ..." : ""}`,
    `Stats: +${base.additions} -${base.deletions}`,
    "",
  ];

  let currentFile = "";
  let linesForFile = 0;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      currentFile = header[2] ?? header[1] ?? "";
      linesForFile = 0;
      out.push(line);
      continue;
    }
    if (currentFile.length === 0) continue;
    if (line.startsWith("@@") || line.startsWith("+++") || line.startsWith("---")) {
      out.push(line);
      continue;
    }
    if ((line.startsWith("+") || line.startsWith("-")) && linesForFile < MAX_LINES_PER_FILE) {
      out.push(line);
      linesForFile += 1;
    }
    if (out.join("\n").length >= MAX_DIFF_CHARS) break;
  }
  return { ...base, truncated: true, text: out.join("\n") };
}

function extractJsonObject(content: string): string | undefined {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const source = fenced?.[1]?.trim() ?? trimmed;
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start === -1 || end < start) return undefined;
  return source.slice(start, end + 1);
}

/**
 * Default minimum goal_correctness score (0-5) the critic must report for a PASS to stand. The
 * rubric DEMANDS this score but it was previously collected and never checked — a model that
 * scored goal_correctness=0 yet said PASS still passed. Enforced below; operator-overridable.
 */
const DEFAULT_GOAL_CORRECTNESS_THRESHOLD = 3;

/** Read a single numeric score (0-5) from the (loose) scores object, else undefined. */
function numericScore(scores: unknown, key: string): number | undefined {
  if (typeof scores !== "object" || scores === null) return undefined;
  const v = (scores as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseStructuredVerdict(
  content: string,
  goalCorrectnessThreshold: number = DEFAULT_GOAL_CORRECTNESS_THRESHOLD,
): ParsedVerdict {
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new Error("empty critic response");

  const json = extractJsonObject(trimmed);
  if (json !== undefined) {
    const raw = JSON.parse(json) as unknown;
    if (typeof raw !== "object" || raw === null) throw new Error("critic JSON was not an object");
    const obj = raw as Record<string, unknown>;
    const verdict = typeof obj.verdict === "string" ? obj.verdict.trim().toUpperCase() : "";
    if (verdict !== "PASS" && verdict !== "FAIL") throw new Error("critic JSON missing verdict PASS/FAIL");
    const feedback = typeof obj.feedback === "string" && obj.feedback.trim().length > 0 ? obj.feedback.trim() : verdict;
    const issues = asStringArray(obj.issues);
    // RUBRIC ENFORCEMENT: the scores are no longer decorative. If the model says PASS but scores
    // goal_correctness below the threshold, the change does not satisfy the goal — override to FAIL.
    // FAIL is sticky (a FAIL verdict never becomes PASS); a missing score leaves the verdict as-is.
    let pass = verdict === "PASS";
    let effectiveFeedback = feedback;
    const goalScore = numericScore(obj.scores, "goal_correctness");
    if (pass && goalScore !== undefined && goalScore < goalCorrectnessThreshold) {
      pass = false;
      effectiveFeedback = `[rubric override] goal_correctness=${goalScore} is below the passing threshold (${goalCorrectnessThreshold}): the change does not adequately satisfy the goal, so the PASS is overridden to FAIL. ${feedback}`;
    }
    return {
      pass,
      feedback: effectiveFeedback,
      ...(obj.scores !== undefined ? { scores: obj.scores } : {}),
      ...(issues.length > 0 ? { issues } : {}),
      parseFormat: "json",
    };
  }

  const verdicts: string[] = [];
  let feedback = "";
  for (const line of trimmed.split("\n")) {
    const m = /^\s*(?:verdict|overall|pass)\s*:\s*(PASS|FAIL|true|false)\s*$/i.exec(line);
    if (m?.[1] !== undefined) verdicts.push(m[1].toUpperCase() === "TRUE" ? "PASS" : m[1].toUpperCase() === "FALSE" ? "FAIL" : m[1].toUpperCase());
    const f = /^\s*feedback\s*:\s*(.*)$/i.exec(line);
    if (f?.[1] !== undefined) feedback = f[1].trim();
  }
  const unique = [...new Set(verdicts)];
  if (unique.length !== 1) throw new Error(unique.length === 0 ? "critic response had no structured verdict" : "critic response had conflicting verdicts");
  return { pass: unique[0] === "PASS", feedback: feedback || trimmed, parseFormat: "key_value" };
}

/**
 * Distill the VERIFIER's result into a compact, model-readable context block (Issue 2).
 * The critic now runs AFTER the verifier, so it can read the objective verdict + per-check
 * pass/fail and focus its judgment on the SEMANTIC concerns checks cannot catch. The check
 * output is governed-exec output (can echo arbitrary repo/test content) → still untrusted DATA.
 * Returns undefined when no verifier result is present (Pass-A / verifier-skipped / direct
 * critic invocation) so the request shape — and every existing critic test — is unchanged.
 */
function formatVerifierContext(verifier: RoleResult | undefined): string | undefined {
  if (verifier === undefined) return undefined;
  const d = detailOf(verifier);
  const verdict = typeof d.verdict === "string" ? d.verdict : verifier.outcome === "success" ? "pass" : "fail";
  const checks = Array.isArray(d.checks)
    ? (d.checks as Array<{ name?: unknown; exitCode?: unknown; outputTail?: unknown }>)
    : [];
  const lines = checks.map((c) => {
    const name = typeof c.name === "string" ? c.name : "check";
    const passed = typeof c.exitCode === "number" ? c.exitCode === 0 : undefined;
    const status = passed === undefined ? "?" : passed ? "PASS" : "FAIL";
    const tail = passed === false && typeof c.outputTail === "string" && c.outputTail.trim().length > 0 ? `\n${c.outputTail}` : "";
    return `- ${name}: ${status}${tail}`;
  });
  return (
    `Verifier results (objective checks — already run):\n` +
    `verdict: ${verdict} (outcome: ${verifier.outcome})\n` +
    (lines.length > 0 ? lines.join("\n") : "(no per-check detail reported)")
  );
}

/**
 * Distill the SCOUT's goal↔file alignment into a compact context block. The scout assesses whether
 * the goal-named files were actually found in the repo (aligned / broad / misaligned); without this
 * the critic cannot factor "the goal references files that do not exist" into its judgment. The
 * summary is derived from the goal + repo structure (untrusted) → still rides as untrusted DATA.
 * Returns undefined when no scout goalAlignment is present so the request shape is unchanged.
 */
function formatGoalAlignment(scout: RoleResult | undefined): string | undefined {
  if (scout === undefined) return undefined;
  const ga = detailOf(scout).goalAlignment;
  if (typeof ga !== "object" || ga === null) return undefined;
  const g = ga as { status?: unknown; summary?: unknown; missingFiles?: unknown };
  const status = typeof g.status === "string" ? g.status : undefined;
  const summary = typeof g.summary === "string" ? g.summary : undefined;
  if (status === undefined && summary === undefined) return undefined;
  const missing = asStringArray(g.missingFiles);
  return (
    `Scout goal alignment (does the goal map to files found in the repo?):\n` +
    `status: ${status ?? "unknown"}\n` +
    (summary ?? "") +
    (missing.length > 0 ? `\nmissing files (named in the goal, not found in the repo): ${missing.join(", ")}` : "")
  );
}

function objectiveFail(feedback: string, extra: Record<string, unknown> = {}): RoleResult {
  return {
    role: "critic",
    outcome: "success",
    summary: "critique verdict: FAIL",
    detail: { pass: false, feedback, objectiveFailure: true, ...extra },
  };
}

export function createCritic(deps: CriticDeps = {}): RoleFn {
  return async (ctx) => {
    const builderResult = ctx.priorResults.find((r) => r.role === "builder");

    // No builder output to judge (e.g. Pass A runs before the builder exists, or the
    // builder was short-circuited). There's nothing to critique — this is REJECTED
    // (the infra is healthy; there's simply no input), NOT a failure.
    if (builderResult === undefined) {
      return {
        role: "critic",
        outcome: "rejected",
        summary: "no builder output to critique",
        detail: { pass: false, feedback: "no builder result present in priorResults" },
      };
    }

    try {
      if (deps.diff === undefined) {
        return objectiveFail("critic fail-closed: no workspace diff source wired");
      }

      const diffText = await deps.diff(ctx.workspace);
      const diffBase = parseDiffStats(diffText);
      const diff = summarizeLargeDiff(diffText, diffBase);
      const builderDetail = detailOf(builderResult);
      const filesWritten = asStringArray(builderDetail.filesWritten);

      if (builderResult.outcome === "success" && diffText.trim().length === 0) {
        return objectiveFail("critic fail-closed: builder reported success but workspace diff is empty", {
          filesWritten,
          diffStats: { filesChanged: 0, additions: 0, deletions: 0 },
        });
      }

      const missingFiles = filesWritten.filter((f) => {
        const abs = pathUnder(ctx.workspace.path, f);
        return abs === undefined || !existsSync(abs);
      });
      if (missingFiles.length > 0) {
        return objectiveFail(`critic fail-closed: builder claimed filesWritten that do not exist: ${missingFiles.join(", ")}`, {
          filesWritten,
          missingFiles,
          diffStats: { filesChanged: diff.files.length, additions: diff.additions, deletions: diff.deletions },
        });
      }

      // C4: goal + builder summary/detail/diff are untrusted DATA — neutralized + wrapped as
      // isolated data-role messages (untrusted:true), never raw in the system prompt.
      const untrusted = (raw: string, origin: string): ModelMessage =>
        toUntrustedMessage(ctx.engine.neutralizeUntrusted(raw, { source: "external", identity: ctx.identity, origin }), { role: "user" });

      // ISSUE 2: the verifier ran first — feed its objective verdict + checks into the critic as
      // context (untrusted DATA, like the diff). Present ONLY when a verifier result exists, so the
      // request shape is byte-identical when there is none (Pass-A / verifier-skipped / direct call).
      const verifierResult = ctx.priorResults.find((r) => r.role === "verifier");
      const verifierContext = formatVerifierContext(verifierResult);

      // The scout computed goal↔file alignment but it was never surfaced to the critic. Feed it in
      // (untrusted DATA, like the diff) so the critic can factor a misaligned/broad goal into its
      // judgment. Present ONLY when a scout goalAlignment exists, so the request shape is unchanged.
      const goalAlignmentContext = formatGoalAlignment(ctx.priorResults.find((r) => r.role === "scout"));

      const objectiveContext = {
        builderOutcome: builderResult.outcome,
        filesWritten,
        diffStats: { filesChanged: diff.files.length, additions: diff.additions, deletions: diff.deletions, truncated: diff.truncated },
        changedFiles: diff.files,
      };

      const request: ModelRequest = {
        model: criticModel(),
        temperature: CRITIC_TEMPERATURE,
        maxTokens: CRITIC_MAX_TOKENS,
        identity: ctx.identity, // the spawned, ceiling-clamped role identity (#10)
        messages: [
          { role: "system", content: CRITIC_SYSTEM },
          untrusted(`Goal (intent):\n${ctx.task.goal}`, "critic_goal"),
          ...(goalAlignmentContext !== undefined ? [untrusted(goalAlignmentContext, "critic_goal_alignment")] : []),
          untrusted(`Objective pre-check context:\n${JSON.stringify(objectiveContext)}`, "critic_objective_context"),
          untrusted(`Builder summary:\n${builderResult.summary ?? "(none)"}`, "critic_builder_summary"),
          untrusted(`Builder detail:\n${JSON.stringify(builderResult.detail ?? {})}`, "critic_builder_detail"),
          ...(verifierContext !== undefined ? [untrusted(verifierContext, "critic_verifier_results")] : []),
          untrusted(`Workspace diff:\n${diff.text}`, "critic_workspace_diff"),
        ],
      };

      const response = await ctx.engine.invokeModel(request);

      if (response.finishReason === "length" || response.finishReason === "content_filter") {
        return objectiveFail(`critic fail-closed: model response ended with finishReason=${response.finishReason}`, {
          finishReason: response.finishReason,
          diffStats: { filesChanged: diff.files.length, additions: diff.additions, deletions: diff.deletions, truncated: diff.truncated },
        });
      }

      let parsed: ParsedVerdict;
      try {
        parsed = parseStructuredVerdict(response.content);
      } catch (err) {
        return objectiveFail(`critic fail-closed: could not parse structured verdict (${err instanceof Error ? err.message : String(err)})`, {
          finishReason: response.finishReason,
          diffStats: { filesChanged: diff.files.length, additions: diff.additions, deletions: diff.deletions, truncated: diff.truncated },
        });
      }

      // IMPORTANT: pass=false is a SUCCESSFUL critique that found problems. The role
      // SUCCEEDED at its job (it produced a verdict), so the OUTCOME is "success"
      // regardless of the verdict. `detail.pass` carries the judgment — outcome
      // reflects whether the critique RAN, not whether the work passed. "failure" is
      // reserved for infrastructure failure (the model call itself failing).
      return {
        role: "critic",
        outcome: "success",
        summary: parsed.pass ? "critique verdict: PASS" : "critique verdict: FAIL",
        detail: {
          pass: parsed.pass,
          feedback: parsed.feedback,
          filesWritten,
          changedFiles: diff.files,
          diffStats: { filesChanged: diff.files.length, additions: diff.additions, deletions: diff.deletions, truncated: diff.truncated },
          parseFormat: parsed.parseFormat,
          ...(parsed.scores !== undefined ? { scores: parsed.scores } : {}),
          ...(parsed.issues !== undefined ? { issues: parsed.issues } : {}),
        },
      };
    } catch (err) {
      return {
        role: "critic",
        outcome: "failure",
        summary: `critic failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

export const critic: RoleFn = createCritic();
