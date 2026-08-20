/**
 * ikbi v2 — THE CANONICAL VERIFICATION AUTHORITY.
 *
 * It answers exactly one question:
 *
 *     "Did THIS candidate — this exact tree — satisfy the deterministic verification
 *      contract, under a plan decided before anything ran?"
 *
 * Not "does the workspace happen to pass now", not "did the builder say it worked", not
 * "can a critic imagine it is fine". The subject is IDENTITY-BOUND: every step names the
 * candidate tree it is about, and a VerificationRecord is content-addressed over that tree,
 * so it is provably applicable to one candidate and no other.
 *
 * DETERMINISTIC ONLY. No model is invoked here — no critic, refuter, judge, fixer or
 * scout. The only thing that happens is: recompute the candidate tree, plan the checks,
 * run them bounded, recompute the tree, and classify. A failed verification ends the run;
 * builder re-entry and recovery are a LATER authority and are deliberately absent.
 *
 * TWO TREE RECHECKS FRAME THE CHECKS, and they are the load-bearing guarantees:
 *
 *   BEFORE — the workspace tree must still equal `candidate.tree.treeId`. If something
 *            moved it (an external process, a stray write, a stale retained workspace),
 *            NO check runs and the verdict is `candidate_drift`. We never "verify what is
 *            there"; we verify what the candidate says it is.
 *   AFTER  — the workspace tree must be UNCHANGED by the checks themselves. A green test
 *            suite that rewrote the thing it was testing has not verified the candidate —
 *            it verified something else. That is `workspace_mutated_by_checks`, whatever
 *            the exit codes said.
 *
 * This file is PURE: contracts, plan/record identity, verdict aggregation, and an
 * orchestration over injected seams (`ChecksSource`, `CheckRunner`, `TreeProbe`). The
 * governed execution, the git tree capture and the filesystem check discovery live in
 * `src/v2/runtime/`.
 */

import { contentDigest, type V2CandidateId, type V2PlanDigest, type V2RunId, type V2SnapshotDigest, type V2VerificationId, type V2WorkspaceId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { CandidateRecord } from "./candidate.js";

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

/**
 * THE thing being verified, bound to its identity.
 *
 * Every field here is something a mismatch would make the verification meaningless — a
 * candidate from another run, a workspace that is not the candidate's, a tree that is not
 * the one the candidate froze. The verifier refuses on any mismatch rather than silently
 * verifying whatever is in front of it.
 */
export interface VerificationSubject {
  readonly runId: V2RunId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly workspaceId: V2WorkspaceId;
  readonly sourceSnapshotId: V2SnapshotDigest;
}

/** Derive the subject from a candidate record — the one honest way to build one. */
export function verificationSubjectOf(candidate: CandidateRecord): VerificationSubject {
  return {
    runId: candidate.runId,
    candidateId: candidate.candidateId,
    candidateTreeId: candidate.tree.treeId,
    workspaceId: candidate.workspaceId,
    sourceSnapshotId: candidate.sourceSnapshotId,
  };
}

/**
 * Refuse a subject that does not describe THIS candidate for THIS run.
 *
 * Returns a failure to refuse, or undefined to proceed. This is the "cannot verify
 * someone else's work" guard, checked before any I/O.
 */
export function validateSubject(subject: VerificationSubject, candidate: CandidateRecord, runId: V2RunId): RunFailure | undefined {
  const problem =
    subject.runId !== runId
      ? `the verification subject belongs to run ${subject.runId}, not ${runId}`
      : candidate.runId !== runId
        ? `the candidate belongs to run ${candidate.runId}, not ${runId}`
        : subject.candidateId !== candidate.candidateId
          ? `the subject names candidate ${subject.candidateId}, not the produced ${candidate.candidateId}`
          : subject.candidateTreeId !== candidate.tree.treeId
            ? `the subject's tree ${subject.candidateTreeId} is not the candidate's tree ${candidate.tree.treeId}`
            : subject.workspaceId !== candidate.workspaceId
              ? `the subject names workspace ${subject.workspaceId}, not the candidate's ${candidate.workspaceId}`
              : subject.sourceSnapshotId !== candidate.sourceSnapshotId
                ? `the subject's source snapshot ${subject.sourceSnapshotId} is not the candidate's ${candidate.sourceSnapshotId}`
                : undefined;
  if (problem === undefined) return undefined;
  return verificationFailure(V2_VERIFICATION_FAILURE_CODES.subjectMismatch, `refusing to verify: ${problem}`, {
    candidateId: subject.candidateId,
  });
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

/** One check as the plan fixes it. The command is a named list — never model-chosen. */
export interface PlannedCheck {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Repository-relative directory, canonicalized. Absent means the workspace root. */
  readonly cwd?: string;
  readonly timeoutMs: number;
}

/**
 * Where checks run. Deliberately a LABEL, not a path: the identity of a plan must not move
 * because a scratch root was relocated. There is exactly one policy today.
 */
export type CwdPolicy = "candidate_workspace_root";

/** How the check set was chosen — operator config, or deterministic discovery. */
export type ChecksSourceKind = "env" | "default";

/**
 * THE immutable plan. Generated in full BEFORE anything executes: checks are never
 * discovered ad hoc halfway through a run, so the plan the record cites is exactly the
 * plan that ran.
 */
export interface VerificationPlan {
  readonly planId: V2PlanDigest;
  readonly checks: readonly PlannedCheck[];
  readonly cwdPolicy: CwdPolicy;
  readonly source: ChecksSourceKind;
}

/**
 * Content address of a plan: the ordered checks, how each is bounded, where they run, and
 * where the set came from. NOT the absolute workspace path and NOT any clock — the same
 * plan in a relocated checkout is the same plan.
 */
export function verificationPlanDigest(input: {
  readonly checks: readonly PlannedCheck[];
  readonly cwdPolicy: CwdPolicy;
  readonly source: ChecksSourceKind;
}): V2PlanDigest {
  return contentDigest("verification_plan", {
    cwdPolicy: input.cwdPolicy,
    source: input.source,
    /*
      `cwd` is part of the identity, not decoration. The same command run in `frontend`
      and in `backend` are two different exams over two different trees, and a digest that
      could not tell them apart would let one stand in for the other. `null` for the root
      keeps the shape stable so an old rootless plan hashes as it always did.
    */
    checks: input.checks.map((c) => ({ name: c.name, command: c.command, args: [...c.args], cwd: c.cwd ?? null, timeoutMs: c.timeoutMs })),
  });
}

/** Build the plan from a resolved check set. Order is preserved from discovery. */
export function buildVerificationPlan(input: {
  readonly checks: readonly { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly cwd?: string }[];
  readonly timeoutMs: number;
  readonly source: ChecksSourceKind;
}): VerificationPlan {
  const checks: PlannedCheck[] = input.checks.map((c) => ({
    name: c.name,
    command: c.command,
    args: [...c.args],
    // Part of the PLAN, therefore part of its identity: the same command in two
    // directories is two different exams, and a digest that could not tell them apart
    // would let one stand in for the other.
    ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
    timeoutMs: input.timeoutMs,
  }));
  const cwdPolicy: CwdPolicy = "candidate_workspace_root";
  return { planId: verificationPlanDigest({ checks, cwdPolicy, source: input.source }), checks, cwdPolicy, source: input.source };
}

// ---------------------------------------------------------------------------
// Seams (implemented in the runtime layer)
// ---------------------------------------------------------------------------

/** What discovering the check set produced. Fail-closed: a reason, never a guessed command. */
export type ResolvedChecks =
  | { readonly ok: true; readonly checks: readonly { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly cwd?: string }[]; readonly source: ChecksSourceKind }
  | { readonly ok: false; readonly reason: string };

/** Deterministic check discovery over a workspace. No model, no repository prose. */
export interface ChecksSource {
  resolve(workspacePath: string): Promise<ResolvedChecks>;
}

/**
 * What running one check produced, as the governed executor reports it. The runtime
 * adapter hashes the output (so the core never handles raw bytes) and states plainly
 * whether the command actually launched.
 */
export interface CheckExecution {
  /** Did the command actually run? False for a denied/dry-run/launch failure. */
  readonly launched: boolean;
  /** Present iff launched. */
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** SHA-256 of the full captured output. Bounded excerpt below; never the whole log. */
  readonly outputSha256: string;
  readonly outputExcerpt: string;
  /** Why the command did not launch, when it did not. */
  readonly refusedReason?: string;
}

/** THE governed check executor. One authorized command in, one bounded result out. */
export interface CheckRunner {
  run(input: {
    readonly name: string;
    readonly command: string;
    readonly args: readonly string[];
    /** The candidate workspace root, absolute. */
    readonly cwd: string;
    /** Repository-relative subdirectory to run in. Absent means the workspace root. */
    readonly relativeCwd?: string;
    readonly timeoutMs: number;
  }): Promise<CheckExecution>;
}

/** Recompute a workspace's git tree id — the same mechanism candidate capture used. */
export interface TreeProbe {
  treeOf(workspacePath: string): Promise<string>;
}

/**
 * The VERIFICATION-DEFINITION fingerprint (V2-016A/B4): the sha256 of each well-known
 * verification-definition artifact at a workspace root (package.json, manifests, test config), or
 * `null` when absent. Captured from the SOURCE snapshot before the builder runs, and re-captured
 * from the candidate; a difference means the candidate redefined its own exam.
 */
export interface VerificationDefinition {
  readonly files: Readonly<Record<string, string | null>>;
  /**
   * V2-019/HIGH-03: sha256 (or `null` when absent) of every repo-local path the SOURCE-resolved
   * check command DIRECTLY references — the script that actually decides pass/fail. `null` is
   * meaningful: a candidate that CREATES a bound path that did not exist in source is a change.
   */
  readonly referencedPaths?: Readonly<Record<string, string | null>>;
  /**
   * Command lines whose definition dependencies could not be safely determined. Non-empty means
   * the bound scope is INCOMPLETE — the exam is not provably source-bound and the caller fails
   * closed rather than granting a PASS it cannot justify.
   */
  readonly unresolvedDefinitions?: readonly string[];
}

/** Captures the verification-definition fingerprint of a workspace. Injected (reads the filesystem). */
export interface VerificationDefinitionProbe {
  /**
   * Capture a workspace's definition fingerprint.
   *
   * `bindPaths` is how the SOURCE stays authoritative: the source capture omits it and the probe
   * DERIVES the bound set from the source-resolved command; the candidate capture passes the set
   * the source bound, so both sides are fingerprinted over exactly the same paths and a candidate
   * can never shrink its own exam by deleting a reference.
   */
  capture(workspacePath: string, bindPaths?: readonly string[]): Promise<VerificationDefinition>;
}

/** The definition artifacts that constitute the manifest-derived exam. Order-independent. */
export const VERIFICATION_DEFINITION_FILES: readonly string[] = Object.freeze([
  "package.json", "pnpm-workspace.yaml",
  "Cargo.toml", "go.mod", "go.sum",
  "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "pytest.ini",
  "vitest.config.ts", "vitest.config.js", "jest.config.js", "jest.config.ts", ".mocharc.json", ".mocharc.cjs",
]);

/**
 * Do two definition fingerprints differ in ANY bound artifact? (Added, removed, or changed.)
 *
 * TWO BANDS are compared, and both are authority:
 *   1. the fixed well-known manifest/config list (`VERIFICATION_DEFINITION_FILES`);
 *   2. V2-019/HIGH-03 — the repo-local paths the SOURCE-resolved check command DIRECTLY
 *      references (`referencedPaths`). The SOURCE decides which paths are bound; the candidate
 *      never gets to shrink that set, so a candidate that ADDS or REWRITES a referenced verifier
 *      script is caught even though the manifest naming it is untouched.
 */
export function definitionChanged(source: VerificationDefinition, candidate: VerificationDefinition): readonly string[] {
  const changed: string[] = [];
  for (const file of VERIFICATION_DEFINITION_FILES) {
    if ((source.files[file] ?? null) !== (candidate.files[file] ?? null)) changed.push(file);
  }
  // The SOURCE's bound set is authoritative — iterate ITS keys, never the candidate's.
  for (const path of Object.keys(source.referencedPaths ?? {})) {
    if ((source.referencedPaths?.[path] ?? null) !== (candidate.referencedPaths?.[path] ?? null)) changed.push(path);
  }
  return changed;
}

// ---------------------------------------------------------------------------
// V2-019/HIGH-03 — binding the EXECUTABLE DEFINITION of the exam
// ---------------------------------------------------------------------------

/**
 * WHY THIS EXISTS. Fingerprinting `package.json` proves the candidate did not rewrite the
 * `scripts.test` STRING. It proves nothing about what that string RUNS. A manifest that says
 *
 *     "test": "node test-policy.js"
 *
 * delegates the whole exam to a repository-local file. A candidate that leaves package.json alone
 * and rewrites `test-policy.js` from `exit 1` to `exit 0` has redefined its own exam and, before
 * this, collected a clean PASS for it.
 *
 * WHAT THIS DOES NOT DO. It does NOT statically analyse arbitrary programs. It does not follow
 * `require`/`import` graphs, resolve variables, or reason about what a script does at runtime. It
 * binds ONE conservative, explicitly-specified thing: repository-local paths that appear
 * DIRECTLY in the resolved command line, or directly in the package-manager script body that the
 * command line names. Anything it cannot parse with confidence is reported as UNRESOLVED rather
 * than silently treated as "nothing to bind" — the caller fails closed on that.
 *
 * The distinction the whole design rests on:
 *
 *     CHECK COMMAND DEFINITION  — what decides pass/fail. Source-authorized. BOUND here.
 *     CHECK SUBJECT FILES       — the product and its tests. What the candidate is meant to
 *                                 change. NOT bound (binding them would forbid the task).
 */

/**
 * WHERE THE LINE IS DRAWN between "bind it" and "refuse to guess".
 *
 * The attack this closes is a manifest that DELEGATES the verdict to a repository file:
 * `"test": "node test-policy.js"` — flip that file from `exit 1` to `exit 0` and the exam is
 * rewritten with the manifest untouched. The defence is to bind the program files a check
 * DIRECTLY names. Three cases are handled explicitly, and each one is a decision, not an omission:
 *
 *   BOUND      a repo-local program named directly on the command line — `node test-policy.js`,
 *              `python scripts/check.py`, `bash scripts/test.sh`, `./scripts/verify`, and the same
 *              via package-manager script indirection (`pnpm test` → the manifest's script body).
 *
 *   NOT BOUND  an INLINE program (`node -e "..."`, `bash -c "..."`): the program text lives in the
 *              manifest, which is already fingerprinted — there is no second file to bind.
 *              Likewise a GLOB target (`node --test "src/**\/*.test.ts"`): a glob expands to
 *              SUBJECT files. Those are the product's own tests — exactly what a task is normally
 *              asked to change — and binding them would forbid the work rather than protect it.
 *
 *   UNRESOLVED command substitution (`$(...)`, backticks) or variable expansion (`$VAR`, `${...}`).
 *              These can name ANY file, so the definition genuinely cannot be determined and the
 *              scope is reported INCOMPLETE — the caller fails closed rather than granting a PASS
 *              it cannot justify.
 */

/** Package-manager binaries whose `run <script>` / `<script>` form indirects through a manifest. */
const SCRIPT_RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Interpreters whose first non-flag argument is the repo-local program that defines the exam. */
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "python", "python3", "py", "ruby", "perl", "bash", "sh", "zsh", "dash"]);

/** Flags that mean "the program is INLINE, right here" — nothing further to bind. */
const INLINE_PROGRAM_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--command"]);

/** File suffixes that mark a token as an executable definition artifact rather than a data path. */
const SCRIPT_SUFFIXES = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".sh", ".bash", ".py", ".rb", ".pl"];

/** What the SOURCE state authorized as the executable definition of its exam. */
export interface VerificationDefinitionScope {
  /** Repo-relative paths that DIRECTLY define the exam and must be fingerprinted. Sorted, deduped. */
  readonly referencedPaths: readonly string[];
  /**
   * Command lines whose definition dependencies could NOT be determined (shell/command
   * substitution). Non-empty means the bound scope is INCOMPLETE and the caller must not claim
   * the exam is fully source-bound.
   */
  readonly unresolved: readonly string[];
}

/** Is this token a repo-local path we are willing to bind? Absolute paths, `..` escapes and globs are not. */
function repoLocalPath(token: string): string | undefined {
  if (token.length === 0 || token.startsWith("-")) return undefined;
  if (/[*?]/.test(token)) return undefined; // a glob expands to SUBJECT files, not a definition
  if (token.startsWith("/") || /^[A-Za-z]:[\\/]/.test(token)) return undefined; // absolute / system binary
  const normalized = token.startsWith("./") ? token.slice(2) : token;
  if (normalized.length === 0) return undefined;
  if (normalized.split("/").some((seg) => seg === "..")) return undefined;
  const looksLikeScript = SCRIPT_SUFFIXES.some((ext) => normalized.toLowerCase().endsWith(ext));
  // Bound when it names a script FILE, or when it was written as an explicit path into the repo
  // (`./scripts/verify`, `scripts/verify`) — i.e. the author pointed at something in the tree.
  if (!looksLikeScript && !token.startsWith("./") && !normalized.includes("/")) return undefined;
  return normalized;
}

/**
 * Split one command line into segments of tokens, RESPECTING QUOTES.
 *
 * Quoting must be handled before operator splitting, or `node -e "a; b"` would be torn in half and
 * its inline program mistaken for a second command. Returns `undefined` when the line contains
 * substitution/expansion whose meaning we refuse to guess.
 */
function lexCommandLine(line: string): readonly (readonly string[])[] | undefined {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | undefined;
  let hasToken = false;
  const endToken = (): void => {
    if (hasToken) tokens.push(token);
    token = "";
    hasToken = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote !== undefined) {
      if (ch === quote) { quote = undefined; continue; }
      // Expansion inside DOUBLE quotes is live; inside single quotes it is literal and safe.
      if (quote === '"' && (ch === "$" || ch === "`")) return undefined;
      token += ch;
      hasToken = true;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (ch === "`") return undefined; // command substitution
    if (ch === "$") return undefined; // variable / command expansion
    if (ch === "&" || ch === "|" || ch === ";") {
      // `&&`, `||`, `;`, `|` all end a command; a lone `&` (background) does too.
      endSegment();
      if ((ch === "&" || ch === "|") && line[i + 1] === ch) i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { endToken(); continue; }
    token += ch;
    hasToken = true;
  }
  if (quote !== undefined) return undefined; // unterminated quote — refuse to guess
  endSegment();
  return segments;
}

/**
 * Bind the executable definition of the resolved check commands.
 *
 * `scripts` is the SOURCE manifest's script map (empty when there is none). Package-manager
 * indirection is followed through it — the manifest itself is already fingerprinted, but the FILES
 * its scripts name are not, and those are the point. There is NO program analysis: nothing follows
 * `require`/`import`, resolves a variable, or reasons about runtime behaviour.
 */
export function bindVerificationDefinitionScope(input: {
  readonly checks: readonly { readonly command: string; readonly args: readonly string[]; readonly cwd?: string }[];
  readonly scripts: Readonly<Record<string, string>>;
}): VerificationDefinitionScope {
  const paths = new Set<string>();
  const unresolved: string[] = [];
  const visitedScripts = new Set<string>();

  /** Walk one already-lexed segment. `depth` bounds package-script indirection. */
  const walk = (tokens: readonly string[], depth: number, origin: string): void => {
    if (tokens.length === 0) return;
    if (depth > 4) { unresolved.push(origin); return; }
    const [bin, ...rest] = tokens as [string, ...string[]];
    const binName = bin.split("/").pop() ?? bin;

    // (a) PACKAGE-MANAGER INDIRECTION: `pnpm test`, `npm run test`, `yarn check`.
    if (SCRIPT_RUNNERS.has(binName)) {
      const args = rest.filter((t) => !t.startsWith("-"));
      const scriptName = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0];
      if (scriptName === undefined) return; // e.g. bare `pnpm install` — nothing to bind.
      const body = input.scripts[scriptName];
      if (body === undefined) return; // not a manifest script (e.g. `pnpm exec tsc`) — names nothing local.
      if (visitedScripts.has(scriptName)) return; // cycle guard
      visitedScripts.add(scriptName);
      const inner = lexCommandLine(body);
      if (inner === undefined) { unresolved.push(body); return; }
      for (const seg of inner) walk(seg, depth + 1, body);
      return;
    }

    // (b) INTERPRETER INDIRECTION: `node test-policy.js`, `python scripts/check.py`, `bash x.sh`.
    if (INTERPRETERS.has(binName)) {
      // An INLINE program is fully contained in the (already fingerprinted) manifest.
      if (rest.some((t) => INLINE_PROGRAM_FLAGS.has(t))) return;
      const target = rest.find((t) => !t.startsWith("-"));
      if (target !== undefined) {
        const local = repoLocalPath(target);
        if (local !== undefined) paths.add(local);
      }
      return;
    }

    // (c) A REPO-LOCAL EXECUTABLE INVOKED DIRECTLY: `./scripts/verify`.
    const local = repoLocalPath(bin);
    if (local !== undefined) paths.add(local);
  };

  for (const check of input.checks) {
    const line = [check.command, ...check.args].join(" ").trim();
    const segments = lexCommandLine(line);
    if (segments === undefined) { unresolved.push(line); continue; }
    for (const seg of segments) walk(seg, 0, line);
  }
  return { referencedPaths: [...paths].sort(), unresolved };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** How one check ended. Timeout and infrastructure are NOT ordinary failures. */
export type CheckStatus = "pass" | "fail" | "timeout" | "infrastructure_failure";

/** The durable account of one check. Output is a hash plus a bounded excerpt, never a dump. */
export interface CheckRecord {
  readonly name: string;
  /** The rendered command line ("binary arg1 arg2"), for audit. */
  readonly command: string;
  /** Where it ran, repository-relative. Absent means the workspace root. */
  readonly cwd?: string;
  readonly status: CheckStatus;
  /** Present iff the command launched. */
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly outputSha256: string;
  readonly outputExcerpt: string;
}

/**
 * The aggregate verdict.
 *
 *   pass / fail                 checks ran and (all passed) / (at least one failed).
 *   no_checks                   nothing verifiable was found. NOT a pass — whether that
 *                               is acceptable is a later disposition question.
 *   timeout                     a check exceeded its bound; the candidate is indeterminate.
 *   infrastructure_failure      a check could not run at all (denied binary, launch error).
 *   candidate_drift             the workspace tree did not match the candidate BEFORE checks.
 *   workspace_mutated_by_checks the checks changed the tree; the result is not about this
 *                               candidate.
 */
export type VerificationVerdict =
  | "pass"
  | "fail"
  | "no_checks"
  /**
   * V2-016A/B4: the candidate CHANGED a verification-DEFINITION artifact (package.json scripts,
   * a build/test manifest or config) relative to the source snapshot, so the manifest-derived exam
   * is no longer the source-authorized one. Fail-closed: the candidate cannot silently redefine the
   * exam that judges it. Operator-supplied IKBI_CHECKS is trusted policy and is NOT subject to this.
   */
  | "verification_policy_changed"
  | "timeout"
  | "infrastructure_failure"
  | "candidate_drift"
  | "workspace_mutated_by_checks";

/** A verdict that means the checks either did not run or do not apply to this candidate. */
export function isConclusive(verdict: VerificationVerdict): boolean {
  return verdict === "pass" || verdict === "fail";
}

/**
 * Aggregate ordered check statuses into a verdict, RUN-ALL semantics.
 *
 * Every selected check runs (within budget) so the record shows the full deterministic
 * defect set. Precedence when statuses mix: an INFRASTRUCTURE failure or a TIMEOUT means
 * the evidence is incomplete, so neither a clean pass nor an honest fail can be claimed —
 * they outrank `fail`, which outranks `pass`.
 */
export function aggregateCheckVerdict(checks: readonly CheckRecord[]): VerificationVerdict {
  if (checks.length === 0) return "no_checks";
  if (checks.some((c) => c.status === "infrastructure_failure")) return "infrastructure_failure";
  if (checks.some((c) => c.status === "timeout")) return "timeout";
  if (checks.some((c) => c.status === "fail")) return "fail";
  return "pass";
}

/** Classify one raw execution into a check status. */
export function classifyExecution(execution: CheckExecution): CheckStatus {
  if (!execution.launched) return "infrastructure_failure";
  if (execution.timedOut) return "timeout";
  return execution.exitCode === 0 ? "pass" : "fail";
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

/** How the workspace was left after verification. */
export type VerificationDisposition = "retained" | "discarded";

/** THE immutable account of one verification, bound to exactly one candidate tree. */
export interface VerificationRecord {
  readonly verificationId: V2VerificationId;
  readonly runId: V2RunId;
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly planId: V2PlanDigest;
  /** The tree observed BEFORE checks — equals candidateTreeId unless there was drift. */
  readonly treeBeforeChecks: string;
  /** The tree observed AFTER checks — equals treeBeforeChecks unless the checks mutated it. */
  readonly treeAfterChecks: string;
  readonly checks: readonly CheckRecord[];
  readonly verdict: VerificationVerdict;
  readonly workspaceDisposition: VerificationDisposition;
  readonly startedAt: number;
  readonly endedAt: number;
}

/**
 * Content address of a verification.
 *
 * Binds the exact candidate, the exact tree it claims to be about, the plan, the ordered
 * per-check verdicts, and the aggregate. Deliberately EXCLUDES durations and output text
 * — those vary run to run — so the identity is a statement about WHAT WAS VERIFIED and HOW
 * IT TURNED OUT, not about the noise of one execution. A different candidate tree changes
 * `candidateTreeId` and therefore the id, even if the checks coincidentally printed the
 * same thing.
 */
export function verificationDigest(input: {
  readonly candidateId: V2CandidateId;
  readonly candidateTreeId: string;
  readonly planId: V2PlanDigest;
  readonly checks: readonly CheckRecord[];
  readonly verdict: VerificationVerdict;
  readonly treeAfterChecks: string;
}): V2VerificationId {
  return contentDigest("verification", {
    candidateId: input.candidateId,
    candidateTreeId: input.candidateTreeId,
    planId: input.planId,
    verdict: input.verdict,
    treeAfterChecks: input.treeAfterChecks,
    checks: input.checks.map((c) => ({ name: c.name, command: c.command, status: c.status, exitCode: c.exitCode ?? null })),
  });
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_VERIFICATION_FAILURE_CODES = {
  subjectMismatch: "verification.subject_mismatch",
  workspaceMissing: "verification.workspace_missing",
  candidateDrift: "verification.candidate_drift",
  workspaceMutatedByChecks: "verification.workspace_mutated_by_checks",
  planningFailed: "verification.planning_failed",
} as const;

/** Build a verification failure. Identities and reasons only — never raw check output. */
export function verificationFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "verification",
    code,
    message,
    stage: "verification",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// The orchestration
// ---------------------------------------------------------------------------

export interface VerifyCandidateInput {
  readonly runId: V2RunId;
  readonly subject: VerificationSubject;
  readonly candidate: CandidateRecord;
  readonly workspacePath: string;
  readonly checksSource: ChecksSource;
  readonly runner: CheckRunner;
  readonly tree: TreeProbe;
  readonly checkTimeoutMs: number;
  /**
   * V2-016A/B4: the verification-definition fingerprint captured from the SOURCE snapshot before the
   * builder ran, plus the probe to re-capture it from the candidate. When a manifest-derived exam is
   * used and the candidate changed a definition artifact, the verdict is `verification_policy_changed`.
   * Absent ⇒ the guard is skipped (used only by callers that cannot capture source truth).
   */
  readonly sourceDefinition?: VerificationDefinition;
  readonly definitionProbe?: VerificationDefinitionProbe;
  readonly now?: () => number;
}

export type VerifyCandidateOutcome =
  | { readonly ok: true; readonly record: VerificationRecord }
  | { readonly ok: false; readonly failure: RunFailure };

const MAX_EXCERPT_CHARS = 1_500;

/** Bound a captured excerpt defensively; the adapter already tails, this is belt-and-suspenders. */
function boundExcerpt(text: string): string {
  return text.length <= MAX_EXCERPT_CHARS ? text : text.slice(text.length - MAX_EXCERPT_CHARS);
}

/**
 * Verify one candidate. Pure orchestration over the injected seams.
 *
 * The shape is deliberately linear: bind the subject, recompute the tree (drift guard),
 * plan, run, recompute the tree (mutation guard), classify. Every guard that trips
 * produces a truthful terminal verdict and stops — nothing is retried, nothing is
 * regenerated, no model is consulted.
 */
export async function verifyCandidate(input: VerifyCandidateInput): Promise<VerifyCandidateOutcome> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const { subject, candidate } = input;

  // 0. SUBJECT BINDING. A subject that does not describe this candidate is refused before
  //    any I/O — verifying someone else's work is not a smaller verification, it is a lie.
  const mismatch = validateSubject(subject, candidate, input.runId);
  if (mismatch !== undefined) return { ok: false, failure: mismatch };

  // 1. TREE BEFORE. If the workspace cannot even be read, verification did not happen.
  let treeBefore: string;
  try {
    treeBefore = await input.tree.treeOf(input.workspacePath);
  } catch (err) {
    return {
      ok: false,
      failure: verificationFailure(
        V2_VERIFICATION_FAILURE_CODES.workspaceMissing,
        `cannot read the candidate workspace ${subject.workspaceId}: ${err instanceof Error ? err.message : String(err)}`,
        { candidateId: subject.candidateId, workspaceId: subject.workspaceId },
      ),
    };
  }

  const finish = (input2: {
    readonly planId: V2PlanDigest;
    readonly checks: readonly CheckRecord[];
    readonly verdict: VerificationVerdict;
    readonly treeAfterChecks: string;
  }): VerifyCandidateOutcome => ({
    ok: true,
    record: Object.freeze({
      verificationId: verificationDigest({
        candidateId: subject.candidateId,
        candidateTreeId: subject.candidateTreeId,
        planId: input2.planId,
        checks: input2.checks,
        verdict: input2.verdict,
        treeAfterChecks: input2.treeAfterChecks,
      }),
      runId: input.runId,
      candidateId: subject.candidateId,
      candidateTreeId: subject.candidateTreeId,
      planId: input2.planId,
      treeBeforeChecks: treeBefore,
      treeAfterChecks: input2.treeAfterChecks,
      checks: input2.checks,
      verdict: input2.verdict,
      // Retained on every conclusive-or-not outcome: recovery and disposition are the next
      // authorities, and both want the exact tree that was judged. The run owns cleanup.
      workspaceDisposition: "retained",
      startedAt,
      endedAt: now(),
    }),
  });

  // The plan exists for every outcome so the record always cites one. For a drift or a
  // no-checks stop it is the plan that WOULD have run (empty when nothing was resolvable).
  const emptyPlan = buildVerificationPlan({ checks: [], timeoutMs: input.checkTimeoutMs, source: "default" });

  // 2. DRIFT GUARD. The workspace must still be the candidate. If not, NO check runs and
  //    we do not recapture — the candidate is a fixed thing, and "verify what is there"
  //    is exactly the habit this authority exists to break.
  if (treeBefore !== subject.candidateTreeId) {
    return finish({ planId: emptyPlan.planId, checks: [], verdict: "candidate_drift", treeAfterChecks: treeBefore });
  }

  // 3. PLAN. Deterministic discovery over the workspace, decided in full before execution.
  const resolved = await input.checksSource.resolve(input.workspacePath);
  if (!resolved.ok || resolved.checks.length === 0) {
    // NO_CHECKS is truthful, and it is NOT a pass. Nothing ran, so the tree is unchanged.
    return finish({ planId: emptyPlan.planId, checks: [], verdict: "no_checks", treeAfterChecks: treeBefore });
  }
  const plan = buildVerificationPlan({ checks: resolved.checks, timeoutMs: input.checkTimeoutMs, source: resolved.source });

  // 3.5 VERIFICATION-POLICY INTEGRITY (V2-016A/B4). A MANIFEST-derived exam (`source: "default"`) is
  //     read from the CANDIDATE tree, so a candidate could rewrite its own exam (package.json test
  //     script, a build/test manifest). If the candidate changed ANY verification-definition artifact
  //     relative to the source snapshot, the exam is no longer source-authorized: fail-closed with a
  //     structured `verification_policy_changed` verdict — never a normal PASS. Operator IKBI_CHECKS
  //     (`source: "env"`) is trusted policy and is NOT subject to this.
  if (input.sourceDefinition !== undefined && input.definitionProbe !== undefined) {
    const source = input.sourceDefinition;
    const boundPaths = Object.keys(source.referencedPaths ?? {});
    // V2-019/HIGH-03: an exam whose executable definition could not be determined is NOT provably
    // source-bound, so it cannot yield a PASS. Fail closed on an INCOMPLETE scope rather than
    // pretending an unparseable command has no definition dependencies.
    if ((source.unresolvedDefinitions ?? []).length > 0) {
      return finish({ planId: plan.planId, checks: [], verdict: "verification_policy_changed", treeAfterChecks: treeBefore });
    }
    // Operator IKBI_CHECKS (`source: "env"`) is trusted POLICY: its manifest band is not compared,
    // because the operator — not the candidate — chose the command. But a repo-local script that
    // operator policy DELEGATES the verdict to is still candidate-writable, so the referenced-path
    // band applies to env checks too. (Default: bind the referenced verifier script.)
    const compareManifest = resolved.source === "default";
    if (compareManifest || boundPaths.length > 0) {
      const candidateDefinition = await input.definitionProbe.capture(input.workspacePath, boundPaths);
      const changed = definitionChanged(
        compareManifest ? source : { files: {}, referencedPaths: source.referencedPaths ?? {} },
        compareManifest ? candidateDefinition : { files: {}, referencedPaths: candidateDefinition.referencedPaths ?? {} },
      );
      if (changed.length > 0) {
        return finish({ planId: plan.planId, checks: [], verdict: "verification_policy_changed", treeAfterChecks: treeBefore });
      }
    }
  }

  // 4. RUN ALL, in plan order. Every check runs within budget so the record shows the full
  //    defect set rather than stopping at the first red.
  const checks: CheckRecord[] = [];
  for (const planned of plan.checks) {
    const execution = await input.runner.run({
      name: planned.name,
      command: planned.command,
      args: planned.args,
      cwd: input.workspacePath,
      ...(planned.cwd !== undefined ? { relativeCwd: planned.cwd } : {}),
      timeoutMs: planned.timeoutMs,
    });
    checks.push({
      name: planned.name,
      command: `${planned.command} ${planned.args.join(" ")}`.trim(),
      ...(planned.cwd !== undefined ? { cwd: planned.cwd } : {}),
      status: classifyExecution(execution),
      ...(execution.exitCode !== undefined ? { exitCode: execution.exitCode } : {}),
      durationMs: execution.durationMs,
      outputSha256: execution.outputSha256,
      outputExcerpt: boundExcerpt(execution.outputExcerpt),
    });
  }

  // 5. TREE AFTER. If the checks changed the tree, the result is not about this candidate,
  //    whatever the exit codes said. A green suite that rewrote its subject verified nothing.
  let treeAfter: string;
  try {
    treeAfter = await input.tree.treeOf(input.workspacePath);
  } catch (err) {
    return {
      ok: false,
      failure: verificationFailure(
        V2_VERIFICATION_FAILURE_CODES.workspaceMissing,
        `the candidate workspace became unreadable during verification: ${err instanceof Error ? err.message : String(err)}`,
        { candidateId: subject.candidateId, workspaceId: subject.workspaceId },
      ),
    };
  }

  if (treeAfter !== treeBefore) {
    return finish({ planId: plan.planId, checks, verdict: "workspace_mutated_by_checks", treeAfterChecks: treeAfter });
  }

  // 6. AGGREGATE. The tree is intact and equals the candidate; the verdict is the checks'.
  return finish({ planId: plan.planId, checks, verdict: aggregateCheckVerdict(checks), treeAfterChecks: treeAfter });
}

// ---------------------------------------------------------------------------
// Receipt view
// ---------------------------------------------------------------------------

/** A receipt-safe account of a verification. Ids, verdicts, hashes and counts — no logs. */
export interface RunVerificationSummary {
  readonly verificationId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly candidateTreeId: string;
  readonly planId: string;
  readonly verdict: VerificationVerdict;
  readonly treeBeforeChecks: string;
  readonly treeAfterChecks: string;
  readonly treeUnchanged: boolean;
  readonly workspaceDisposition: VerificationDisposition;
  readonly checks: readonly {
    readonly name: string;
    readonly command: string;
    /** Where it ran, repository-relative. Absent means the workspace root. */
    readonly cwd?: string;
    readonly status: CheckStatus;
    readonly exitCode: number | null;
    readonly durationMs: number;
    readonly outputSha256: string;
    readonly outputExcerpt: string;
  }[];
}

export function summarizeVerification(record: VerificationRecord): RunVerificationSummary {
  return {
    verificationId: record.verificationId,
    runId: record.runId,
    candidateId: record.candidateId,
    candidateTreeId: record.candidateTreeId,
    planId: record.planId,
    verdict: record.verdict,
    treeBeforeChecks: record.treeBeforeChecks,
    treeAfterChecks: record.treeAfterChecks,
    treeUnchanged: record.treeBeforeChecks === record.treeAfterChecks,
    workspaceDisposition: record.workspaceDisposition,
    checks: record.checks.map((c) => ({
      name: c.name,
      command: c.command,
      ...(c.cwd !== undefined ? { cwd: c.cwd } : {}),
      status: c.status,
      exitCode: c.exitCode ?? null,
      durationMs: c.durationMs,
      outputSha256: c.outputSha256,
      outputExcerpt: c.outputExcerpt,
    })),
  };
}
