/**
 * ikbi verification-ladder — the deterministic PLANNER.
 *
 * Pure: no process spawn, no model, no clock, no randomness, no IO. Given a project-index snapshot
 * and the changed files, it computes impact and emits an ordered ladder (nearest tests → package
 * checks → full). It is CONSERVATIVE: any uncertainty escalates to full verification, and a
 * required-but-underivable full stage BLOCKS the plan (never a passable empty stage).
 */

import { posix } from "node:path";

import type { PackageEntry, PackageManager, ProjectIndexData } from "../project-index/index.js";
import { RUNNABLE_SCRIPT_KEYS, SHARED_FILE_PATTERNS, verificationLadderConfig, type VerificationLadderConfig } from "./config.js";
import type { CheckStage, CheckTask, PlanRequest, VerificationLadderApi, VerificationPlan } from "./contract.js";

/** Managers where `<mgr> <script>` forwards to run-script WITHOUT the `run` keyword. pnpm and
 *  yarn (classic) both do this; npm does NOT (a non-lifecycle script needs `npm run <script>`).
 *  governed-exec BANS `<mgr> run …` (exec.ts:154), so emitting the shorthand for these managers is
 *  what lets a real `pnpm typecheck` / `pnpm build` pass the executor instead of being denied → RED. */
const SHORTHAND_RUN_MANAGERS = new Set<PackageManager>(["pnpm", "yarn"]);

/** `<manager> test` / `<manager> <script>` (shorthand for pnpm/yarn to avoid the banned `run`
 *  keyword; npm/unknown fall back to `<manager> run <script>`). */
function toCommand(manager: PackageManager, key: string): { command: string; args: string[] } {
  const m = manager === "unknown" ? "npm" : manager;
  if (key === "test") return { command: m, args: ["test"] };
  if (SHORTHAND_RUN_MANAGERS.has(manager)) return { command: m, args: [key] };
  return { command: m, args: ["run", key] };
}

/** The nearest enclosing package root for a file (longest match; "" matches all, lowest priority). */
function packageOf(relPath: string, rootsDescByLen: readonly string[]): string | undefined {
  for (const root of rootsDescByLen) {
    if (root === "") return ""; // only reached after all longer roots failed (sorted desc)
    if (relPath === root || relPath.startsWith(`${root}/`)) return root;
  }
  return undefined;
}

/**
 * A no-op / STUB verification script: empty, or a composition (via && ; ||) of only no-ops —
 * `echo …`, `true`, `:`, `exit 0`. These are NOT meaningful verification; they must never count as
 * green unless the operator explicitly trusts trivial scripts.
 */
/** Strip a trailing shell comment (`… # comment`) — `#` at start or after whitespace. */
function stripShellComment(s: string): string {
  return s.replace(/(^|\s)#.*$/, "$1").trim();
}

export function isStubScript(body: string): boolean {
  const s = stripShellComment(body);
  if (s.length === 0) return true;
  // F3: a "pass with no tests" flag lets a runner exit 0 with ZERO tests → trivially green → stub.
  if (/--pass-?with-?no-?(tests|empty-?test-?files)\b/i.test(s)) return true;
  const segments = s
    .split(/\s*(?:&&|\|\||;)\s*/)
    .map((x) => stripShellComment(x))
    .filter((x) => x.length > 0);
  if (segments.length === 0) return true;
  return segments.every((seg) => /^exit\s+0$/.test(seg) || seg === "true" || seg === ":" || /^echo(\s|$)/.test(seg));
}

/** Runnable script keys whose body is a stub (skipped unless trivial scripts are operator-trusted). */
function stubScriptKeys(pkg: PackageEntry): string[] {
  return RUNNABLE_SCRIPT_KEYS.filter((k) => {
    const s = pkg.scripts[k];
    return typeof s === "string" && s.length > 0 && isStubScript(s);
  });
}

/** The runnable checks a package offers, in priority order (empty ⇒ the package is neutral).
 *  A stub script is NOT runnable unless `trustTrivial` (operator opt-in) — a no-op is not evidence. */
function packageTasks(pkg: PackageEntry, scope: CheckTask["scope"], reason: string, trustTrivial: boolean): CheckTask[] {
  const tasks: CheckTask[] = [];
  for (const key of RUNNABLE_SCRIPT_KEYS) {
    const script = pkg.scripts[key];
    if (typeof script !== "string" || script.length === 0) continue;
    if (!trustTrivial && isStubScript(script)) continue; // suspicious: a no-op check is not verification
    const { command, args } = toCommand(pkg.manager, key);
    tasks.push({ package: pkg.root, cwd: pkg.root, name: key, command, args, scope, reason });
  }
  return tasks;
}

export function createVerificationLadder(cfg: VerificationLadderConfig = verificationLadderConfig): VerificationLadderApi {
  function planVerification(req: PlanRequest): VerificationPlan {
    const data: ProjectIndexData = req.data;
    const opts = req.opts ?? {};
    const trustTrivial = cfg.trustTrivialScripts === true;
    const receipts: string[] = [];
    const escalationReasons: string[] = [];

    // normalize changed files → repo-relative POSIX
    const changed = [...new Set(req.changedFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "")).filter((f) => f.length > 0))].sort();

    const byPath = new Map(data.files.map((f) => [f.path, f]));
    const packagesByRoot = new Map(data.packages.map((p) => [p.root, p]));
    const rootsDescByLen = data.packages.map((p) => p.root).sort((a, b) => b.length - a.length);

    // ── escalation signals (conservative: any one forces full) ───────────────────
    if (data.packages.length === 0) escalationReasons.push("the index has no packages — impact cannot be scoped");
    if (changed.length === 0) escalationReasons.push("no changed files supplied — impact cannot be scoped");
    if (data.truncated) escalationReasons.push("the project-index is truncated (incomplete) — impact may be wrong");
    // F2/A4: an incomplete import graph (ANY unresolved alias-shaped import — incl. extends/
    // per-package configs we couldn't fully load) means impact can't be trusted → escalate.
    if ((data.aliases?.unresolved ?? 0) > 0) {
      escalationReasons.push(`${data.aliases?.unresolved} unresolved path-alias import(s) — import graph has holes, impact cannot be trusted`);
    }
    if ((data.graphHoles?.unresolved ?? 0) > 0) {
      escalationReasons.push(`${data.graphHoles?.unresolved} unresolved non-code import graph hole(s) — impact cannot be trusted`);
    }
    if (opts.alwaysFull) escalationReasons.push("opts.alwaysFull is set");

    for (const f of changed) {
      if (SHARED_FILE_PATTERNS.some((re) => re.test(f))) escalationReasons.push(`shared/root file changed: ${f}`);
      // a package.json AT a package root is a manifest/scripts change ⇒ full
      const dir = posix.dirname(f) === "." ? "" : posix.dirname(f);
      if (posix.basename(f) === "package.json" && packagesByRoot.has(dir)) escalationReasons.push(`package manifest changed: ${f}`);
      if (packageOf(f, rootsDescByLen) === undefined) escalationReasons.push(`changed file is outside any package: ${f}`);
    }

    // ── impact: affected packages + affected tests (incl. reverse-import dependents) ──
    const affectedPackages = new Set<string>();
    for (const f of changed) {
      const pkg = packageOf(f, rootsDescByLen);
      if (pkg !== undefined) affectedPackages.add(pkg);
    }

    // reverse-import adjacency (to → importers)
    const importersOf = new Map<string, string[]>();
    for (const e of data.imports) {
      if (e.to === undefined) continue;
      (importersOf.get(e.to) ?? importersOf.set(e.to, []).get(e.to)!).push(e.from);
    }
    // cross-package importer signal
    for (const f of changed) {
      const fpkg = packageOf(f, rootsDescByLen);
      const otherPkgs = new Set<string>();
      for (const imp of importersOf.get(f) ?? []) {
        const ipkg = packageOf(imp, rootsDescByLen);
        if (ipkg !== undefined && ipkg !== fpkg) otherPkgs.add(ipkg);
      }
      if (otherPkgs.size > cfg.maxCrossPackage) escalationReasons.push(`${f} is imported across ${otherPkgs.size} other package(s) — change is cross-cutting`);
    }

    // BFS over reverse edges to collect dependents (bounded), then their tests.
    const dependents = new Set<string>(changed);
    let frontier = [...changed];
    for (let hop = 0; hop < cfg.maxImpactHops && dependents.size < cfg.maxImpactFiles; hop += 1) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const imp of importersOf.get(f) ?? []) {
          if (!dependents.has(imp)) {
            dependents.add(imp);
            next.push(imp);
            if (dependents.size >= cfg.maxImpactFiles) break;
          }
        }
        if (dependents.size >= cfg.maxImpactFiles) break;
      }
      frontier = next;
      if (frontier.length === 0) break;
    }
    // A7: if the reverse-dependent BFS truncated (hop or file cap with more to explore), the blast
    // radius is unbounded → cannot trust an impact-scoped pass → escalate to full.
    if (frontier.length > 0 || dependents.size >= cfg.maxImpactFiles) {
      escalationReasons.push("impact graph truncated (hop/file cap reached) — blast radius cannot be bounded");
    }

    const affectedTests = new Set<string>();
    for (const f of dependents) {
      if (byPath.get(f)?.isTest) affectedTests.add(f);
      for (const t of data.fileToTests[f] ?? []) affectedTests.add(t);
    }

    // ── build stage tasks ─────────────────────────────────────────────────────────
    const affectedPkgList = [...affectedPackages].sort();
    const neutralPackages: string[] = [];
    const runnablePkgs: PackageEntry[] = [];
    const stubScripts: string[] = [];
    for (const root of affectedPkgList) {
      const pkg = packagesByRoot.get(root);
      if (pkg === undefined) continue;
      for (const k of stubScriptKeys(pkg)) stubScripts.push(`${root || "(root)"}:${k}`);
      if (packageTasks(pkg, "package", "", trustTrivial).length === 0) neutralPackages.push(root);
      else runnablePkgs.push(pkg);
    }
    // F1: a stub verification script is not meaningful evidence (recorded; never counted green).
    if (!trustTrivial && stubScripts.length > 0) {
      escalationReasons.push(`stub/no-op verification script(s) detected (${stubScripts.join(", ")}) — not meaningful verification`);
    }
    // all affected packages neutral (no runnable checks) ⇒ a local pass would be vacuous ⇒ escalate
    if (affectedPkgList.length > 0 && runnablePkgs.length === 0) {
      escalationReasons.push("no affected package has a runnable check (test/typecheck/build) — a scoped pass would be vacuous");
    }

    // nearest-tests: per package that has a NON-STUB test script AND affected tests within it
    const nearest: CheckTask[] = [];
    for (const pkg of runnablePkgs) {
      if (typeof pkg.scripts.test !== "string" || pkg.scripts.test.length === 0) continue;
      if (!trustTrivial && isStubScript(pkg.scripts.test)) continue;
      const testsInPkg = [...affectedTests].filter((t) => packageOf(t, rootsDescByLen) === pkg.root).sort();
      if (testsInPkg.length === 0) continue;
      const { command, args } = toCommand(pkg.manager, "test");
      nearest.push({ package: pkg.root, cwd: pkg.root, name: "test", command, args, scope: "nearest", reason: `nearest tests for changed files in ${pkg.root || "(root)"}`, targets: testsInPkg });
    }

    // package-checks: every runnable affected package's checks
    const packageChecks = runnablePkgs.flatMap((pkg) => packageTasks(pkg, "package", `package checks for ${pkg.root || "(root)"}`, trustTrivial));

    const escalateToFull = escalationReasons.length > 0;

    // full-stage tasks: operator override, else the ROOT package's checks
    let fullTasks: CheckTask[] = [];
    if (opts.fullChecks !== undefined && opts.fullChecks.length > 0) {
      fullTasks = opts.fullChecks.map((c) => ({ package: "", cwd: "", name: c.name, command: c.command, args: [...c.args], scope: "full" as const, reason: "operator-configured full check" }));
    } else {
      const rootPkg = packagesByRoot.get("");
      if (rootPkg !== undefined) fullTasks = packageTasks(rootPkg, "full", "full-repo verification (root package)", trustTrivial);
    }

    // ── assemble (fail-closed on required-but-underivable full) ───────────────────
    const stages: CheckStage[] = [];
    if (nearest.length > 0) stages.push({ stage: "nearest-tests", tasks: nearest });
    if (packageChecks.length > 0) stages.push({ stage: "package-checks", tasks: packageChecks });

    let blocked = false;
    const blockReasons: string[] = [];
    const scope: VerificationPlan["scope"] = escalateToFull ? "full" : "impact";

    if (escalateToFull) {
      if (fullTasks.length > 0) {
        stages.push({ stage: "full", tasks: fullTasks });
      } else {
        // HARD INVARIANT: full is required but no runnable full check exists. Do NOT emit an empty
        // (vacuously-green) full stage. Emit a non-runnable BLOCKING marker and block the plan.
        blocked = true;
        const stubNote = stubScripts.length > 0 ? ` (stub/no-op script(s) not counted: ${stubScripts.join(", ")})` : "";
        const why = `full verification is REQUIRED (${escalationReasons.join("; ")}) but no runnable full-repo checks could be derived (set IKBI_CHECKS to specify verification commands, or the root package needs a real test/typecheck/build script)${stubNote}`;
        blockReasons.push(why);
        stages.push({
          stage: "full",
          tasks: [{ package: "", cwd: "", name: "verification-unavailable", command: "", args: [], scope: "full", reason: why, blocking: true }],
        });
        receipts.push("BLOCKED: " + why);
      }
    }

    // receipts (decision trail)
    receipts.push(`changed files: ${changed.length}`);
    receipts.push(`affected packages: ${affectedPkgList.length > 0 ? affectedPkgList.join(", ") : "(none)"}`);
    if (neutralPackages.length > 0) receipts.push(`neutral packages (no runnable check, never counted green): ${neutralPackages.join(", ")}`);
    if (stubScripts.length > 0) receipts.push(`stub/no-op scripts (NOT counted as verification): ${stubScripts.join(", ")}`);
    receipts.push(`affected tests: ${affectedTests.size}`);
    receipts.push(escalateToFull ? `escalated to FULL: ${escalationReasons.join("; ")}` : "scope is IMPACT (local change, no escalation signal)");
    receipts.push(`scope: ${scope}; status: ${blocked ? "blocked" : "ok"}`);

    return {
      status: blocked ? "blocked" : "ok",
      blocked,
      blockReasons,
      scope,
      escalateToFull,
      escalationReasons,
      affectedPackages: affectedPkgList,
      affectedTests: [...affectedTests].sort(),
      neutralPackages: neutralPackages.sort(),
      stubScripts: stubScripts.sort(),
      stages,
      receipts,
    };
  }

  return { planVerification };
}

/** The process-wide planner (default config). */
export const verificationLadder: VerificationLadderApi = createVerificationLadder();
