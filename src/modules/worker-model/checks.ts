/**
 * ikbi worker-model — v1 CHECK EXECUTION HELPERS (discovery now lives elsewhere).
 *
 * CHECK DISCOVERY MOVED (V2-020/Phase 3). The `Check` shape, the default check set, `IKBI_CHECKS`
 * parsing, project-root detection, `resolveChecks`, and the timeout policy are now owned by the
 * NEUTRAL `modules/checks` module. v2 — the canonical production build engine — imports them from
 * there directly, so it no longer depends on this v1-owned module for anything.
 *
 * They are RE-EXPORTED verbatim below for this module's own remaining v1 callers. There is exactly
 * ONE implementation and one set of semantics — this is a re-export, never a fork.
 *
 * WHAT STILL LIVES HERE is v1 pipeline machinery: verification-kind classification and its operator
 * messaging, working-tree/committed diff capture, streamed stdout capture, and the exec→CheckResult
 * mapping (`mapExec`, `parseTestCount`, `tail`). These belong to the v1 orchestration and its
 * retained consumers, not to check discovery.
 */

import type { ExecResult } from "../governed-exec/index.js";

// THE neutral check-discovery surface, re-exported for v1's remaining callers. One owner, one behaviour.
export {
  VERIFIER_CHECKS,
  PROJECT_MANIFESTS,
  resolveProjectRoot,
  parseChecksEnv,
  resolveChecks,
  DEFAULT_CHECK_TIMEOUT_MS,
  MAX_CHECK_TIMEOUT_MS,
  resolveCheckTimeoutMs,
} from "../checks/index.js";
export type { Check, ChecksResolution } from "../checks/index.js";

/**
 * VERIFICATION CLASSIFICATION — the load-bearing distinction this module exists to draw.
 *
 *   checks_green        checks were derived, ran, and PASSED.
 *   checks_red          checks were derived and ran, but FAILED. A legitimate build/model failure
 *                       that MAY enter the retry/escalation policy (a stronger model can fix red code).
 *   checks_unresolvable ikbi could NOT derive or run any meaningful verifier — no manifest, no
 *                       recognized project type, no runnable check command, no IKBI_CHECKS override.
 *                       A stronger model cannot fix a MISSING manifest, so this MUST NOT escalate;
 *                       it fails closed with an actionable diagnostic.
 *   unsupported_project a project manifest exists but ikbi has no check set for it (e.g. bun-only,
 *                       or a manifest type with no derivable checks). Same fail-closed, no-escalate
 *                       handling as checks_unresolvable.
 *   environment_missing a required tool/runtime was absent (reserved; classified elsewhere).
 *   tool_limitation     the verification TOOL (not the project) could not parse/run the check.
 */
export type VerificationKind =
  | "checks_green"
  | "checks_red"
  | "checks_unresolvable"
  | "environment_missing"
  | "tool_limitation"
  | "unsupported_project";

/**
 * Classify a `resolveChecks` fail-closed reason (the `{ ok: false, reason }` branch) into the
 * no-verifier verdict kind. A manifest that EXISTS but has no derivable check set (or an
 * unsupported package manager) is UNSUPPORTED_PROJECT; the absence of any derivable verifier is
 * CHECKS_UNRESOLVABLE. Both suppress escalation and fail closed — the split is for the diagnostic.
 */
export function classifyUnresolvableReason(reason: string): "checks_unresolvable" | "unsupported_project" {
  if (/has a manifest but no recognized|not a supported package manager/i.test(reason)) {
    return "unsupported_project";
  }
  return "checks_unresolvable";
}

/** Actionable operator next-steps shown when a target is unverifiable (no derivable checks). */
export const UNRESOLVABLE_NEXT_STEPS: readonly string[] = [
  "add a project manifest (package.json / pyproject.toml / Cargo.toml / go.mod / project.godot)",
  "add a test/check script the verifier can run",
  'set IKBI_CHECKS="<command>" to declare the checks explicitly',
  "use an explicit bootstrap task if the goal is to initialize a project",
];

/**
 * The standard fail-closed, OPERATOR-actionable diagnostic for an unverifiable target. Surfaced on
 * the run result + receipt + CLI so the operator sees WHY the build failed closed (no runnable
 * checks), that this is NOT a model failure (escalation was suppressed), and HOW to make the target
 * verifiable. `kind` selects the "Detected" framing: UNSUPPORTED_PROJECT means a manifest WAS found
 * but ikbi has no check set for it; CHECKS_UNRESOLVABLE means nothing verifiable was found at all.
 */
export function unresolvableMessage(kind: string, reason: string): string {
  const detected =
    kind === "unsupported_project"
      ? ["a project manifest was found, but ikbi has no check set for this project type", `details: ${reason}`, "no IKBI_CHECKS override"]
      : ["no recognized project manifest or verifier", "no runnable check script", "no IKBI_CHECKS override"];
  return [
    "ikbi could not verify this target because no runnable checks were found.",
    "",
    `Classification: ${kind}`,
    "",
    "Detected:",
    ...detected.map((d) => `  - ${d}`),
    "",
    "This is not a model failure. Escalation was suppressed because a stronger model cannot fix a missing verification contract.",
    "",
    "Next steps:",
    ...UNRESOLVABLE_NEXT_STEPS.map((s) => `  - ${s}`),
  ].join("\n");
}

/**
 * The WORKING-TREE diff of package.json files vs base — what the script-integrity guard MUST
 * inspect. The verifier runs BEFORE the build is committed, so `git diff <baseRef>` (base vs the
 * current working tree) captures the builder's UNCOMMITTED edits to tracked package.json files,
 * whereas the committed `base..scratch` range is empty at that point. Scoped to `*package.json`
 * (git pathspec `*` crosses directories) so it covers root + every subpackage and stays small.
 * A brand-new (untracked) package.json does not appear — that is greenfield-legitimate, and its
 * no-op scripts are caught separately by the verification-ladder stub detector.
 *
 * FULL CONTEXT (`-U…`): the integrity guard's JSON-semantic pass reconstructs the whole base/working
 * package.json from this diff and compares the resolved `scripts` objects. A 3-line-context diff would
 * only show fragments (not JSON-parseable) and fall back to the weaker line-scan, so we request enough
 * context to span the file. package.json files are small, so the larger diff is cheap.
 */
export async function workingTreePackageJsonDiff(
  runGit: (args: readonly string[]) => Promise<string>,
  _worktreePath: string,
  baseRef: string,
): Promise<string> {
  return runGit(["diff", "-U1000000", baseRef, "--", "*package.json"]);
}

/**
 * The COMMITTED diff of package.json files for the `base..scratch` range — what the script-integrity
 * guard inspects for a candidate that COMMITS before it is judged (competitive mode), where the
 * working-tree diff is empty. The general committed diff (workspaces.diff → `git diff base..scratch`)
 * uses git's DEFAULT 3-line context, too narrow for the JSON-semantic parser to reconstruct a whole
 * package.json: a fragment is not JSON-parseable, so the parser returns indeterminate and falls back
 * to the weaker line-scan (which misses, e.g., a separate-line "test":/value rewrite). This requests
 * FULL context (`-U1000000`) for the SAME reason workingTreePackageJsonDiff does, scoped to
 * `*package.json` so it covers root + every subpackage and stays small.
 */
export async function committedPackageJsonDiff(
  runGit: (args: readonly string[]) => Promise<string>,
  baseRef: string,
  scratchBranch: string,
): Promise<string> {
  return runGit(["diff", "-U1000000", `${baseRef}..${scratchBranch}`, "--", "*package.json"]);
}

/**
 * Accumulate the FULL stdout of a STREAMING governed-exec call. governed-exec's ExecResult retains
 * only a bounded `stdoutTail` (the last ~2000 chars). Reading a large `git diff` through that tail
 * truncates the TOP of the diff — a package.json "scripts" mutation above the tail window would be
 * silently dropped before the JSON-semantic parser ever runs (a >2000-char diff flags the mutation,
 * but the last-2000-char tail returns clean). The streaming `onOutput` sink delivers every chunk
 * untruncated; this helper concatenates them so the integrity parser sees the whole diff. `forward`
 * (optional) mirrors each chunk to a secondary sink (e.g. the live UI). Falls back to `stdoutTail`
 * if nothing streamed (a buffered executor that ignores `onOutput`).
 */
export async function captureStreamedStdout(
  run: (onOutput: (chunk: string, stream: "stdout" | "stderr") => void) => Promise<ExecResult>,
  forward?: (chunk: string, stream: "stdout" | "stderr") => void,
): Promise<string> {
  let full = "";
  const res = await run((chunk, stream) => {
    if (stream === "stdout") full += chunk;
    if (forward !== undefined) forward(chunk, stream);
  });
  return full.length > 0 ? full : (res.stdoutTail ?? "");
}

const RELEVANT_WORKTREE_EXTS: readonly string[] = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  // Non-JS source languages — so planning/diff relevance covers Rust/Go/Python work too (a build
  // that only touches .py/.go/.rs is no longer seen as an empty, impact-scoped "nothing changed").
  ".py",
  ".go",
  ".rs",
  ".toml",
];

function syntheticAddedDiff(path: string): string {
  return [`diff --git a/${path} b/${path}`, "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1 @@", "+untracked"].join("\n");
}

function isRelevantWorktreePath(path: string): boolean {
  const lower = path.toLowerCase();
  return RELEVANT_WORKTREE_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Verifier-time planning diff: tracked working-tree changes against `baseRef` plus untracked
 * relevant files. The synthetic untracked headers make `parseChangedFiles` see greenfield work
 * rather than treating an empty tracked diff as an impact-scoped green.
 */
export async function workingTreePlanningDiff(
  runGit: (args: readonly string[]) => Promise<string>,
  _worktreePath: string,
  baseRef: string,
): Promise<string> {
  const trackedRaw = await runGit(["diff", "--name-only", baseRef, "--", "."]);
  const untrackedRaw = await runGit(["ls-files", "--others", "--exclude-standard", "--", "."]);
  const paths = [...trackedRaw.split(/\r?\n/), ...untrackedRaw.split(/\r?\n/)]
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isRelevantWorktreePath(s))
    .sort();
  const unique = [...new Set(paths)];
  return unique.map(syntheticAddedDiff).join("\n");
}

/** Captured output tail length retained in a check result. */
export const MAX_OUTPUT_TAIL = 2_000;

/** One check's outcome. Lives in the open `detail` bag — NOT a contract type. */
export interface CheckResult {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly outputTail: string;
  /**
   * Test tally ("# tests N" / "# pass N") parsed from the FULL, untruncated check output — robust
   * to `outputTail` truncation. A zero-test marker emitted EARLY in a verbose passing run is pushed
   * out of the last-MAX_OUTPUT_TAIL-chars tail, so re-parsing the tail downstream would miss it and
   * read "unverified" instead of "zero". Computed once here from the whole stream and carried so the
   * verdict layer (readVerifier) has a reliable count. Absent when no count was present in the output.
   */
  readonly testCount?: { readonly passed: number; readonly total: number };
  /**
   * When present, this check failure is caused by the VERIFICATION TOOL, not the project.
   * The project may be perfectly fine — the tool simply cannot parse/analyze modern syntax.
   * A verifier should classify this as TOOL_LIMITATION (non-blocking), not PROJECT_RED (blocking).
   */
  readonly toolLimitation?: { readonly reason: string };
}

export function tail(s: string, max: number): string {
  return s.length <= max ? s : s.slice(s.length - max);
}

/**
 * Parse a test-runner summary into a { passed, total } count, when present. Shared by the
 * check-capture layer (mapExec, on the FULL output) and the verdict layer (readVerifier) so both
 * read the tally the same way. Returns undefined when no recognizable summary is found.
 *
 * Recognizes the common runners — node:test, vitest, and jest — plus a generic
 * "N passing/passed ... M total/tests" shape. The node:test marker is tried first (it is ikbi's own
 * runner and the most precise); the others are fallbacks so repos under test with vitest/jest are not
 * stuck "unverified" (which would fail the C1 gate even when tests really ran and passed).
 */
export function parseTestCount(output: string): { passed: number; total: number } | undefined {
  // STRIP ANSI COLOR CODES FIRST. Under governed-exec, vitest (and other runners) color their summary
  // even on a non-TTY, so the escape sequences sit BETWEEN the tokens — e.g.
  // "\x1b[2m Tests \x1b[22m \x1b[1m\x1b[32m12 passed\x1b[39m\x1b[90m (12)" — which breaks the \s+
  // anchors in every pattern below and yields NO count (testEvidence "unverified" → a real, green
  // build gets discarded for "no test evidence"). Stripping makes colored and plain output parse alike.
  // eslint-disable-next-line no-control-regex
  output = output.replace(/\x1b\[[0-9;]*m/g, "");
  // node:test: the FINAL line-anchored summary block "# tests N" / "# pass N". Match as WHOLE summary
  // lines (^…, `m` flag) and take the LAST of each — NOT the first `# tests`/`# pass` occurrence
  // ANYWHERE in the stream. When ikbi builds ikbi (self-hosting), the suite echoes ikbi's OWN test
  // NAMES as TAP lines, and a name can literally contain "# tests 0" mid-line; a first-match, unanchored
  // parse then returns {passed:N, total:0} → testEvidence "zero" → a fully-green run is discarded as
  // vacuous. Line-anchoring skips the name-carrier lines; last-match takes the run's real final summary.
  const nodeTestsAll = [...output.matchAll(/^# tests (\d+)\b/gm)];
  const nodePassAll = [...output.matchAll(/^# pass (\d+)\b/gm)];
  if (nodeTestsAll.length > 0 && nodePassAll.length > 0) {
    const total = Number(nodeTestsAll[nodeTestsAll.length - 1]![1]);
    const passed = Number(nodePassAll[nodePassAll.length - 1]![1]);
    // `passed > total` is impossible for a real node:test summary ⇒ a misparse; return undefined
    // (⇒ "unverified", a real green signal that still passes the gate) rather than a bogus tally.
    if (passed <= total) return { passed, total };
  }

  // vitest: "Tests  3 passed (3)" — passed count then total in parens.
  const vitest = /Tests\s+(\d+)\s+passed\s+\((\d+)\)/.exec(output);
  if (vitest !== null) return { passed: Number(vitest[1]), total: Number(vitest[2]) };

  // jest: "Tests:       3 passed, 3 total".
  const jest = /Tests:\s+(\d+)\s+passed.*?(\d+)\s+total/.exec(output);
  if (jest !== null) return { passed: Number(jest[1]), total: Number(jest[2]) };

  // pytest: "N passed in X.XXs" or "N passed, M failed in X.XXs" (passed count only)
  const pytest = /(\d+)\s+passed(?:,\s+\d+\s+\w+)*\s+in\s+[\d.]+s/.exec(output);
  if (pytest !== null) { const n = Number(pytest[1]); return { passed: n, total: n }; }

  // cargo test: "test result: ok. N passed; M failed; K ignored; L measured; J filtered out"
  const cargoResult = /test result:\s*ok\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/.exec(output);
  if (cargoResult !== null) {
    const passed = Number(cargoResult[1]);
    const failed = Number(cargoResult[2]);
    return { passed, total: passed + failed };
  }
  // cargo test: simpler form — "test result: ok. N passed" (no failures mentioned)
  const cargoOk = /test result:\s*ok\.\s*(\d+)\s+passed/.exec(output);
  if (cargoOk !== null) { const n = Number(cargoOk[1]); return { passed: n, total: n }; }

  // go test: "ok  \tpackage/path\t0.123s" (pass) or "FAIL\tpackage/path\t0.123s" (fail)
  // Count ok/FAIL lines to determine total packages tested.
  const goOk = (output.match(/^ok\s+/gm) || []).length;
  const goFail = (output.match(/^FAIL\s+/gm) || []).length;
  if (goOk > 0 || goFail > 0) {
    return { passed: goOk, total: goOk + goFail };
  }

  // .NET VSTest (`dotnet test`): "Passed! - Failed: F, Passed: P, Skipped: S, Total: T, Duration: ..."
  // (or "Failed! - ..." on failure). Total is authoritative; passed is P (Total − Failed − Skipped).
  const vstest = /(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/i.exec(output);
  if (vstest !== null) {
    return { passed: Number(vstest[2]), total: Number(vstest[4]) };
  }

  // JVM (JUnit / Maven Surefire / Gradle): "Tests run: N, Failures: F, Errors: E[, Skipped: S]".
  // The canonical JVM summary — a hand-rolled `main` test, JUnit's ConsoleLauncher, and `mvn test` all
  // print it. passed = run − failures − errors (skipped are neither pass nor fail; they stay in total).
  const junit = /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/i.exec(output);
  if (junit !== null) {
    const total = Number(junit[1]);
    const passed = Math.max(0, total - Number(junit[2]) - Number(junit[3]));
    return { passed, total };
  }

  // python unittest: "Ran N tests in X.XXXs" then "OK" (all pass) or "FAILED (failures=F, errors=E)".
  // unittest prints no per-status count, so total comes from "Ran N" and failures are subtracted from
  // the FAILED(...) breakdown. A vacuous "Ran 0 tests" ⇒ total 0 ⇒ testEvidence "zero" (the gate still
  // discards a suite that ran nothing) — so recognizing this format never manufactures evidence.
  const unittestRan = /Ran\s+(\d+)\s+tests?\s+in\s+[\d.]+s/.exec(output);
  if (unittestRan !== null) {
    const total = Number(unittestRan[1]);
    const failedBlock = /FAILED\s*\(([^)]*)\)/.exec(output);
    let failed = 0;
    for (const m of (failedBlock?.[1] ?? "").matchAll(/(?:failures|errors)=(\d+)/g)) failed += Number(m[1]);
    return { passed: Math.max(0, total - failed), total };
  }

  // Generic "N passing/passed ... M total/tests" (mocha-style and friends). LAST — it is the greedy
  // fallback: `[\s\S]*?` bridges across lines, so on a multi-section runner (e.g. cargo, which prints
  // a "test result: ok. 17 passed" block then a trailing "running 0 tests" section for the bin/doc
  // targets) it wrongly pairs "17 passed" with the later "0 tests" and yields total:0 ⇒ testEvidence
  // "zero" ⇒ a fully-tested build is discarded. Trying it only AFTER the precise runners above lets
  // cargo/pytest/go win with their real count; the generic shape remains for mocha-likes.
  const generic = /(\d+)\s+(?:passing|passed)[\s\S]*?(\d+)\s+(?:total|tests)/.exec(output);
  if (generic !== null) return { passed: Number(generic[1]), total: Number(generic[2]) };

  return undefined;
}

/**
 * Detect when a check failure is caused by the VERIFICATION TOOL, not the project.
 * Returns a toolLimitation descriptor when the output matches known tool parser failures,
 * undefined otherwise. This lets the verifier distinguish "your code is broken" from
 * "the linter can't parse modern syntax."
 */
function detectToolLimitation(command: string, output: string): { reason: string } | undefined {
  // gdtoolkit (gdlint/gdformat): parser doesn't support async func, @export, or other GDScript 4.x syntax
  if (command.includes("gdlint") || command.includes("gdformat")) {
    if (/Unexpected token.*async/i.test(output) || /Unexpected token.*'NAME'.*'async'/i.test(output)) {
      return { reason: "gdtoolkit parser does not support `async func` syntax (GDScript 4.x) — tool limitation, not a project error" };
    }
    // A generic "Unexpected token … Expected one of" is NOT enough on its own — that matches ANY
    // parse error, including a real syntax mistake in the project (which is a PROJECT_RED, not a
    // tool limitation). Only classify it as a tool limitation when the UNEXPECTED token is a known
    // modern-syntax construct the tool predates (C5: gdtoolkit detector was too broad).
    const TOOL_LIMITATION_PATTERNS: readonly RegExp[] = [
      /async\s+func/i, // GDScript 4.x async functions
      /@export|@onready|@tool\b|@icon|@rpc/i, // GDScript 4.x annotations (named forms)
      /Token\('AT'/, // gdtoolkit's token name for an annotation '@'
      /match\s*[:{]/, // Python 3.10+ / GDScript match-case
      /type\s+\w+\s*=/i, // Python 3.10+ type aliases
    ];
    if (/Unexpected token/i.test(output) && /Expected one of/i.test(output) && TOOL_LIMITATION_PATTERNS.some((re) => re.test(output))) {
      return { reason: "gdtoolkit parser failed on modern syntax it does not recognize (e.g. an annotation or async func) — tool limitation, not a project error" };
    }
  }
  // Python tools: syntax version mismatches
  if (command.includes("pylint") || command.includes("flake8") || command.includes("mypy")) {
    if (/SyntaxError.*invalid syntax/i.test(output) && /match\s+/.test(output)) {
      return { reason: "linter does not support Python 3.10+ match/case syntax — tool limitation" };
    }
  }
  // Generic: tool crash / unhandled exception in the tool itself
  if (/Traceback \(most recent call last\)/.test(output) && /(?:gdlint|gdformat|pylint|flake8|mypy|eslint|tsc)/i.test(command)) {
    return { reason: "verification tool crashed with an unhandled exception — tool limitation, not a project error" };
  }
  return undefined;
}

/**
 * Map one governed ExecResult onto a CheckResult (fail-closed on deny / dry-run).
 *
 * `fullOutput` (optional) is the COMPLETE, untruncated stdout the caller accumulated from the
 * streaming `onOutput` sink. governed-exec's ExecResult only retains the last OUTPUT_TAIL_CHARS, so
 * a zero-test marker emitted early in a verbose run is already gone from `res.stdoutTail`. When the
 * caller supplies the full stream, the test tally is parsed from THAT (robust); otherwise we fall
 * back to the bounded tail. The stamped `testCount` lets the verdict layer avoid re-parsing the tail.
 */
export function mapExec(name: string, command: string, res: ExecResult, fullOutput?: string): { check: CheckResult; dryRun: boolean } {
  if (res.executed) {
    const output = `${res.stdoutTail ?? ""}${res.stderrTail ?? ""}`;
    const testCount = parseTestCount(fullOutput ?? output);
    // Detect tool limitations on non-zero exit — the tool failed, not necessarily the project.
    const toolLimitation = (res.exitCode ?? 1) !== 0 ? detectToolLimitation(command, fullOutput ?? output) : undefined;
    return {
      check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(output, MAX_OUTPUT_TAIL), ...(testCount !== undefined ? { testCount } : {}), ...(toolLimitation !== undefined ? { toolLimitation } : {}) },
      dryRun: false,
    };
  }
  if (res.denied === true) {
    // FAIL CLOSED: a denied / non-allowlisted check is a non-zero check, NEVER a pass.
    const note = `governed-exec DENIED: ${res.reason ?? "denied"} — add "${command.split(" ")[0]}" to IKBI_GOVERNED_EXEC_ALLOWLIST for real checks`;
    return { check: { name, command, exitCode: res.exitCode ?? 1, outputTail: tail(note, MAX_OUTPUT_TAIL) }, dryRun: false };
  }
  // executed:false, not denied ⇒ DRY-RUN (governed-exec reported intent, ran nothing).
  const note = `governed-exec dry-run: ${res.reason ?? "intent only — not executed"}`;
  return { check: { name, command, exitCode: 1, outputTail: tail(note, MAX_OUTPUT_TAIL) }, dryRun: true };
}
