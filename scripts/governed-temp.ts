/**
 * THE GOVERNED TEMPORARY-ROOT COMMAND SURFACE.
 *
 * The bash wrapper cannot safely read `/proc`, parse an ownership record and decide whether a
 * directory may be deleted — each of those in shell is a `rm -rf` waiting for an unset variable.
 * So the wrapper calls this, and every destructive decision stays in one typed place with
 * `src/core/temp-root.ts` behind it.
 *
 *   guard      REFUSE to run when any source file reaches for /tmp or the platform temp directory
 *   preflight  validate the governed root, reap provably-dead children, check headroom
 *   root       print the resolved governed root (captured before TMPDIR is redirected)
 *   create     make this run's child and print its path
 *   census     report what is under the root and why each child is retained
 *   survivors  after a run: prove this run's child is gone and nothing of its own remains
 *   remove     delete exactly one verified child
 *   sentinel   FAIL if anything ikbi-owned appeared under /tmp during the run
 *
 * Exit codes are meaningful: 0 proceed, 1 refuse.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  TEMP_RECORDS_DIRNAME,
  TEMP_ROOT_ENV,
  censusChildren,
  countEntries,
  createTempChild,
  headroomOf,
  readOwnershipRecord,
  reapTempChildren,
  removeOwnedChild,
  resolveTempRoot,
  rootFingerprint,
} from "../src/core/temp-root.js";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function arg(name: string, argv: readonly string[]): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);

// ---------------------------------------------------------------------------
// guard — the repository-wide structural rule
// ---------------------------------------------------------------------------

/**
 * The ONLY files permitted to name the system temp directory.
 *
 * `temp-root.ts` names it in order to REFUSE it, and `sandbox.ts` masks it with a private tmpfs so
 * that a third-party tool hard-coding an absolute `/tmp/x` writes into an ephemeral filesystem
 * that never touches the host. Both are the rule being enforced, not exceptions to it; their
 * suites are allowed to assert on that behaviour.
 */
const TMP_LITERAL_ALLOWLIST = new Set([
  "src/core/temp-root.ts",
  "src/core/temp-root.test.ts",
  "src/modules/governed-exec/sandbox.ts",
  "src/modules/governed-exec/sandbox.test.ts",
  "scripts/governed-temp.ts",
]);

/**
 * Only the authority may reach the platform temp directory — plus this guard, whose refusal
 * MESSAGES have to be able to name the thing they refuse.
 */
const TMPDIR_IMPORT_ALLOWLIST = new Set(["src/core/temp-root.ts", "scripts/governed-temp.ts"]);

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
        walk(path);
      } else if (/\.(ts|tsx|mts|cts|js|mjs|sh)$/.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const dir of ["src", "scripts"]) {
    const abs = join(REPO_ROOT, dir);
    if (existsSync(abs)) walk(abs);
  }
  return found.sort();
}

function commandGuard(): number {
  const offenders: string[] = [];

  for (const file of sourceFiles()) {
    const rel = relative(REPO_ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");

    lines.forEach((line, i) => {
      const at = `${rel}:${i + 1}`;
      // COMMENTS ARE PROSE, and prose does not execute. Explaining the rule — "never /tmp",
      // "use labTempDir instead of os.tmpdir()" — must not trip the rule, or the only way to
      // document it would be to not document it. A line whose first non-space characters open a
      // comment is skipped; a trailing comment on a code line is still scanned, which is the
      // conservative side to err on.
      if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) return;

      // 1. ANY mention of the system temp directory, outside the two files that exist to refuse
      //    and mask it. Absolute, so there is no judgement call about "inert" versus "used" —
      //    a literal that is inert today is one edit away from being a path tomorrow.
      if (!TMP_LITERAL_ALLOWLIST.has(rel) && /(^|[^A-Za-z0-9_/-])\/tmp($|[^A-Za-z0-9_-])/.test(line)) {
        offenders.push(`${at}: names /tmp — ${line.trim().slice(0, 100)}`);
      }

      // 2. The platform temp directory, by any route.
      if (!TMPDIR_IMPORT_ALLOWLIST.has(rel)) {
        if (/from\s+"node:os"/.test(line) && /\btmpdir\b/.test(line)) {
          offenders.push(`${at}: imports tmpdir from node:os — use labTempDir from src/core/temp-root.ts`);
        }
        if (/\bos\.tmpdir\s*\(/.test(line) || /require\(\s*["']node:os["']\s*\)\.tmpdir/.test(line)) {
          offenders.push(`${at}: calls os.tmpdir() — use labTempDir from src/core/temp-root.ts`);
        }
      }

      // 3. Shell fallbacks. `${TMPDIR:-/tmp}` is the classic way /tmp creeps back in.
      if (!TMP_LITERAL_ALLOWLIST.has(rel) && /\$\{(TMPDIR|TMP|TEMP):-/.test(line)) {
        offenders.push(`${at}: falls back to a default temp directory — require IKBI_TEMP_ROOT instead`);
      }
    });
  }

  if (offenders.length > 0) {
    out(`# REFUSE ${offenders.length} site(s) reach for the system temporary directory`);
    for (const o of offenders.slice(0, 40)) out(`#   ${o}`);
    if (offenders.length > 40) out(`#   … and ${offenders.length - 40} more`);
    out("# the lab rule is absolute: no ikbi code uses /tmp. Resolve scratch through");
    out("# `labTempDir()` in src/core/temp-root.ts, which has no fallback to the platform temp dir.");
    return 1;
  }
  out(`# guard ok — no source file reaches for /tmp or os.tmpdir() (${sourceFiles().length} files scanned)`);
  return 0;
}

// ---------------------------------------------------------------------------
// sentinel — nothing ikbi-owned may appear under /tmp
// ---------------------------------------------------------------------------

/** Names that would indicate ikbi scratch escaped to the system temp directory. */
const IKBI_TMP_PATTERN = /^(ikbi|gsd-|bokplan-|ax-home-|crcb-)/;

function ikbiOwnedTmpEntries(): string[] {
  const systemTmp = ["/", "tmp"].join("");
  try {
    return readdirSync(systemTmp).filter((n) => IKBI_TMP_PATTERN.test(n)).sort();
  } catch {
    return [];
  }
}

function commandSentinel(argv: readonly string[]): number {
  const baselineRaw = arg("baseline", argv);
  const now = ikbiOwnedTmpEntries();
  if (baselineRaw === undefined) {
    // Record mode: print the baseline for the caller to hand back afterwards.
    out(now.join(","));
    return 0;
  }
  const before = new Set(baselineRaw.split(",").filter((s) => s.length > 0));
  const appeared = now.filter((n) => !before.has(n));
  if (appeared.length > 0) {
    out(`# FAIL ${appeared.length} ikbi-owned path(s) appeared under the system temp directory during this run:`);
    for (const a of appeared) out(`#   ${a}`);
    out("# something bypassed the governed temporary root. That is the lab rule, violated.");
    return 1;
  }
  out(`# sentinel ok — no ikbi-owned path appeared under the system temp directory (${now.length} pre-existing, unchanged)`);
  return 0;
}

// ---------------------------------------------------------------------------
// preflight / root / create / remove / census / survivors
// ---------------------------------------------------------------------------

function requireRoot(): string | undefined {
  const resolution = resolveTempRoot();
  if (!resolution.ok) {
    out(`# REFUSE ${resolution.detail}`);
    return undefined;
  }
  return resolution.root;
}

function commandPreflight(argv: readonly string[]): number {
  const resolution = resolveTempRoot();
  if (!resolution.ok) {
    out(`# REFUSE ${resolution.detail}`);
    for (const r of resolution.rejected) out(`#   rejected ${r.candidate}: ${r.code} — ${r.detail}`);
    return 1;
  }
  const root = resolution.root;
  out(`# temp root=${root} source=${resolution.source} fingerprint=${rootFingerprint(root)}`);

  const room = headroomOf(existsSync(root) ? root : resolve(root, ".."));
  if (room !== undefined) {
    out(`# headroom free_bytes=${room.freeBytes} free_inodes=${room.freeInodes ?? "dynamic"}`);
  }

  const report = reapTempChildren({ root });
  out(`# reap examined=${report.examined} reaped=${report.reaped.length} retained=${report.retained.length} entries_freed=${report.entriesFreed}`);
  for (const r of report.reaped) out(`#   reaped run=${r.runId} purpose=${r.purpose} entries=${r.entryCount}${r.ageMs !== undefined ? ` age_ms=${r.ageMs}` : ""} reason=${r.reason}`);
  for (const r of report.retained) out(`#   retained ${r.disposition} entries=${r.entryCount} path=${r.path} reason=${r.reason}`);
  for (const f of report.failures) out(`#   reap_failed path=${f.path} error=${f.error}`);
  if (report.failures.length > 0 && arg("strict", argv) !== undefined) return 1;

  out("# preflight ok");
  return 0;
}

function commandCreate(argv: readonly string[]): number {
  const root = requireRoot();
  if (root === undefined) return 1;
  const runId = arg("run-id", argv);
  const ownerPidRaw = arg("owner-pid", argv);
  const ownerPid = ownerPidRaw !== undefined ? Number(ownerPidRaw) : undefined;
  if (ownerPid !== undefined && !Number.isInteger(ownerPid)) {
    out(`# REFUSE --owner-pid must be an integer (got ${String(ownerPidRaw)})`);
    return 1;
  }
  const handle = createTempChild({
    root,
    purpose: arg("purpose", argv) ?? "test-run",
    ...(runId !== undefined ? { runId } : {}),
    ...(ownerPid !== undefined ? { ownerPid } : {}),
  });
  out(handle.path); // the ONLY non-comment line: the wrapper reads this
  return 0;
}

function commandRemove(argv: readonly string[]): number {
  const root = requireRoot();
  if (root === undefined) return 1;
  const child = arg("child", argv);
  const runId = arg("run-id", argv);
  if (child === undefined || runId === undefined) {
    out("# REFUSE remove requires --child and --run-id");
    return 1;
  }
  if (!existsSync(child) && readOwnershipRecord(root, runId) === undefined) {
    out(`# remove: ${child} is already gone`);
    return 0;
  }
  try {
    const result = removeOwnedChild({ root, childPath: child, runId });
    if (!result.ok) {
      out(`# REFUSE ${result.reason}`);
      return 1;
    }
    out(`# removed run=${runId} entries=${result.entryCount} path=${child}`);
    return 0;
  } catch (err) {
    // Reported, never swallowed: a cleanup that failed silently is how a stranded tree stayed
    // invisible until the filesystem filled.
    out(`# FAIL could not remove ${child}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function commandCensus(): number {
  const root = requireRoot();
  if (root === undefined) return 1;
  const census = censusChildren(root);
  out(`# census root=${root} children=${census.length}`);
  for (const e of census) {
    out(`#   ${e.classification.disposition} entries=${e.entryCount} run=${e.record?.runId ?? "(none)"} purpose=${e.record?.purpose ?? "(none)"} path=${e.path} reason=${e.classification.reason}`);
  }
  return 0;
}

function commandSurvivors(argv: readonly string[]): number {
  const root = requireRoot();
  if (root === undefined) return 1;
  const runId = arg("run-id", argv);
  const child = arg("child", argv);
  if (runId === undefined) {
    out("# REFUSE survivors requires --run-id");
    return 1;
  }
  let failed = false;

  if (child !== undefined && existsSync(child)) {
    out(`# FAIL this run's temporary child survived cleanup: ${child} (${countEntries(child)} entries)`);
    failed = true;
  }
  if (readOwnershipRecord(root, runId) !== undefined) {
    out("# FAIL this run's ownership record was not collected");
    failed = true;
  }
  const census = censusChildren(root);
  for (const e of census.filter((x) => x.record?.runId === runId)) {
    out(`# FAIL survivor child owned by this run: ${e.path} (${e.entryCount} entries)`);
    failed = true;
  }
  for (const e of census) {
    if (e.record === undefined && !e.path.endsWith(TEMP_RECORDS_DIRNAME)) {
      out(`# WARN unclaimed directory under the governed root: ${e.path} (${e.entryCount} entries)`);
    }
  }
  if (failed) return 1;
  out(`# survivors ok run=${runId} — no owned child remains under the governed root`);
  return 0;
}

function commandUsage(): number {
  out("usage: governed-temp.ts <guard|sentinel|preflight|root|create|remove|census|survivors> [--run-id <id>] [--owner-pid <pid>] [--child <dir>] [--purpose <p>] [--baseline <csv>]");
  return 1;
}

function main(): number {
  const argv = process.argv.slice(2);
  switch (argv[0] ?? "") {
    case "guard": return commandGuard();
    case "sentinel": return commandSentinel(argv);
    case "preflight": return commandPreflight(argv);
    case "root": {
      const root = requireRoot();
      if (root === undefined) return 1;
      out(root);
      return 0;
    }
    case "create": return commandCreate(argv);
    case "remove": return commandRemove(argv);
    case "census": return commandCensus();
    case "survivors": return commandSurvivors(argv);
    default: return commandUsage();
  }
}

process.exit(main());
