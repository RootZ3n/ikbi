/**
 * ikbi worker-model — VERIFIER role (Pass A: objective checks, DETERMINISTIC).
 *
 * Runs a FIXED, known set of read-only checks (typecheck + tests) against the
 * workspace and produces an objective verdict. NOT model-driven: verifier never
 * calls `invokeModel`, and the command set is a hardcoded constant.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SECURITY (3-eyes, C1) — TWO orthogonal guards, BOTH load-bearing:
 *
 *  LAYER 1 — GOVERNED EXECUTION. The checks run through GOVERNED-EXEC (gate-wall
 *    authorizes, receipted, default-deny allowlist, dry-run-able), NEVER raw
 *    `spawnSync`. A DENIED check (non-allowlisted binary / gate deny) FAILS CLOSED —
 *    it is a non-zero check, never a silent pass. The package managers the checks
 *    invoke (`pnpm`/`npm`/`yarn`/`npx`) ARE on governed-exec's DEFAULT allowlist —
 *    the verifier must be able to run `pnpm tsc` / `pnpm test` out of the box, so the
 *    default-deny posture deliberately admits them. What stays denied is script
 *    EXECUTION via these managers: `<mgr> run …` and code-eval flags are policy-gated
 *    (see governed-exec policy), so a terminal `pnpm run anything` is still refused
 *    even though the binary is allowlisted. An operator widens the binary set further
 *    via IKBI_GOVERNED_EXEC_ALLOWLIST (additive).
 *    governed-exec needs a validated OperationContext (#10) — the orchestrator threads
 *    the run's parent ctx (the spawned role identity is not a minted ValidatedIdentity,
 *    so it cannot itself authorize a governed exec).
 *
 *  LAYER 2 — SCRIPT INTEGRITY. The BUILDER controls the workspace, including
 *    `package.json`'s "scripts". A governed invocation of an attacker-rewritten `test`
 *    script is still arbitrary execution — and a build that makes its own tests "pass"
 *    by rewriting them would forge a passing signal to the judge/promote. So BEFORE any
 *    check, the verifier inspects the workspace diff (base..scratch) and REJECTS the
 *    verification as UNTRUSTED if the builder modified the script surface the verifier
 *    relies on. A test suite the builder rewrote cannot verify the builder's own work.
 *    Fail-closed: a mutated-scripts build CANNOT pass verification (in competitive mode
 *    the judge then disqualifies it). A SECOND pass extends this past package.json itself: a
 *    guarded script that stays byte-unchanged but SHELLS OUT to a file the build rewrote
 *    (`"test": "bash ./test.sh"` + a neutered `test.sh`) is rejected the same way. The guard is
 *    MANDATORY: without a diff source to
 *    inspect, integrity cannot be proven, so verification fails closed (untrusted) — a
 *    missing diff capability is treated exactly like a diff read failure.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Read-only: the checks below (`tsc --noEmit`, `test`) do not mutate the workspace.
 * Commands run with `cwd: ctx.workspace.path`.
 */

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";

import type { OperationContext } from "../../core/identity/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import type { GovernedExec } from "../governed-exec/index.js";

// The check SET is the single shared definition (worker-model/checks.ts) — the SAME
// constant the builder's in-loop run_checks imports, so the builder previews the
// verifier's EXACT checks. Behavior here is unchanged; the constant just relocated.
import { type CheckResult, type ChecksResolution, mapExec, parseChecksEnv, resolveCheckTimeoutMs, VERIFIER_CHECKS } from "./checks.js";
import type { RoleFn, RoleResult } from "./contract.js";
import { runQualityChecks, type QualityResult } from "./quality-checks.js";
// LADDER MODE (opt-in, IKBI_VERIFY=ladder): package/impact-aware verification. These are
// library-only consumers — no side effects at import; the default (legacy) path never calls them.
import { projectIndex, type ProjectIndexData } from "../project-index/index.js";
import { isStubScript, verificationLadder, type VerificationPlan } from "../verification-ladder/index.js";
import { parseCheckOutput, type CheckTriage } from "../check-triage/index.js";
import { resolveVerificationMode, type VerificationMode } from "./modes.js";

// The check-timeout constants + resolver now live in the SHARED check definition (checks.ts) so the
// verifier and the builder's in-loop run_checks resolve the SAME per-check budget. Re-exported here
// so existing importers (and tests) keep `import { ... } from "./verifier.js"`.
export { DEFAULT_CHECK_TIMEOUT_MS, MAX_CHECK_TIMEOUT_MS } from "./checks.js";

/** Extract changed file paths (repo-relative POSIX) from a unified `git diff`. */
export function parseChangedFiles(diff: string): string[] {
  const out = new Set<string>();
  for (const line of diff.split("\n")) {
    const g = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (g) {
      if (g[1] !== undefined && g[1] !== "/dev/null") out.add(g[1]);
      if (g[2] !== undefined && g[2] !== "/dev/null") out.add(g[2]);
      continue;
    }
    const p = /^\+\+\+ b\/(.+)$/.exec(line);
    if (p && p[1] !== undefined && p[1] !== "/dev/null") out.add(p[1]);
    const m = /^--- a\/(.+)$/.exec(line);
    if (m && m[1] !== undefined && m[1] !== "/dev/null") out.add(m[1]);
  }
  return [...out].sort();
}

/** Re-exported for consumers (and tests) that import it from the verifier. */
export type { CheckResult } from "./checks.js";

/**
 * The package.json script keys the verifier's checks depend on: `pnpm test` runs the
 * "test" script (and its pre/post hooks); `pnpm tsc`/build the tsc/build surface. A
 * builder change to ANY of these means the command the verifier runs is attacker-defined.
 * (A dependency bump touches "dependencies"/"devDependencies" — NOT these — so it does
 * not trip; this is precise scope, not "any package.json change".)
 */
const GUARDED_SCRIPT_KEYS: readonly string[] = [
  "test", "pretest", "posttest",
  "build", "prebuild", "postbuild",
  "tsc", "pretsc", "posttsc",
  // T1: also guard the other scripts an operator may trust as verification signals.
  "typecheck", "lint", "check", "validate", "ci", "e2e", "integration", "coverage",
];

/** Injectable dependencies. Defaults wire the live governed-exec singleton (lazily). */
export interface VerifierDeps {
  /** Governed executor — every check routes through it (gate-wall + allowlist + receipts). */
  readonly governedExec?: Pick<GovernedExec, "run">;
  /**
   * The run's validated OperationContext. governed-exec requires a minted
   * ValidatedIdentity (#10) + honors `dryRun`. Absent ⇒ the verifier fails closed.
   */
  readonly parentCtx?: OperationContext;
  /**
   * Workspace diff source (base..scratch) for the MANDATORY LAYER-2 script-integrity
   * guard. Optional in the type (injectable/omittable for tests), but a verifier built
   * WITHOUT it fails closed at run time (untrusted) — it cannot prove script integrity.
   */
  readonly diff?: (workspace: WorkspaceHandle) => Promise<string>;
  /**
   * Diff used by ladder impact planning. When omitted, ladder falls back to `diff`; production
   * wires this to the full verifier-time working-tree diff while keeping `diff` scoped to the
   * package.json script-integrity surface.
   */
  readonly planningDiff?: (workspace: WorkspaceHandle) => Promise<string>;
  /**
   * Resolve the per-target check set, with the fail-closed PROJECT-ROOT GUARD (Fix 1) and
   * the operator/repo-configured command set (Fix 2). The orchestrator wires the live
   * `resolveChecks` here. DEFAULT (tests / direct construction): the pnpm VERIFIER_CHECKS
   * with NO guard — so existing direct-construction callers are byte-unchanged.
   */
  readonly resolveChecks?: (worktreeReal: string) => ChecksResolution;
  /** Env source for IKBI_VERIFY / IKBI_CHECK_TIMEOUT_MS (tests inject). Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Explicit verification mode, set by the PRODUCTION wiring (`createProductionWorker` →
   * orchestrator) so production defaults to the HARDENED ladder. When set it WINS over env;
   * when omitted, the mode is env-derived with legacy as the bare-construction default
   * (so direct `createVerifier()` callers / existing tests are byte-unchanged). An explicit
   * `IKBI_VERIFY=legacy` is honored by the production resolver BEFORE this is computed.
   */
  readonly mode?: VerificationMode;
  /** Project-index for ladder mode. Default: the live `projectIndex` (built/refreshed per run). */
  readonly index?: { refresh: (repo: string) => Promise<{ data: ProjectIndexData }> };
  /** Verification planner for ladder mode. Default: the live `verificationLadder`. */
  readonly plan?: (req: { data: ProjectIndexData; changedFiles: string[] }) => VerificationPlan;
  /** Check-output triage for ladder mode. Default: the live `parseCheckOutput`. */
  readonly triage?: typeof parseCheckOutput;
}

/** Lazy live governed-exec — importing it eagerly would force the gate-wall/egress wiring order. */
function lazyGovernedExec(): Pick<GovernedExec, "run"> {
  return { run: async (req) => (await import("../governed-exec/index.js")).governedExec.run(req) };
}

/**
 * Extract written files from the builder's prior result and run quality checks.
 * Returns undefined when no builder result is available or no files were written
 * (quality checks are skipped — not a failure).
 */
function runQualityCheckFromPrior(
  priorResults: readonly RoleResult[],
  workspacePath: string,
): { result: QualityResult } | undefined {
  if (priorResults === undefined || priorResults.length === 0) return undefined;
  const builderResult = priorResults.find((r) => r.role === "builder");
  if (builderResult === undefined) return undefined;
  const detail = builderResult.detail as { filesWritten?: string[] } | undefined;
  const filesWritten = detail?.filesWritten;
  if (filesWritten === undefined || filesWritten.length === 0) return undefined;
  return { result: runQualityChecks(workspacePath, filesWritten) };
}

/**
 * The test-lifecycle script keys a stub can neuter. `pnpm test` runs `pretest` → `test` → `posttest`,
 * so a no-op in ANY of them is a forged-green vector: a stub `test` exits 0 without verifying, and a
 * `"pretest":"exit 0"`/`"posttest":"true"` is an explicit no-op planted on the same lifecycle.
 */
const STUB_GUARDED_SCRIPT_KEYS: readonly string[] = ["test", "pretest", "posttest"];

/** Directory names never worth walking when scanning a workspace for package.json files. */
const STUB_SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "out"]);

/**
 * Collect every package.json under `root` (bounded depth), skipping dependency/build/VCS dirs. A
 * monorepo's root `pnpm -r test` delegates to each subpackage, so a stub test in a SUBPACKAGE
 * passes vacuously the same way a root stub does — the guard must see them all, not just the root.
 */
function findWorkspacePackageJsons(root: string, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable / nonexistent dir — nothing to scan
    }
    for (const e of entries) {
      if (e.isFile() && e.name === "package.json") found.push(join(dir, e.name));
      else if (e.isDirectory() && depth < maxDepth && !STUB_SCAN_SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) {
        walk(join(dir, e.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

/**
 * LEGACY-MODE STUB GUARD: scan EVERY package.json in the workspace (root + subpackages) and report a
 * reason when a test-lifecycle script — `test`, `pretest`, or `posttest` — is a no-op stub (`echo …`,
 * `true`, `:`, `exit 0`, a `--passWithNoTests` flag). The ladder catches this via the planner's
 * isStubScript; legacy mode runs a fixed `pnpm test` and would let a greenfield `"test":"echo ok"`,
 * a subpackage `"test":"true"`, or a `"pretest":"exit 0"` neutering the real test pass with exit 0.
 * Returns undefined when no package.json declares a stubbed test-lifecycle script (only an actual
 * stub fails closed).
 */
function detectStubTestScript(workspacePath: string): string | undefined {
  for (const pkgPath of findWorkspacePackageJsons(workspacePath)) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      continue; // unparseable package.json is not a stub signal (checks already ran)
    }
    const scripts = (pkg as { scripts?: unknown })?.scripts;
    if (scripts === null || typeof scripts !== "object") continue;
    const s = scripts as Record<string, unknown>;
    for (const key of STUB_GUARDED_SCRIPT_KEYS) {
      const script = s[key];
      if (typeof script !== "string" || script.length === 0) continue;
      if (isStubScript(script)) {
        const where = relative(workspacePath, pkgPath) || "package.json";
        return `stub ${key} script ("${script}") in ${where} is not meaningful verification — refusing a vacuous green`;
      }
    }
  }
  return undefined;
}

/** The UNTRUSTED verdict — a mutated/unprovable build fails verification, fail-closed. */
function untrusted(reason: string): RoleResult {
  return { role: "verifier", outcome: "failure", summary: reason, detail: { verdict: "untrusted", reason, checks: [] } };
}

/** A RED verdict — no valid project to check (wrong repo / no manifest). Fail-closed, never a vacuous pass. */
function red(reason: string): RoleResult {
  return { role: "verifier", outcome: "failure", summary: reason, detail: { verdict: "fail", reason, checks: [] } };
}

// Files whose modification can weaken verification (neuter tsconfig strictness, exclude broken
// files, weaken test configs). jest/vitest/babel/webpack configs are JS (not JSON) — they cannot
// be semantically parsed, so they keep the conservative line-scan (ANY change flagged).
const GUARDED_CONFIG_PATTERNS = [
  /vitest\.config/,
  /jest\.config/,
  /\.babelrc/,
  /babel\.config/,
  /webpack\.config/,
  /vite\.config/,
];
const GUARD_TSCONFIG = /tsconfig.*\.json/;
// tsconfig compilerOptions (or root include/exclude) keys whose change can WEAKEN typechecking.
const WEAKENING_KEYS = [
  "strict", "skipLibCheck", "noEmit", "noImplicitAny", "noUnusedLocals",
  "noUnusedParameters", "exclude", "include", "moduleResolution",
  "noImplicitReturns", "noFallthroughCasesInSwitch", "strictNullChecks",
  "strictFunctionTypes", "strictBindCallApply",
];

/** One file's slice of a unified diff (split on `diff --git`), kept as raw text for the line-scan. */
interface DiffSection { readonly text: string; }
/** A file slice reconstructed into its old/new content (from context + −/＋ lines). */
interface SectionShape { readonly fileName: string; readonly isNewFile: boolean; readonly oldText: string; readonly newText: string; }
/** A per-file verdict: proven clean, can't-prove-semantically (defer to line-scan), or mutated. */
type SectionVerdict = "clean" | "indeterminate" | { mutated: true; reason: string };

/** Split a unified diff into one section per file (each begins at its `diff --git` header). */
function splitDiffByFile(diff: string): DiffSection[] {
  const sections: string[][] = [];
  let cur: string[] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur !== null) sections.push(cur);
      cur = [line];
    } else {
      if (cur === null) cur = [];
      cur.push(line);
    }
  }
  if (cur !== null) sections.push(cur);
  return sections.map((s) => ({ text: s.join("\n") }));
}

/**
 * Reconstruct a file section's OLD and NEW content from its diff lines: context lines feed both
 * sides, `-` lines feed old, `+` lines feed new. With a FULL-context diff (production wires
 * `git diff -U…`) the two sides are the complete files → JSON-parseable. With a partial hunk
 * (the unit-test fixtures) they are fragments → JSON.parse fails → caller defers to the line-scan.
 */
function analyzeSection(text: string): SectionShape {
  let fileName = "";
  let isNewFile = false;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m) fileName = m[2] ?? m[1] ?? "";
      continue;
    }
    if (line.startsWith("new file mode") || line.startsWith("--- /dev/null")) { isNewFile = true; continue; }
    if (line.startsWith("+++ ")) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m && m[1] !== undefined) fileName = m[1];
      continue;
    }
    if (
      line.startsWith("--- ") || line.startsWith("@@") || line.startsWith("index ") ||
      line.startsWith("old mode ") || line.startsWith("new mode ") || line.startsWith("deleted file mode ") ||
      line.startsWith("similarity ") || line.startsWith("rename ") || line.startsWith("copy ") || line.startsWith("\\")
    ) {
      continue;
    }
    if (line.startsWith("-")) { oldLines.push(line.slice(1)); continue; }
    if (line.startsWith("+")) { newLines.push(line.slice(1)); continue; }
    if (line.startsWith(" ")) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); continue; }
    // A bare line (no diff prefix) is shared context.
    oldLines.push(line); newLines.push(line);
  }
  return { fileName, isNewFile, oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

/** Parse text as a JSON OBJECT (not array/scalar); undefined when it isn't valid JSON. */
function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  const t = text.trim();
  if (t.length === 0) return undefined;
  try {
    const v: unknown = JSON.parse(t);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Coerce a value to a plain record (empty when it is not an object). */
function recordOf(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** The first guarded script key whose RESOLVED value differs between two package.json objects. */
function changedGuardedScript(oldPkg: Record<string, unknown>, newPkg: Record<string, unknown>): string | undefined {
  const o = recordOf(oldPkg.scripts);
  const n = recordOf(newPkg.scripts);
  for (const key of GUARDED_SCRIPT_KEYS) {
    if (o[key] !== n[key]) return key; // added, removed, or value-changed (string compare is exact)
  }
  return undefined;
}

/** The first weakening tsconfig key (compilerOptions first, then root for include/exclude) that changed. */
function changedWeakeningKey(oldCfg: Record<string, unknown>, newCfg: Record<string, unknown>): string | undefined {
  const oCo = recordOf(oldCfg.compilerOptions);
  const nCo = recordOf(newCfg.compilerOptions);
  for (const key of WEAKENING_KEYS) {
    const oVal = oCo[key] ?? oldCfg[key];
    const nVal = nCo[key] ?? newCfg[key];
    // exclude/include are arrays; the rest are scalars — JSON.stringify compares both structurally.
    if (JSON.stringify(oVal) !== JSON.stringify(nVal)) return key;
  }
  return undefined;
}

/**
 * JSON-SEMANTIC verdict for one file section. When both sides parse as JSON we compare the resolved
 * `scripts` / `compilerOptions` objects key-by-key — the truth the line-scan only approximates.
 * Returns "indeterminate" (defer to the line-scan) when the section is a partial hunk or a non-JSON
 * guarded config; "clean" when JSON proves no guarded change (this is what suppresses the
 * dependency-named-"build" false positive — the line-scan is NOT consulted for a clean parse).
 */
function semanticSectionVerdict(section: DiffSection): SectionVerdict {
  const s = analyzeSection(section.text);
  if (s.fileName === "") return "indeterminate";
  if (s.fileName.includes("node_modules/")) return "clean"; // builder-installed deps, not authored code
  if (s.isNewFile) return "clean"; // greenfield: a new file can't WEAKEN what didn't exist
  if (/(?:^|\/)package\.json$/.test(s.fileName)) {
    const oldPkg = tryParseJsonObject(s.oldText);
    const newPkg = tryParseJsonObject(s.newText);
    if (oldPkg === undefined || newPkg === undefined) return "indeterminate";
    const key = changedGuardedScript(oldPkg, newPkg);
    return key !== undefined ? { mutated: true, reason: `builder modified package.json script "${key}"` } : "clean";
  }
  if (GUARD_TSCONFIG.test(s.fileName)) {
    const oldCfg = tryParseJsonObject(s.oldText);
    const newCfg = tryParseJsonObject(s.newText);
    if (oldCfg === undefined || newCfg === undefined) return "indeterminate";
    const key = changedWeakeningKey(oldCfg, newCfg);
    return key !== undefined ? { mutated: true, reason: `builder modified tsconfig verification key "${key}" in ${s.fileName}` } : "clean";
  }
  return "indeterminate"; // vitest/jest/etc. (non-JSON) and everything else → line-scan
}

/**
 * LAYER-2 detector: does the workspace diff modify package.json's "scripts" surface (or weaken a
 * tsconfig / test config)? EXPORTED for unit tests. Fail-closed by design.
 *
 * TWO passes, JSON-semantic FIRST. For each file the semantic pass reconstructs the old/new content
 * and, when both parse as JSON, compares the resolved `scripts`/`compilerOptions` objects key-by-key.
 * This kills two line-scan failure modes:
 *   • FALSE POSITIVE — a dependency literally named "build"/"check" bumped on a version change (the
 *     line-scan sees the guarded key; the semantic compare sees it lives under dependencies, not scripts).
 *   • FALSE NEGATIVE — `"test":` and `"echo pass"` split onto SEPARATE lines (the line-scan key/value
 *     regex never matches; the parsed object still shows the changed value).
 * A file the semantic pass can't prove (partial hunk, or a non-JSON config) falls back to the legacy
 * line-scan, so existing partial-diff behavior is byte-unchanged.
 */
export function detectScriptMutation(diff: string): { mutated: boolean; reason?: string } {
  for (const section of splitDiffByFile(diff)) {
    const verdict = semanticSectionVerdict(section);
    if (verdict === "indeterminate") {
      const legacy = legacyDetectScriptMutation(section.text);
      if (legacy.mutated) return legacy;
    } else if (verdict !== "clean") {
      return verdict; // semantically proven mutation
    }
    // "clean": this file is semantically proven clean — do NOT consult the line-scan (that is exactly
    // what suppresses the dependency-named-"build" false positive).
  }
  return { mutated: false };
}

// Interpreter/shell-script extensions a guarded script may SHELL OUT to. A guarded script that runs
// one of these files is only as trustworthy as that file — if the build also modified it, the
// "passing" signal is forged the same way a rewritten package.json script would be.
const SCRIPT_FILE_EXTS: readonly string[] = [".sh", ".bash", ".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".py", ".rb"];

/**
 * Extract workspace-relative file paths a script SHELLS OUT to (e.g. `bash ./test.sh` → `test.sh`,
 * `node scripts/test.js` → `scripts/test.js`). A token is a file reference when it is not a flag,
 * not absolute, not under node_modules, and either contains a path separator OR ends in a known
 * interpreter/shell-script extension. `node --test` / `vitest run` yield NOTHING (flags / bare words).
 */
function extractScriptFilePaths(script: string): string[] {
  const out: string[] = [];
  // Split on whitespace and shell separators (; | & ( ) < >) so each token is a single argument.
  for (const raw of script.split(/[\s;|&()<>]+/)) {
    if (raw.length === 0 || raw.startsWith("-")) continue; // empty or a flag (e.g. --test)
    const unquoted = raw.replace(/^["']|["']$/g, "");
    if (unquoted.startsWith("/")) continue; // absolute path — not a workspace-relative file
    const norm = unquoted.replace(/^\.\//, ""); // normalize a leading ./
    if (norm.length === 0 || norm.includes("node_modules/")) continue;
    const hasSep = norm.includes("/");
    const hasScriptExt = SCRIPT_FILE_EXTS.some((e) => norm.toLowerCase().endsWith(e));
    if (hasSep || hasScriptExt) out.push(norm);
  }
  return out;
}

/**
 * LAYER-2 (second pass): a guarded script can stay BYTE-FOR-BYTE UNCHANGED in package.json yet still
 * be neutered if it SHELLS OUT to a file the build rewrote — `"test": "bash ./test.sh"` is clean, but
 * a `test.sh` rewritten to `exit 0` forges a passing signal exactly like a rewritten inline script.
 * detectScriptMutation only sees the package.json LINES, so it misses this. This pass reads the
 * workspace's CURRENT package.json (the scripts that will actually run), extracts each guarded
 * script's shell-referenced file paths, and flags the build if any of those paths was also modified
 * in the diff. EXPORTED for unit tests. Fail-closed by design; returns clean when there is no
 * package.json, no guarded script references a file, or no referenced file was touched.
 */
export function detectShellOutMutation(diff: string, workspacePath: string): { mutated: boolean; reason?: string } {
  const pkgPath = join(workspacePath, "package.json");
  if (!existsSync(pkgPath)) return { mutated: false };
  let scripts: Record<string, unknown>;
  try {
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    const s = (pkg as { scripts?: unknown })?.scripts;
    if (s === null || typeof s !== "object") return { mutated: false };
    scripts = s as Record<string, unknown>;
  } catch {
    return { mutated: false }; // unparseable package.json is not a shell-out signal
  }
  const changed = new Set(parseChangedFiles(diff));
  if (changed.size === 0) return { mutated: false };
  for (const key of GUARDED_SCRIPT_KEYS) {
    const val = scripts[key];
    if (typeof val !== "string" || val.length === 0) continue;
    for (const ref of extractScriptFilePaths(val)) {
      if (changed.has(ref)) {
        return { mutated: true, reason: `builder modified "${ref}", a file the guarded package.json script "${key}" shells out to` };
      }
    }
  }
  return { mutated: false };
}

/**
 * The legacy LINE-SCAN detector (fallback for partial hunks / non-JSON configs). Flags a changed
 * (added/removed) line that touches the "scripts" key, a guarded script entry, a tsconfig weakening
 * key, or any guarded JS config. Unchanged from the original whole-diff detector; the semantic pass
 * above only narrows WHEN it runs.
 */
function legacyDetectScriptMutation(diff: string): { mutated: boolean; reason?: string } {
  let inPackageJson = false;
  let isNewFile = false; // greenfield: file didn't exist in base
  let inGuardedConfig = false;
  let inTsconfig = false;
  let guardedConfigName = "";
  for (const line of diff.split("\n")) {
    // A new file section. `git diff` emits `diff --git a/<p> b/<p>` naming the file.
    if (line.startsWith("diff --git ")) {
      // Skip node_modules — builder-installed deps are not builder-authored code.
      if (line.includes("node_modules/")) { inPackageJson = false; inGuardedConfig = false; inTsconfig = false; continue; }
      inPackageJson = /(?:^|\/)package\.json(?:\s|$)/.test(line);
      inGuardedConfig = GUARDED_CONFIG_PATTERNS.some((p) => p.test(line));
      inTsconfig = GUARD_TSCONFIG.test(line);
      guardedConfigName = (inGuardedConfig || inTsconfig) ? line.replace(/.*b\//, "") : "";
      continue;
    }
    // The `+++ b/<p>` header also names the file (diffs without a `diff --git` line).
    if (line.startsWith("+++ ")) {
      if (/(?:^|\/)package\.json(?:\s|$)/.test(line)) inPackageJson = true;
      if (!inGuardedConfig && GUARDED_CONFIG_PATTERNS.some((p) => p.test(line))) {
        inGuardedConfig = true;
        guardedConfigName = line.replace(/.*b\//, "");
      }
      if (!inTsconfig && GUARD_TSCONFIG.test(line)) {
        inTsconfig = true;
        guardedConfigName = line.replace(/.*b\//, "");
      }
      continue;
    }
    if (line.startsWith("new file mode")) { isNewFile = true; continue; } // committed diff new-file marker (belt-and-suspenders with --- /dev/null)
    if (line.startsWith("--- /dev/null")) {
      isNewFile = true; // next +++ is a new file
      continue;
    }
    if (line.startsWith("--- ")) { isNewFile = false; continue; } // old-file header — not a content line
    // Guarded config file (vitest.config, jest.config, etc.): ANY change is flagged.
    // But NOT for new files — a new config can't weaken an existing one.
    if (inGuardedConfig && !isNewFile) {
      const changed = line.startsWith("+") || line.startsWith("-");
      if (changed) {
        return { mutated: true, reason: `builder modified verification config "${guardedConfigName}"` };
      }
    }
    // tsconfig: only flag changes to verification-WEAKENING keys.
    // But NOT for new files — a new tsconfig can't weaken an existing one.
    if (inTsconfig && !isNewFile) {
      const changed = line.startsWith("+") || line.startsWith("-");
      if (changed) {
        const body = line.slice(1);
        const keyMatch = /^\s*"([^"]+)"\s*:/.exec(body);
        if (keyMatch !== null && WEAKENING_KEYS.includes(keyMatch[1]!)) {
          return { mutated: true, reason: `builder modified tsconfig verification key "${keyMatch[1]}" in ${guardedConfigName}` };
        }
      }
    }
    if (!inPackageJson) continue;
    // Greenfield: package.json is a NEW file — scripts can't weaken what didn't exist.
    if (isNewFile) continue;
    // A CHANGED content line (added/removed) — not a header (`+++`/`---` handled above).
    const changed = line.startsWith("+") || line.startsWith("-");
    if (!changed) continue;
    const body = line.slice(1);
    if (/^\s*"scripts"\s*:/.test(body)) {
      return { mutated: true, reason: 'builder modified package.json "scripts"' };
    }
    const key = /^\s*"([A-Za-z0-9:_-]+)"\s*:/.exec(body);
    if (key !== null && GUARDED_SCRIPT_KEYS.includes(key[1]!)) {
      return { mutated: true, reason: `builder modified package.json script "${key[1]}"` };
    }
  }
  return { mutated: false };
}

/** Build a verifier. Tests inject fakes; the default wires the live governed-exec. */
export function createVerifier(deps: VerifierDeps = {}): RoleFn {
  const governedExec = deps.governedExec ?? lazyGovernedExec();
  return async (ctx) => {
    // ── LAYER 2: SCRIPT-INTEGRITY GUARD (MANDATORY, before ANY check) ─────────
    // The guard is not optional: WITHOUT the ability to inspect the diff the verifier
    // cannot prove the builder didn't rewrite package.json's scripts, so it cannot
    // safely verify. A missing diff capability fails closed EXACTLY like a diff read
    // failure — both return untrusted before any governed-exec call. (A guard that
    // silently disappears when its input is absent is not a guard.)
    if (deps.diff === undefined) {
      return untrusted("verification untrusted: script-integrity guard unavailable — no workspace diff source wired");
    }
    let diffText: string;
    try {
      diffText = await deps.diff(ctx.workspace);
    } catch (err) {
      // Cannot read the diff ⇒ cannot prove integrity ⇒ fail-closed UNTRUSTED.
      return untrusted(`verification untrusted: workspace diff unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
    const mutation = detectScriptMutation(diffText);
    if (mutation.mutated) {
      // The builder controls the test command — a passing result cannot be trusted and
      // must NOT feed the judge/promote. Do NOT run the mutated script as a real check.
      return untrusted(`verification untrusted: ${mutation.reason}`);
    }
    // SECOND PASS: a guarded script unchanged in package.json can still be neutered if it SHELLS OUT
    // to a file the build rewrote (`"test": "bash ./test.sh"` clean, but test.sh → `exit 0`). The
    // line/JSON guard above only inspects the package.json scripts, not the files they invoke.
    const shellOut = detectShellOutMutation(diffText, ctx.workspace.path);
    if (shellOut.mutated) {
      return untrusted(`verification untrusted: ${shellOut.reason}`);
    }

    // ── LAYER 1: GOVERNED CHECKS ──────────────────────────────────────────────
    // governed-exec needs a validated OperationContext (#10). Without it, fail closed.
    if (deps.parentCtx === undefined) {
      return untrusted("verifier not wired with an operation context — cannot run governed checks");
    }
    const parentCtx = deps.parentCtx;

    // ── LADDER MODE (opt-in: IKBI_VERIFY=ladder) ──────────────────────────────
    // Package/impact-aware verification. The script-integrity guard (above) has ALREADY run, so a
    // build that touched any package.json scripts is rejected before we read package scripts here.
    const env = deps.env ?? process.env;
    // Mode precedence: an explicit production `mode` wins; otherwise env-derived with legacy
    // as the bare-construction default (resolveVerificationMode(..., { production: false })).
    const verificationMode: VerificationMode = deps.mode ?? resolveVerificationMode(env, { production: false });
    if (verificationMode === "ladder") {
      return await runLadder(ctx, parentCtx, diffText, env);
    }

    // PROJECT-ROOT GUARD + per-target check set (Fix 1/2). Default (direct construction):
    // pnpm VERIFIER_CHECKS, no guard. The orchestrator wires the live resolver, which fails
    // closed RED when the worktree has no project of its own (so a no-manifest target can
    // NEVER pass vacuously by walking up into ikbi's workspace).
    const resolveChecks = deps.resolveChecks ?? ((): ChecksResolution => ({ ok: true, checks: VERIFIER_CHECKS, source: "default" }));
    const resolved = resolveChecks(ctx.workspace.path);
    if (!resolved.ok) return red(`verification RED: ${resolved.reason}`);
    const checkSet = resolved.checks;

    // SAME per-check budget as the ladder path and the builder's run_checks — without it the
    // legacy loop would inherit governed-exec's 30s read-only-tool default and SIGKILL real suites.
    const legacyCheckTimeoutMs = resolveCheckTimeoutMs(env);
    const checks: CheckResult[] = [];
    let sawDryRun = false;
    for (const c of checkSet) {
      // Accumulate the FULL stdout from the streaming sink: governed-exec retains only the bounded
      // tail, so a zero-test marker printed early in a verbose passing run is gone from stdoutTail.
      // mapExec parses the test tally from this full stream (robust), not the truncated tail.
      let fullStdout = "";
      const res = await governedExec.run({
        parentCtx,
        command: c.command,
        args: [...c.args],
        cwd: ctx.workspace.path,
        purpose: `verifier check: ${c.name}`,
        timeoutMs: legacyCheckTimeoutMs,
        // STREAMING path: a verbose suite emitting >maxBuffer (8MB) to stdout makes the buffered
        // execFile throw ENOBUFS → mapped to exit 1 → a FALSE RED on a passing build. The streaming
        // path caps CAPTURE at maxBuffer WITHOUT killing the process, so the real exit code survives.
        onOutput: (chunk, stream) => { if (stream === "stdout") fullStdout += chunk; },
      });
      const { check, dryRun } = mapExec(c.name, `${c.command} ${c.args.join(" ")}`, res, fullStdout);
      checks.push(check);
      sawDryRun = sawDryRun || dryRun;
    }

    // DRY-RUN: governed-exec executed nothing → report a dry-run verdict, NOT a pass
    // (and never a promote). Explicitly handled so "didn't run" is not mistaken for OK.
    if (sawDryRun) {
      return {
        role: "verifier",
        outcome: "stub",
        summary: "dry-run: governed checks reported intent, executed nothing",
        detail: { verdict: "dry-run", verificationMode, checks },
      };
    }

    // Triage: detect false-greens (zero tests, exit-swallowing) even in legacy mode.
    // This brings the legacy path to parity with the ladder and builder run_checks.
    const triaged = checks.map((c) => ({
      check: c,
      triage: parseCheckOutput({ name: c.name, command: c.command, exitCode: c.exitCode, stdout: c.outputTail, stderr: "" }),
    }));
    const allPass = triaged.every((t) => t.check.exitCode === 0 && t.triage.passed);
    const failed = triaged.filter((t) => !t.triage.passed).map((t) => t.check.name);

    // STUB-SCRIPT GUARD (legacy parity with the ladder): a greenfield "test":"echo ok" exits 0 and
    // would pass — but a no-op test script is not verification. Fail closed before declaring green.
    if (allPass) {
      const stubReason = detectStubTestScript(ctx.workspace.path);
      if (stubReason !== undefined) {
        return {
          role: "verifier",
          outcome: "failure",
          summary: `verification failed: ${stubReason}`,
          detail: { verdict: "fail", verificationMode, checks, reason: stubReason },
        };
      }
    }

    // QUALITY CHECKS: run AFTER typecheck + tests pass. Deterministic, fast, no model calls.
    // Extract written files from the builder's prior result (if available).
    if (allPass) {
      const quality = runQualityCheckFromPrior(ctx.priorResults, ctx.workspace.path);
      if (quality !== undefined && !quality.result.pass) {
        return {
          role: "verifier",
          outcome: "failure",
          summary: `quality checks failed: ${quality.result.issues.map((i) => i.kind).join(", ")}`,
          detail: { verdict: "fail", verificationMode, checks, qualityIssues: quality.result.issues },
        };
      }
    }

    return {
      role: "verifier",
      outcome: allPass ? "success" : "failure",
      summary: allPass ? "all checks passed" : `checks failed: ${failed.join(", ")}`,
      detail: { verdict: allPass ? "pass" : "fail", verificationMode, checks, ...(allPass ? { qualityPassed: true } : {}) },
    };

    // ── LADDER MODE implementation (hoisted; reached only when IKBI_VERIFY=ladder) ──────────
    async function runLadder(rctx: typeof ctx, pctx: OperationContext, diff: string, runEnv: NodeJS.ProcessEnv): Promise<RoleResult> {
      const worktree = rctx.workspace.path;
      const indexApi = deps.index ?? projectIndex;
      const planFn = deps.plan ?? ((r) => verificationLadder.planVerification(r));
      const triageFn = deps.triage ?? parseCheckOutput;
      // Invalid / non-positive ⇒ default; valid ⇒ CLAMPED (above MAX Node's setTimeout overflows
      // and fires ~immediately → every check SIGKILL'd → false RED). Shared with the builder.
      const checkTimeoutMs = resolveCheckTimeoutMs(runEnv);

      const configuredChecks = parseChecksEnv(runEnv.IKBI_CHECKS);
      if (configuredChecks === "malformed") {
        return red("verification RED (ladder): IKBI_CHECKS is malformed (expected a non-empty JSON array of {name,command,args}); fix IKBI_CHECKS or unset it to use ladder planning");
      }

      let plan: VerificationPlan;
      if (configuredChecks !== undefined) {
        plan = {
          status: "ok",
          blocked: false,
          blockReasons: [],
          scope: "full",
          escalateToFull: true,
          escalationReasons: ["operator-configured IKBI_CHECKS"],
          affectedPackages: [],
          affectedTests: [],
          neutralPackages: [],
          stubScripts: [],
          stages: [{
            stage: "full",
            tasks: configuredChecks.map((c) => ({
              package: "",
              cwd: "",
              name: c.name,
              command: c.command,
              args: c.args,
              scope: "full",
              reason: "operator-configured IKBI_CHECKS",
            })),
          }],
          receipts: ["IKBI_CHECKS override: running operator-configured checks as full verification"],
        };
      } else {
        let data: ProjectIndexData;
        try {
          data = (await indexApi.refresh(worktree)).data;
        } catch (e) {
          // Fail closed: without an index we cannot scope impact — RED, never a vacuous pass.
          return red(`verification RED (ladder): project-index unavailable — ${e instanceof Error ? e.message : String(e)}`);
        }

        let planningDiff = diff;
        if (deps.planningDiff !== undefined) {
          try {
            planningDiff = await deps.planningDiff(rctx.workspace);
          } catch (e) {
            return red(`verification RED (ladder): planning diff unavailable — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const changedFiles = parseChangedFiles(planningDiff);
        plan = planFn({ data, changedFiles });
      }
      const baseReceipts = [...plan.receipts, `check timeout: ${checkTimeoutMs}ms (per check, separate from the model role budget)`];

      if (plan.blocked) {
        return {
          role: "verifier", outcome: "failure",
          summary: `verification BLOCKED (scope ${plan.scope}): ${plan.blockReasons.join("; ")}`,
          detail: { verdict: "fail", verificationScope: plan.scope, blocked: true, blockReasons: plan.blockReasons, checks: [], stagesRun: [], neutralPackages: plan.neutralPackages, receipts: baseReceipts },
        };
      }

      const checks: CheckResult[] = [];
      const triages: Array<{ stage: string; name: string; package: string; passed: boolean; failures: readonly string[]; errorSummary: string; detectedFrameworks: readonly string[] }> = [];
      const stagesRun: string[] = [];
      const neutralNote = plan.neutralPackages.length > 0 ? [`neutral packages (no runnable check — NOT counted green): ${plan.neutralPackages.join(", ")}`] : [];

      for (const stage of plan.stages) {
        stagesRun.push(stage.stage);
        for (const task of stage.tasks) {
          if (task.blocking || task.command === "") {
            // Defensive: a blocking marker must never be run or passed. (Blocked plans return above.)
            return {
              role: "verifier", outcome: "failure",
              summary: `verification BLOCKED (scope ${plan.scope}): ${task.reason}`,
              detail: { verdict: "fail", verificationScope: plan.scope, blocked: true, blockReasons: [task.reason], checks, stagesRun, neutralPackages: plan.neutralPackages, receipts: [...baseReceipts, `BLOCKED at ${stage.stage}: ${task.reason}`] },
            };
          }
          const cmdStr = `${task.command} ${task.args.join(" ")}`;
          // Accumulate the FULL stdout (see the legacy loop): the bounded tail can drop an early
          // zero-test marker, so mapExec parses the tally from the whole stream, not the tail.
          let fullStdout = "";
          const res = await governedExec.run({
            parentCtx: pctx,
            command: task.command,
            args: [...task.args],
            cwd: task.cwd === "" ? worktree : join(worktree, task.cwd),
            purpose: `verifier[ladder:${task.scope}] ${task.name} (${task.package || "(root)"})`,
            timeoutMs: checkTimeoutMs,
            // STREAMING path (bounded capture, no kill) so a >maxBuffer verbose suite keeps its real
            // exit code instead of an ENOBUFS-induced false RED. See the legacy loop for the rationale.
            onOutput: (chunk, stream) => { if (stream === "stdout") fullStdout += chunk; },
          });
          const { check, dryRun } = mapExec(task.name, cmdStr, res, fullStdout);
          checks.push(check);
          if (dryRun) {
            return {
              role: "verifier", outcome: "stub",
              summary: "dry-run: governed checks reported intent, executed nothing",
              detail: { verdict: "dry-run", verificationScope: plan.scope, checks, stagesRun, neutralPackages: plan.neutralPackages, receipts: baseReceipts },
            };
          }
          const tr: CheckTriage = triageFn({ name: task.name, command: cmdStr, exitCode: check.exitCode, stdout: res.stdoutTail ?? "", stderr: res.stderrTail ?? "" });
          triages.push({ stage: stage.stage, name: task.name, package: task.package, passed: tr.passed, failures: tr.failures, errorSummary: tr.errorSummary, detectedFrameworks: tr.detectedFrameworks });
          if (!tr.passed) {
            // FAIL FAST — stop before any later stage/task.
            return {
              role: "verifier", outcome: "failure",
              summary: `verification FAILED (scope ${plan.scope}) at ${stage.stage}/${task.name}: ${tr.errorSummary}`,
              detail: {
                verdict: "fail", verificationMode, verificationScope: plan.scope, checks, triage: triages, stagesRun,
                neutralPackages: plan.neutralPackages, failedAt: { stage: stage.stage, task: task.name },
                receipts: [...baseReceipts, `ran stages: ${stagesRun.join(" → ")}`, `FAILED at ${stage.stage}/${task.name}: ${tr.errorSummary}`, ...neutralNote, ...tr.failures.slice(0, 10)],
              },
            };
          }
        }
      }

      // DEFENSE-IN-DEPTH (no vacuous green): a non-blocked plan that executed ZERO checks must NOT
      // pass. The planner guarantees ≥1 runnable task for a non-blocked plan, but the verifier does
      // not trust that cross-module invariant — fail closed if nothing actually ran.
      if (checks.length === 0) {
        return {
          role: "verifier", outcome: "failure",
          summary: `verification FAILED (scope ${plan.scope}): no verification checks ran — refusing a vacuous green`,
          detail: {
            verdict: "fail", verificationScope: plan.scope, checks: [], triage: triages, stagesRun,
            neutralPackages: plan.neutralPackages,
            receipts: [...baseReceipts, "FAILED: no runnable verification checks executed (refusing a vacuous green)", ...neutralNote],
          },
        };
      }

      // ALL runnable tasks passed — SCOPE-STAMPED green (never a plain "all checks passed").
      // QUALITY CHECKS: run AFTER typecheck + tests pass. Deterministic, fast, no model calls.
      const qualityLadder = runQualityCheckFromPrior(rctx.priorResults, worktree);
      if (qualityLadder !== undefined && !qualityLadder.result.pass) {
        return {
          role: "verifier", outcome: "failure",
          summary: `quality checks failed (scope ${plan.scope}): ${qualityLadder.result.issues.map((i) => i.kind).join(", ")}`,
          detail: {
            verdict: "fail", verificationMode, verificationScope: plan.scope, checks, triage: triages, stagesRun,
            neutralPackages: plan.neutralPackages, qualityIssues: qualityLadder.result.issues,
            receipts: [...baseReceipts, `ran stages: ${stagesRun.join(" → ")}`, `QUALITY FAILED: ${qualityLadder.result.issues.length} issue(s)`, ...qualityLadder.result.issues.map((i) => `  ${i.kind}: ${i.detail}`)],
          },
        };
      }

      return {
        role: "verifier", outcome: "success",
        summary: `verification PASSED for scope "${plan.scope}" — ran ${checks.length} check(s) across [${stagesRun.join(" → ")}]${plan.neutralPackages.length > 0 ? `; ${plan.neutralPackages.length} neutral package(s) recorded (not counted green)` : ""}`,
        detail: {
          verdict: "pass", verificationMode, verificationScope: plan.scope, checks, triage: triages, stagesRun,
          neutralPackages: plan.neutralPackages,
          receipts: [...baseReceipts, `ran stages: ${stagesRun.join(" → ")}`, ...neutralNote, `GREEN for scope: ${plan.scope}`],
        },
      };
    }
  };
}

/** The default verifier (live governed-exec; the orchestrator threads parentCtx + diff). */
export const verifier: RoleFn = createVerifier();
