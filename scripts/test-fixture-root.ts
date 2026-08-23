/**
 * The test runner's fixture-root command surface.
 *
 * The bash wrapper cannot safely read `/proc`, parse an ownership record and decide whether a
 * directory may be deleted — every one of those in shell is a `rm -rf` waiting for an unset
 * variable. So the wrapper calls this, and the destructive decisions stay in one typed place
 * with a suite behind it (`src/test-support/fixture-root.ts`).
 *
 *   preflight  reap provably-dead roots, then refuse to start if inode headroom is too thin
 *   create     make this run's root and print its path (the wrapper exports it as TMPDIR)
 *   census     report what is under the base and why each root is retained
 *   survivors  after a run: prove this run's root is gone and nothing of its own remains
 *   remove     delete exactly one verified run root
 *   guard      refuse to run when a test creates fixtures under a hard-coded /tmp
 *   base       print the resolved fixture base (captured before TMPDIR is redirected)
 *
 * Exit codes are meaningful: 0 proceed, 1 refuse. The wrapper treats a refusal as fatal, which
 * is the point — running a suite that is about to exhaust the filesystem's inodes produces
 * hundreds of "failures" that are nothing of the sort, and that misdiagnosis is what this
 * whole mechanism exists to prevent.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  FIXTURE_RECORDS_DIRNAME,
  baseFingerprint,
  censusRunRoots,
  countEntries,
  createRunRoot,
  parseDfInodes,
  reapStaleRunRoots,
  readOwnershipRecord,
  removeOwnedRunRoot,
  resolveFixtureBase,
  type InodeUsage,
} from "../src/test-support/fixture-root.js";

/** Below this many free inodes the run is refused rather than started and misdiagnosed. */
const DEFAULT_MIN_FREE_INODES = 200_000;
/** …or below this fraction free, whichever bites first, for small filesystems. */
const DEFAULT_MIN_FREE_FRACTION = 0.1;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function arg(name: string, argv: readonly string[]): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Inode usage for the filesystem holding `path`, via `df -i -P`. */
function inodeUsage(path: string): InodeUsage | undefined {
  const probe = spawnSync("df", ["-i", "-P", path], { encoding: "utf8" });
  if (probe.status !== 0 || typeof probe.stdout !== "string") return undefined;
  return parseDfInodes(probe.stdout);
}

function reportUsage(label: string, path: string): InodeUsage | undefined {
  const usage = inodeUsage(path);
  if (usage === undefined) {
    out(`# inodes ${label}=unavailable path=${path}`);
    return undefined;
  }
  if (usage.total === 0) {
    out(`# inodes ${label} fs=${usage.filesystem} allocation=dynamic (no fixed budget)`);
    return usage;
  }
  out(`# inodes ${label} fs=${usage.filesystem} used=${usage.used} free=${usage.free} total=${usage.total} used_pct=${usage.usedPercent.toFixed(1)}`);
  return usage;
}

// ---------------------------------------------------------------------------
// guard — no test may create fixtures under a hard-coded /tmp
// ---------------------------------------------------------------------------

/**
 * Filesystem calls that CREATE something. A `/tmp` literal that is merely inert data — a fake
 * path in an assertion, a workspace record in a fixture object — is not a leak and is not
 * flagged; only a literal handed to one of these is.
 */
const CREATING_CALL = /\b(mkdtemp|mkdtempSync|mkdir|mkdirSync|writeFile|writeFileSync|appendFile|appendFileSync|cp|cpSync|copyFile|copyFileSync|open|openSync|createWriteStream|rename|renameSync)\s*\(\s*(?:join\s*\(\s*)?["'`]\/tmp/;

function testFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
        walk(path);
      } else if (entry.name.endsWith(".test.ts")) {
        found.push(path);
      }
    }
  };
  walk(root);
  return found.sort();
}

function commandGuard(repoRoot: string): number {
  const offenders: string[] = [];
  for (const file of testFiles(join(repoRoot, "src"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (CREATING_CALL.test(line)) offenders.push(`${relative(repoRoot, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  if (offenders.length > 0) {
    out(`# REFUSE ${offenders.length} test site(s) create fixtures under a hard-coded /tmp instead of os.tmpdir()`);
    for (const o of offenders) out(`#   ${o}`);
    out("# fixtures must use os.tmpdir() (which the runner points at the per-run root) or the shared helper in src/test-support/fixture-root.ts");
    return 1;
  }
  out("# guard ok — every test fixture resolves through os.tmpdir()");
  return 0;
}

// ---------------------------------------------------------------------------
// preflight — reap the provably dead, then check headroom
// ---------------------------------------------------------------------------

/**
 * Refuse a fixture base that sits inside a git working tree.
 *
 * Learned the hard way. A base on a roomy filesystem turned out to be inside a repository,
 * so every fixture directory was inside a git working tree — and 29 suites that assert
 * "this directory is NOT a git repository" failed, because `git rev-parse` happily found the
 * ancestor. Those failures look exactly like product defects and are nothing of the kind.
 * The condition is cheap to detect and impossible to debug by reading a TAP log, so it is
 * checked here rather than discovered again.
 */
function gitAncestorOf(path: string): string | undefined {
  let probe = path;
  while (!existsSync(probe)) {
    const parent = resolve(probe, "..");
    if (parent === probe) return undefined;
    probe = parent;
  }
  const result = spawnSync("git", ["-C", probe, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const top = result.stdout.trim();
  return top.length > 0 ? top : undefined;
}

function commandPreflight(base: string, argv: readonly string[]): number {
  out(`# fixture base=${base} fingerprint=${baseFingerprint(base)}`);

  // A base OUTSIDE the ambient temp directory is legal but has a sharp edge worth naming.
  // governed-exec's sandbox `--ro-bind`s `/` and overlays a fresh tmpfs at `/tmp`, so a fixture
  // (and the HOME a suite derives from it) under `/tmp` is writable inside the sandbox while one
  // under, say, `/var/tmp` is READ-ONLY there. Suites whose checks run `pnpm` then fail for want
  // of a writable cache, and the failure looks like a verifier defect. Not a refusal — the base
  // is deliberately configurable — but never a silent surprise either.
  if (!resolve(base).startsWith(resolve(tmpdir()))) {
    out(`# WARN the fixture base is outside ${tmpdir()}`);
    out("# the exec sandbox overlays a private tmpfs on /tmp and read-only-binds the rest of the");
    out("# filesystem, so sandboxed checks that need a writable HOME under the fixture base will fail");
  }

  const repo = gitAncestorOf(base);
  if (repo !== undefined) {
    out(`# REFUSE the fixture base is inside the git working tree at ${repo}`);
    out("# every fixture would then be inside a repository, and suites that assert a directory is NOT");
    out("# a git repo fail for a reason that has nothing to do with the code under test");
    out("# point IKBI_TEST_FIXTURE_BASE at a directory outside any git working tree");
    return 1;
  }
  const before = reportUsage("preflight_before", existsSync(base) ? base : resolve(base, ".."));

  const report = reapStaleRunRoots({ base });
  out(`# reap examined=${report.examined} reaped=${report.reaped.length} retained=${report.retained.length} entries_freed=${report.entriesFreed}`);
  for (const r of report.reaped) {
    // Evidence for a root whose owner never got to run its own cleanup — typically SIGKILL.
    out(`#   reaped run=${r.runId} entries=${r.entryCount}${r.ageMs !== undefined ? ` age_ms=${r.ageMs}` : ""} reason=${r.reason}`);
  }
  for (const r of report.retained) out(`#   retained ${r.disposition} entries=${r.entryCount} path=${r.path} reason=${r.reason}`);
  for (const f of report.failures) out(`#   reap_failed path=${f.path} error=${f.error}`);

  const after = existsSync(base) ? reportUsage("preflight_after", base) : before;
  const usage = after ?? before;
  if (usage === undefined) {
    out("# preflight: inode usage unavailable — proceeding without a headroom guarantee");
    return 0;
  }

  // btrfs and xfs allocate inodes dynamically and report a total of 0. There is no fixed
  // budget to run out of, so there is no floor to enforce — saying "0 free" would be a
  // frightening and false way to describe a filesystem that cannot exhaust inodes at all.
  if (usage.total === 0) {
    out(`# preflight ok inodes=dynamic (${usage.filesystem} reports no fixed inode budget)`);
    return 0;
  }

  const minFree = Number(arg("min-free-inodes", argv) ?? DEFAULT_MIN_FREE_INODES);
  const fractionFree = usage.free / usage.total;
  if (usage.free < minFree && fractionFree < DEFAULT_MIN_FREE_FRACTION) {
    out(`# REFUSE inode headroom too thin: ${usage.free} free (${(fractionFree * 100).toFixed(1)}%) on ${usage.filesystem}`);
    out(`# a run started here would fail with ENOSPC and report those failures as test failures`);
    out(`# free inodes on ${usage.filesystem}, or point IKBI_TEST_FIXTURE_BASE at a filesystem with headroom`);
    return 1;
  }
  out(`# preflight ok free_inodes=${usage.free} floor=${minFree}`);
  return 0;
}

// ---------------------------------------------------------------------------
// create / remove / census / survivors
// ---------------------------------------------------------------------------

function commandCreate(base: string, argv: readonly string[]): number {
  const runId = arg("run-id", argv);
  const ownerPidRaw = arg("owner-pid", argv);
  const ownerPid = ownerPidRaw !== undefined ? Number(ownerPidRaw) : undefined;
  if (ownerPid !== undefined && !Number.isInteger(ownerPid)) {
    out(`# REFUSE --owner-pid must be an integer (got ${String(ownerPidRaw)})`);
    return 1;
  }
  const handle = createRunRoot({
    base,
    ...(runId !== undefined ? { runId } : {}),
    ...(ownerPid !== undefined ? { ownerPid } : {}),
  });
  // The ONLY thing on stdout that is not a comment: the wrapper reads this as TMPDIR.
  out(handle.path);
  return 0;
}

function commandRemove(base: string, argv: readonly string[]): number {
  const root = arg("root", argv);
  const runId = arg("run-id", argv);
  if (root === undefined || runId === undefined) {
    out("# REFUSE remove requires --root and --run-id");
    return 1;
  }
  if (!existsSync(root) && readOwnershipRecord(base, runId) === undefined) {
    out(`# remove: ${root} is already gone`);
    return 0;
  }
  try {
    const result = removeOwnedRunRoot({ base, rootPath: root, runId });
    if (!result.ok) {
      out(`# REFUSE ${result.reason}`);
      return 1;
    }
    out(`# removed run=${runId} entries=${result.entryCount} path=${root}`);
    return 0;
  } catch (err) {
    // Reported, never swallowed: a cleanup that silently failed is how a root survived a run
    // and then could not explain itself.
    out(`# FAIL could not remove ${root}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function commandCensus(base: string): number {
  const census = censusRunRoots(base);
  out(`# census base=${base} roots=${census.length}`);
  for (const entry of census) {
    out(`#   ${entry.classification.disposition} entries=${entry.entryCount} run=${entry.record?.runId ?? "(none)"} path=${entry.path} reason=${entry.classification.reason}`);
  }
  return 0;
}

/**
 * After a run: prove this run left nothing behind.
 *
 * Two separate claims, because they fail for different reasons: the run's own root is gone
 * (the wrapper's cleanup really ran), and no OTHER root belonging to this run id survived
 * anywhere under the base (nothing escaped containment).
 */
function commandSurvivors(base: string, argv: readonly string[]): number {
  const runId = arg("run-id", argv);
  const root = arg("root", argv);
  if (runId === undefined) {
    out("# REFUSE survivors requires --run-id");
    return 1;
  }

  let failed = false;
  if (root !== undefined && existsSync(root)) {
    out(`# FAIL this run's fixture root survived cleanup: ${root} (${countEntries(root)} entries)`);
    failed = true;
  }

  if (readOwnershipRecord(base, runId) !== undefined) {
    out(`# FAIL this run's ownership record was not collected`);
    failed = true;
  }

  const census = censusRunRoots(base);
  for (const entry of census.filter((e) => e.record?.runId === runId)) {
    out(`# FAIL survivor fixture root owned by this run: ${entry.path} (${entry.entryCount} entries)`);
    failed = true;
  }

  // An UNCLAIMED directory under the base means a fixture escaped its run root, or a run
  // died before its record landed. Either way the next run inherits it, so say so — but a
  // root claimed by ANOTHER run is a parallel runner and is none of our business.
  for (const entry of census) {
    if (entry.record === undefined && !entry.path.endsWith(FIXTURE_RECORDS_DIRNAME)) {
      out(`# WARN unclaimed directory under the fixture base: ${entry.path} (${entry.entryCount} entries)`);
    }
  }

  if (failed) return 1;
  out(`# survivors ok run=${runId} — no owned fixture root remains`);
  return 0;
}

// ---------------------------------------------------------------------------

function main(): number {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "";
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  const base = arg("base", argv) ?? resolveFixtureBase();

  switch (command) {
    case "guard":
      return commandGuard(repoRoot);
    case "preflight":
      return commandPreflight(base, argv);
    case "create":
      return commandCreate(base, argv);
    case "remove":
      return commandRemove(base, argv);
    case "census":
      return commandCensus(base);
    case "survivors":
      return commandSurvivors(base, argv);
    case "base":
      // Printed bare so the wrapper can capture it before TMPDIR is redirected.
      out(base);
      return 0;
    case "inodes":
      return reportUsage("current", existsSync(base) ? base : resolve(base, "..")) === undefined ? 1 : 0;
    default:
      out("usage: test-fixture-root.ts <guard|preflight|create|remove|census|survivors|inodes|base> [--base <dir>] [--run-id <id>] [--owner-pid <pid>] [--root <dir>]");
      return 1;
  }
}

process.exit(main());
