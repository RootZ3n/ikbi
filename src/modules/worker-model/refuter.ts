/**
 * ikbi worker-model — REFUTER role: the adversarial gate.
 *
 * The critic asks "is this good?". The refuter asks the opposite — "what is BROKEN
 * here, and can I prove the build is lying?". Its job is to REFUTE, not approve: it
 * runs a fixed REFUTATION CHECKLIST of evidence-based checks against the builder's
 * claims, the workspace diff, the verifier's verdict, and the receipt trail. A single
 * CRITICAL finding refutes the build.
 *
 * It runs AFTER the critic (an OPTIONAL gate — OFF by default; the orchestrator only
 * dispatches it when explicitly enabled). READ-ONLY: it inspects, it never writes.
 *
 * The nine checks (each maps onto a correction-library category, so a refuted check can
 * be filed as a PROPOSED correction — see proposalFromFinding):
 *   1. tests_actually_run      — did the claimed tests really execute? (verifier evidence)
 *   2. source_matches_claims   — do the files the builder claims it wrote actually exist?
 *   3. tests_not_weakened      — were assertions deleted from test files?
 *   4. no_forbidden_files      — were protected paths modified?
 *   5. verification_real       — was the test script swapped for a stub/fake runner?
 *   6. manifest_change_expected— did package.json change in an expected (stub→real) way?
 *   7. result_matches_spec     — does the change actually satisfy the goal?
 *   8. no_silent_conflicts     — were merge-conflict markers committed / silently resolved?
 *   9. receipts_present        — did the build produce a receipt trail?
 *
 * UNTRUSTED INPUT (C4): the goal + builder claims + diff are untrusted DATA. The optional
 * semantic spec-match (#7) routes through `ctx.engine.neutralizeUntrusted` exactly like
 * the critic; the deterministic checks never feed untrusted text back into a model.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { toUntrustedMessage } from "../../core/injection/index.js";
import type { ModelRequest } from "../../core/provider/contract.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { CorrectionCategory, CorrectionEntry, CorrectionProposeInput } from "../correction-library/contract.js";
import type { RoleFn, RoleResult } from "./contract.js";
import { isExpectedManifestChange } from "./verifier.js";
import { refuterModel } from "./role-models.js";
import { type CorrectionAccess, NOOP_CORRECTIONS } from "./correction-application.js";

// ── Public shapes ──────────────────────────────────────────────────────────

export type RefuterSeverity = "critical" | "warning" | "info";

export interface RefuterFinding {
  /** Stable check id (one of the nine checklist names). */
  readonly check: string;
  /** Did the build SURVIVE this check? (true = nothing wrong found.) */
  readonly passed: boolean;
  /** Concrete evidence for the verdict. */
  readonly evidence: string;
  readonly severity: RefuterSeverity;
}

export interface RefutationResult {
  /** True when at least one CRITICAL check failed — the build is refuted. */
  readonly refuted: boolean;
  readonly findings: readonly RefuterFinding[];
  readonly feedback: string;
}

/** Everything the deterministic refutation needs, supplied explicitly (pure + testable). */
export interface RefutationInput {
  readonly goal: string;
  readonly diffText: string;
  /** Files the builder claims it wrote. */
  readonly filesClaimed: readonly string[];
  /** Does a claimed (workspace-relative) file actually exist on disk? */
  readonly fileExists: (relPath: string) => boolean;
  /** The verifier's verdict ("pass" | "fail" | "untrusted" | "skipped"). */
  readonly verifierVerdict?: string | undefined;
  /** The verifier's test-evidence classification ("executed" | "zero" | "unverified" | "absent"). */
  readonly verifierTestEvidence?: string | undefined;
  /** Protected paths the build must not modify. */
  readonly protectedPaths?: readonly string[] | undefined;
  /** Whether a receipt trail exists for this run. */
  readonly receiptsPresent?: boolean | undefined;
  /** Optional pre-computed semantic spec-match verdict (#7). */
  readonly specMatch?: { readonly matched: boolean; readonly evidence: string } | undefined;
}

// ── Diff parsing ────────────────────────────────────────────────────────────

interface FileDiff {
  readonly file: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/** Parse a unified diff into per-file added/removed content lines (excluding +++/--- headers). */
export function parseDiffFiles(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: { file: string; added: string[]; removed: string[] } | undefined;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      if (current) files.push(current);
      current = { file: header[2] ?? header[1] ?? "", added: [], removed: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) current.added.push(line.slice(1));
    else if (line.startsWith("-")) current.removed.push(line.slice(1));
  }
  if (current) files.push(current);
  return files;
}

const TEST_FILE_RE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?)\//i;
const ASSERTION_RE = /\b(assert|expect|should|to(Be|Equal|Throw|Match|Contain)|assertEquals|t\.(is|deepEqual|throws))\b|assert\./;
const MERGE_MARKER_RE = /^(<{7}|={7}|>{7})( |$)/;

const STUB_TEST_PATTERNS: readonly RegExp[] = [
  /no\s+test/i,
  /not\s+implemented/i,
  /^echo\b/i,
  /^exit\s+1\b/,
  /^true$/,
  /^:\s*$/,
];

function isStubScript(value: string): boolean {
  return STUB_TEST_PATTERNS.some((p) => p.test(value.trim()));
}

/** Extract the old/new value of a `"<key>": "..."` script line from a package.json file diff. */
function extractScript(fileDiff: FileDiff | undefined, key: string): { old?: string; next?: string } {
  if (!fileDiff) return {};
  const re = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`);
  const findIn = (lines: readonly string[]): string | undefined => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m[1];
    }
    return undefined;
  };
  const result: { old?: string; next?: string } = {};
  const old = findIn(fileDiff.removed);
  const next = findIn(fileDiff.added);
  if (old !== undefined) result.old = old;
  if (next !== undefined) result.next = next;
  return result;
}

// ── The pure refutation ─────────────────────────────────────────────────────

/** Run the nine-check refutation checklist over explicit inputs (deterministic, pure). */
export function runRefutation(input: RefutationInput): RefutationResult {
  const findings: RefuterFinding[] = [];
  const fileDiffs = parseDiffFiles(input.diffText);
  const changedFiles = fileDiffs.map((f) => f.file);

  // 1. tests_actually_run — a green verdict with no real test signal is suspect.
  {
    const verdict = input.verifierVerdict;
    const evidence = input.verifierTestEvidence;
    if (verdict === "pass" && evidence !== undefined && evidence !== "executed") {
      findings.push({
        check: "tests_actually_run",
        passed: false,
        evidence: `verifier reported verdict=pass but test evidence is "${evidence}" (no tests actually executed)`,
        severity: "critical",
      });
    } else {
      findings.push({
        check: "tests_actually_run",
        passed: true,
        evidence: verdict === undefined ? "no verifier verdict to contradict" : `verifier verdict=${verdict}, test evidence=${evidence ?? "n/a"}`,
        severity: "info",
      });
    }
  }

  // 2. source_matches_claims — every claimed file must exist on disk.
  {
    const missing = input.filesClaimed.filter((f) => !input.fileExists(f));
    findings.push(
      missing.length > 0
        ? {
            check: "source_matches_claims",
            passed: false,
            evidence: `builder claimed files that do not exist: ${missing.join(", ")}`,
            severity: "critical",
          }
        : {
            check: "source_matches_claims",
            passed: true,
            evidence: `all ${input.filesClaimed.length} claimed file(s) exist`,
            severity: "info",
          },
    );
  }

  // 3. tests_not_weakened — assertions removed from a test file without replacement.
  {
    const weakened: string[] = [];
    for (const fd of fileDiffs) {
      if (!TEST_FILE_RE.test(fd.file)) continue;
      const removedAsserts = fd.removed.filter((l) => ASSERTION_RE.test(l)).length;
      const addedAsserts = fd.added.filter((l) => ASSERTION_RE.test(l)).length;
      if (removedAsserts > addedAsserts) {
        weakened.push(`${fd.file} (-${removedAsserts}/+${addedAsserts} assertions)`);
      }
    }
    findings.push(
      weakened.length > 0
        ? {
            check: "tests_not_weakened",
            passed: false,
            evidence: `test assertions were removed without replacement: ${weakened.join("; ")}`,
            severity: "critical",
          }
        : {
            check: "tests_not_weakened",
            passed: true,
            evidence: "no net assertion deletions in test files",
            severity: "info",
          },
    );
  }

  // 4. no_forbidden_files — protected paths must not be modified.
  {
    const protectedPaths = input.protectedPaths ?? [];
    const violated = changedFiles.filter((f) => protectedPaths.some((p) => f === p || f.startsWith(`${p}/`) || f.endsWith(p)));
    findings.push(
      violated.length > 0
        ? {
            check: "no_forbidden_files",
            passed: false,
            evidence: `protected path(s) modified: ${violated.join(", ")}`,
            severity: "critical",
          }
        : {
            check: "no_forbidden_files",
            passed: true,
            evidence: protectedPaths.length === 0 ? "no protected paths configured" : "no protected paths modified",
            severity: "info",
          },
    );
  }

  // 5 + 6. package.json script integrity.
  {
    const pkgDiff = fileDiffs.find((f) => f.file === "package.json" || f.file.endsWith("/package.json"));
    const { old: oldTest, next: newTest } = extractScript(pkgDiff, "test");

    // 5. verification_real — the test script must not be swapped for a stub/fake runner.
    if (newTest !== undefined && isStubScript(newTest)) {
      findings.push({
        check: "verification_real",
        passed: false,
        evidence: `test script replaced with a stub/fake runner: "${newTest}"`,
        severity: "critical",
      });
    } else {
      findings.push({
        check: "verification_real",
        passed: true,
        evidence: newTest === undefined ? "test script unchanged" : `test script is a real runner: "${newTest}"`,
        severity: "info",
      });
    }

    // 6. manifest_change_expected — a changed test script should be a stub→real upgrade.
    if (oldTest !== undefined && newTest !== undefined && oldTest !== newTest) {
      const expected = isExpectedManifestChange(oldTest, newTest);
      findings.push(
        expected || !isStubScript(newTest)
          ? {
              check: "manifest_change_expected",
              passed: true,
              evidence: expected
                ? `expected manifest change (stub→real): "${oldTest}" → "${newTest}"`
                : `test script changed to a real runner: "${oldTest}" → "${newTest}"`,
              severity: "info",
            }
          : {
              check: "manifest_change_expected",
              passed: false,
              evidence: `unexpected manifest change (real→stub): "${oldTest}" → "${newTest}"`,
              severity: "warning",
            },
      );
    } else {
      findings.push({
        check: "manifest_change_expected",
        passed: true,
        evidence: "package.json test script unchanged",
        severity: "info",
      });
    }
  }

  // 7. result_matches_spec — semantic alignment with the goal.
  {
    if (input.specMatch !== undefined) {
      findings.push({
        check: "result_matches_spec",
        passed: input.specMatch.matched,
        evidence: input.specMatch.evidence,
        severity: input.specMatch.matched ? "info" : "critical",
      });
    } else if (input.diffText.trim().length === 0 && input.goal.trim().length > 0) {
      findings.push({
        check: "result_matches_spec",
        passed: false,
        evidence: "no changes were produced for a non-empty goal",
        severity: "warning",
      });
    } else {
      findings.push({
        check: "result_matches_spec",
        passed: true,
        evidence: "spec match not semantically evaluated (no model verdict supplied)",
        severity: "info",
      });
    }
  }

  // 8. no_silent_conflicts — merge-conflict markers must never be committed.
  {
    const markers = fileDiffs.filter((fd) => fd.added.some((l) => MERGE_MARKER_RE.test(l))).map((fd) => fd.file);
    findings.push(
      markers.length > 0
        ? {
            check: "no_silent_conflicts",
            passed: false,
            evidence: `merge-conflict markers committed in: ${markers.join(", ")}`,
            severity: "critical",
          }
        : {
            check: "no_silent_conflicts",
            passed: true,
            evidence: "no merge-conflict markers in the diff",
            severity: "info",
          },
    );
  }

  // 9. receipts_present — the build should produce a receipt trail.
  {
    if (input.receiptsPresent === false) {
      findings.push({
        check: "receipts_present",
        passed: false,
        evidence: "no receipt trail was produced for this run",
        severity: "warning",
      });
    } else {
      findings.push({
        check: "receipts_present",
        passed: true,
        evidence: input.receiptsPresent === true ? "receipt trail present" : "receipt presence not checked",
        severity: "info",
      });
    }
  }

  const refuted = findings.some((f) => !f.passed && f.severity === "critical");
  const failed = findings.filter((f) => !f.passed);
  const feedback = refuted
    ? `REFUTED — ${failed.filter((f) => f.severity === "critical").length} critical finding(s): ${failed
        .filter((f) => f.severity === "critical")
        .map((f) => f.check)
        .join(", ")}`
    : failed.length > 0
      ? `not refuted, but ${failed.length} non-critical concern(s): ${failed.map((f) => f.check).join(", ")}`
      : "not refuted — the build survived every refutation check";

  return { refuted, findings, feedback };
}

// ── Finding → correction proposal ────────────────────────────────────────────

const CHECK_TO_CATEGORY: Readonly<Record<string, CorrectionCategory>> = {
  tests_actually_run: "verification_forgery",
  source_matches_claims: "suspicious_pattern",
  tests_not_weakened: "test_weakening",
  no_forbidden_files: "forbidden_file",
  verification_real: "verification_forgery",
  manifest_change_expected: "expected_manifest_change",
  result_matches_spec: "suspicious_pattern",
  no_silent_conflicts: "conflict_resolution",
  receipts_present: "environment_missing",
};

const CHECK_TO_REMEDIATION: Readonly<Record<string, { correction: string; regression: string }>> = {
  tests_actually_run: {
    correction: "require real test execution evidence before accepting a green verdict",
    regression: "assert the verifier reports testEvidence==='executed' on a passing run",
  },
  source_matches_claims: {
    correction: "validate that every file the builder claims to have written exists on disk",
    regression: "assert each claimed file path resolves to an existing file in the workspace",
  },
  tests_not_weakened: {
    correction: "reject diffs that delete test assertions without adding equivalent coverage",
    regression: "assert removed-assertion count never exceeds added-assertion count in test files",
  },
  no_forbidden_files: {
    correction: "block modifications to protected paths",
    regression: "assert no changed file matches a configured protected path",
  },
  verification_real: {
    correction: "reject builds that replace the test script with a stub/fake runner",
    regression: "assert the package.json test script matches a known real test runner",
  },
  manifest_change_expected: {
    correction: "only allow stub→real manifest upgrades, never real→stub downgrades",
    regression: "assert isExpectedManifestChange holds for any changed guarded script",
  },
  result_matches_spec: {
    correction: "require the change to demonstrably satisfy the stated goal",
    regression: "assert a non-empty diff (or an explicit no-change justification) for a non-empty goal",
  },
  no_silent_conflicts: {
    correction: "reject diffs containing committed merge-conflict markers",
    regression: "assert no added line begins with a conflict marker (<<<<<<<, =======, >>>>>>>)",
  },
  receipts_present: {
    correction: "ensure every run produces a receipt trail",
    regression: "assert a receipt exists for the run id after completion",
  },
};

/**
 * Turn a refuter FINDING into a PROPOSED correction (approved=false). Used by the
 * orchestrator to file lessons after a refuted build. Only failed checks should be
 * proposed; passing checks carry no lesson.
 */
export function proposalFromFinding(finding: RefuterFinding, sourceRunId?: string): CorrectionProposeInput {
  const category = CHECK_TO_CATEGORY[finding.check] ?? "custom";
  const remediation = CHECK_TO_REMEDIATION[finding.check] ?? {
    correction: "review and correct the refuted behavior",
    regression: "add a regression check for this finding",
  };
  return {
    category,
    finding: `[${finding.check}] ${finding.evidence}`,
    correction: remediation.correction,
    regression: remediation.regression,
    ...(sourceRunId !== undefined ? { sourceRunId } : {}),
    proposedBy: "system",
    approved: false,
  };
}

// ── RoleFn adapter ────────────────────────────────────────────────────────

export interface RefuterDeps {
  /** Workspace diff source. Production wires WorkspaceManager.diff(handle). */
  readonly diff?: (workspace: WorkspaceHandle) => Promise<string>;
  /** Protected paths the build must not modify. */
  readonly protectedPaths?: readonly string[];
  /** Whether a receipt trail exists for the run (async-friendly). */
  readonly receiptsPresent?: (taskId: string) => boolean | Promise<boolean>;
  /** Enable the model-driven semantic spec-match check (#7). Default false. */
  readonly semantic?: boolean;
  /**
   * APPROVED-correction access (Codex HIGH-2). Default: NO-OP (load nothing) so the bare
   * constructor + existing tests are byte-unchanged; PRODUCTION wires `liveCorrectionAccess`.
   * A failed refutation finding whose category matches an approved correction is SUPPRESSED
   * (the operator already accepted that class of finding), so it no longer refutes the build —
   * and the correction's appliedCount is incremented.
   */
  readonly corrections?: CorrectionAccess;
}

/**
 * Codex HIGH-2: apply APPROVED corrections to a raw refutation result. A FAILED finding whose
 * mapped category (CHECK_TO_CATEGORY) has an approved correction is SUPPRESSED — marked passed and
 * downgraded to info — because the operator already accepted that class of finding. The applied
 * correction's appliedCount is recorded. Returns the (possibly) revised findings + recomputed
 * `refuted` verdict; with no matching corrections the result is byte-identical to the input.
 */
function applyCorrectionsToRefutation(
  base: RefutationResult,
  corrections: CorrectionAccess,
): RefutationResult {
  // Index corrections by category AND check-id so a correction only suppresses findings
  // from the SAME check, not every check that maps to the same category (GLM 5.2 HIGH-1).
  const byCatAndCheck = new Map<string, Map<string, CorrectionEntry[]>>();
  for (const c of corrections.listApproved()) {
    // Extract the check-id prefix from the correction's finding text: "[check_id] evidence"
    const checkMatch = /^\[([^\]]+)\]/.exec(c.finding ?? "");
    const corrCheckId = checkMatch?.[1] ?? "unknown";
    let catMap = byCatAndCheck.get(c.category);
    if (!catMap) { catMap = new Map(); byCatAndCheck.set(c.category, catMap); }
    let arr = catMap.get(corrCheckId);
    if (!arr) { arr = []; catMap.set(corrCheckId, arr); }
    arr.push(c);
  }
  if (byCatAndCheck.size === 0) return base;

  const applied = new Set<string>();
  const findings = base.findings.map((f): RefuterFinding => {
    if (f.passed) return f;
    const category = CHECK_TO_CATEGORY[f.check];
    const catMap = category !== undefined ? byCatAndCheck.get(category) : undefined;
    // Match by BOTH category AND check-id (the correction must target the same check)
    const match = catMap?.get(f.check)?.[0];
    if (match === undefined) return f;
    applied.add(match.id);
    return {
      ...f,
      passed: true,
      severity: "info",
      evidence: `${f.evidence} — suppressed by approved correction ${match.id} (${match.category})`,
    };
  });
  if (applied.size === 0) return base;

  for (const id of applied) corrections.recordApplied(id);

  const refuted = findings.some((f) => !f.passed && f.severity === "critical");
  const failed = findings.filter((f) => !f.passed);
  const feedback = refuted
    ? `REFUTED — ${failed.filter((f) => f.severity === "critical").length} critical finding(s): ${failed
        .filter((f) => f.severity === "critical")
        .map((f) => f.check)
        .join(", ")}`
    : failed.length > 0
      ? `not refuted, but ${failed.length} non-critical concern(s): ${failed.map((f) => f.check).join(", ")}`
      : "not refuted — the build survived every refutation check (after applying approved corrections)";
  return { refuted, findings, feedback };
}

const REFUTER_SYSTEM =
  "You are the REFUTER in an automated build pipeline. Your job is to REFUTE, not approve.\n" +
  "Given the GOAL and the workspace DIFF, decide whether the change actually satisfies the goal.\n" +
  "Be adversarial: if the change is incomplete, off-target, or only superficially related, it does NOT match.\n" +
  'Return ONLY valid JSON: {"matched": true|false, "evidence": "one concise sentence"}.';

function pathUnder(root: string, rel: string): string | undefined {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  const back = relative(rootAbs, abs);
  if (back === "" || (!back.startsWith("..") && !isAbsolute(back))) return abs;
  return undefined;
}

function detailOf(result: RoleResult | undefined): Record<string, unknown> {
  const d = result?.detail;
  return typeof d === "object" && d !== null ? (d as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : [];
}

export function createRefuter(deps: RefuterDeps = {}): RoleFn {
  const corrections = deps.corrections ?? NOOP_CORRECTIONS;
  return async (ctx) => {
    try {
      const builder = ctx.priorResults.find((r) => r.role === "builder");
      const verifier = ctx.priorResults.find((r) => r.role === "verifier");
      const builderDetail = detailOf(builder);
      const filesClaimed = asStringArray(builderDetail.filesWritten);

      const diffText = deps.diff !== undefined ? await deps.diff(ctx.workspace) : "";
      const verifierDetail = detailOf(verifier);
      const verifierVerdict = typeof verifierDetail.verdict === "string" ? verifierDetail.verdict : undefined;
      const verifierTestEvidence = typeof verifierDetail.testEvidence === "string" ? verifierDetail.testEvidence : undefined;
      const receiptsPresent = deps.receiptsPresent !== undefined ? await deps.receiptsPresent(ctx.task.taskId) : undefined;

      // Optional model-driven semantic spec-match (#7). Best-effort: a failure to obtain a
      // verdict leaves #7 to the deterministic heuristic — it never crashes the refuter.
      let specMatch: { matched: boolean; evidence: string } | undefined;
      if (deps.semantic === true && diffText.trim().length > 0) {
        try {
          const request: ModelRequest = {
            model: refuterModel(),
            temperature: 0.0,
            maxTokens: 512,
            identity: ctx.identity,
            messages: [
              { role: "system", content: REFUTER_SYSTEM },
              toUntrustedMessage(
                ctx.engine.neutralizeUntrusted(`Goal:\n${ctx.task.goal}`, { source: "external", identity: ctx.identity, origin: "refuter_goal" }),
                { role: "user" },
              ),
              toUntrustedMessage(
                ctx.engine.neutralizeUntrusted(`Workspace diff:\n${diffText.slice(0, 24_000)}`, { source: "external", identity: ctx.identity, origin: "refuter_diff" }),
                { role: "user" },
              ),
            ],
          };
          const response = await ctx.engine.invokeModel(request);
          const m = /\{[\s\S]*\}/.exec(response.content);
          if (m) {
            const parsed = JSON.parse(m[0]) as { matched?: unknown; evidence?: unknown };
            if (typeof parsed.matched === "boolean") {
              specMatch = {
                matched: parsed.matched,
                evidence: typeof parsed.evidence === "string" && parsed.evidence.trim().length > 0 ? parsed.evidence.trim() : "model spec-match verdict",
              };
            }
          }
        } catch {
          // best-effort — fall through to the deterministic heuristic for #7
        }
      }

      const rawResult = runRefutation({
        goal: ctx.task.goal,
        diffText,
        filesClaimed,
        fileExists: (rel) => {
          const abs = pathUnder(ctx.workspace.path, rel);
          return abs !== undefined && existsSync(abs);
        },
        verifierVerdict,
        verifierTestEvidence,
        ...(deps.protectedPaths !== undefined ? { protectedPaths: deps.protectedPaths } : {}),
        ...(receiptsPresent !== undefined ? { receiptsPresent } : {}),
        ...(specMatch !== undefined ? { specMatch } : {}),
      });
      // Codex HIGH-2: suppress findings already addressed by an operator-APPROVED correction
      // (and record each application). With no approved corrections this is a no-op.
      const result = applyCorrectionsToRefutation(rawResult, corrections);

      return {
        role: "refuter",
        outcome: "success", // the refuter DID ITS JOB; the verdict is in detail.refuted
        summary: result.refuted ? "refutation verdict: REFUTED" : "refutation verdict: SURVIVED",
        detail: { refuted: result.refuted, findings: result.findings, feedback: result.feedback },
      };
    } catch (err) {
      return {
        role: "refuter",
        outcome: "failure",
        summary: `refuter failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };
}

export const refuter: RoleFn = createRefuter();
