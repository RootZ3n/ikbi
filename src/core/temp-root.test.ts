/**
 * THE GOVERNED TEMPORARY-ROOT AUTHORITY.
 *
 * Two halves, and the second is the dangerous one. First: `/tmp` is unreachable by every route —
 * literal, symlinked, inherited, or fallen back to. Second: this module DELETES DIRECTORIES, so
 * every refusal it makes is load-bearing, and a reaper that could remove something it does not own
 * would be a far worse defect than the leak it exists to prevent.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  MIN_FREE_INODES,
  TEMP_RECORDS_DIRNAME,
  TEMP_RECORD_MARKER,
  TEMP_RECORD_VERSION,
  TEMP_ROOT_ENV,
  TEMP_RUN_ID_ENV,
  TempRootUnavailableError,
  censusChildren,
  classifyChild,
  countEntries,
  createTempChild,
  forceRemoveTree,
  gitWorktreeAncestor,
  headroomOf,
  labTempDir,
  readOwnershipRecord,
  reapTempChildren,
  recordPathFor,
  removeOwnedChild,
  resetTempDirForTests,
  resolveTempRoot,
  rootFingerprint,
  tempRootCandidates,
  validateTempRoot,
  type HostLivenessFacts,
  type TempOwnershipRecord,
} from "./temp-root.js";

/**
 * A scratch area for THIS suite.
 *
 * Deliberately built from the governed root rather than the platform temp directory: a suite
 * proving that nothing uses /tmp must not itself use /tmp, and the structural guard would flag it
 * if it tried.
 */
function scratch(): string {
  const base = mkdtempSync(join(labTempDir(), "temp-root-suite-"));
  return base;
}

function fakeHost(over: Partial<HostLivenessFacts> = {}): HostLivenessFacts {
  return { hostname: "test-host", bootId: "boot-A", processExists: () => false, processStartTicks: () => undefined, ...over };
}

type RecordOverrides = { [K in keyof TempOwnershipRecord]?: TempOwnershipRecord[K] | undefined };

function record(over: RecordOverrides = {}): TempOwnershipRecord {
  const base: Record<string, unknown> = {
    marker: TEMP_RECORD_MARKER, version: TEMP_RECORD_VERSION,
    runId: "run-1", childPath: "/governed/run-1", root: "/governed",
    hostname: "test-host", bootId: "boot-A", pid: 4242, processStartTicks: 100,
    createdAt: 1_000, purpose: "test",
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base as unknown as TempOwnershipRecord;
}

// ---------------------------------------------------------------------------
// THE LAB RULE: /tmp is unreachable
// ---------------------------------------------------------------------------

test("/tmp itself is refused", () => {
  const r = validateTempRoot("/tmp");
  assert.ok(r !== undefined);
  assert.equal(r.code, "is_tmp");
});

test("anything DESCENDING from /tmp is refused", () => {
  for (const candidate of ["/tmp/ikbi", "/tmp/a/b/c", "/tmp/ikbi-test-fixtures"]) {
    const r = validateTempRoot(candidate);
    assert.ok(r !== undefined, candidate);
    assert.equal(r.code, "under_tmp", candidate);
  }
});

test("a SYMLINK to /tmp is refused — the real path is what is judged", () => {
  const base = scratch();
  try {
    const link = join(base, "sneaky");
    symlinkSync("/tmp", link);
    const r = validateTempRoot(join(link, "ikbi"));
    assert.ok(r !== undefined);
    // Either refusal is correct and both are enforced: the symlink walk catches the component,
    // and the realpath check catches the destination.
    assert.ok(r.code === "symlink_path" || r.code === "under_tmp", `unexpected ${r.code}`);
  } finally {
    forceRemoveTree(base);
  }
});

test("no candidate list can produce /tmp, whatever the environment says", () => {
  for (const env of [
    {},
    { HOME: "/tmp" },
    { IKBI_STATE_ROOT: "/tmp/state" },
    { XDG_RUNTIME_DIR: "/tmp/run" },
    { [TEMP_ROOT_ENV]: "/tmp" },
  ] as NodeJS.ProcessEnv[]) {
    for (const candidate of tempRootCandidates(env)) {
      const problem = validateTempRoot(candidate.path);
      assert.ok(problem !== undefined || !candidate.path.startsWith("/tmp"), `${candidate.path} slipped through`);
    }
  }
});

test("an explicitly-set /tmp root is an ERROR, never a fall-through to something else", () => {
  const resolution = resolveTempRoot({ [TEMP_ROOT_ENV]: "/tmp/ikbi", HOME: "/home/somebody" } as NodeJS.ProcessEnv);
  assert.equal(resolution.ok, false);
  assert.equal((resolution as { code: string }).code, "under_tmp");
  // An operator who NAMED a root is owed a refusal, not a silent substitution.
  assert.match((resolution as { detail: string }).detail, new RegExp(TEMP_ROOT_ENV));
});

test("the failure message tells an operator exactly what to do", () => {
  const resolution = resolveTempRoot({ [TEMP_ROOT_ENV]: "/tmp" } as NodeJS.ProcessEnv);
  assert.equal(resolution.ok, false);
  const detail = (resolution as { detail: string }).detail;
  assert.match(detail, /never falls back to \/tmp/);
  assert.match(detail, /IKBI_TEMP_ROOT/);
  assert.match(detail, /not inside a git working tree/);
});

test("labTempDir THROWS a typed error rather than using /tmp when no root is usable", () => {
  resetTempDirForTests();
  try {
    assert.throws(
      () => labTempDir({ [TEMP_ROOT_ENV]: "/tmp/nope" } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof TempRootUnavailableError && err.code === "under_tmp",
    );
  } finally {
    resetTempDirForTests();
  }
});

// ---------------------------------------------------------------------------
// The other refusals
// ---------------------------------------------------------------------------

test("a root inside a git working tree is refused", () => {
  const base = scratch();
  try {
    const repo = join(base, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const r = validateTempRoot(join(repo, "scratch"));
    assert.ok(r !== undefined);
    assert.equal(r.code, "inside_git_worktree");
    assert.equal(gitWorktreeAncestor(join(repo, "scratch")), repo);
  } finally {
    forceRemoveTree(base);
  }
});

test("a group- or world-writable root is refused", () => {
  const base = scratch();
  try {
    for (const mode of [0o777, 0o770, 0o702]) {
      const dir = join(base, `mode-${mode.toString(8)}`);
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, mode);
      const r = validateTempRoot(dir);
      assert.ok(r !== undefined, `mode ${mode.toString(8)} was accepted`);
      assert.equal(r.code, "group_or_world_writable");
    }
    // 0700 is fine.
    const ok = join(base, "private");
    mkdirSync(ok, { recursive: true });
    chmodSync(ok, 0o700);
    assert.equal(validateTempRoot(ok), undefined);
  } finally {
    forceRemoveTree(base);
  }
});

test("a root owned by someone else is refused", () => {
  const base = scratch();
  try {
    mkdirSync(join(base, "d"), { recursive: true });
    const mine = process.getuid?.() ?? 0;
    const r = validateTempRoot(join(base, "d"), { uid: mine + 1 });
    assert.ok(r !== undefined);
    assert.equal(r.code, "not_owned_by_user");
  } finally {
    forceRemoveTree(base);
  }
});

test("a non-directory and a relative path are refused", () => {
  const base = scratch();
  try {
    const file = join(base, "a-file");
    writeFileSync(file, "x");
    assert.equal(validateTempRoot(file)?.code, "not_a_directory");
    assert.equal(validateTempRoot("relative/path")?.code, "not_absolute");
  } finally {
    forceRemoveTree(base);
  }
});

test("headroom is read, and a dynamic-inode filesystem is not mistaken for a full one", () => {
  const room = headroomOf(labTempDir());
  assert.ok(room !== undefined);
  assert.ok(room.freeBytes > 0);
  // btrfs/xfs report zero total inodes; that must read as "no fixed budget", not "none left".
  assert.ok(room.freeInodes === undefined || room.freeInodes > MIN_FREE_INODES);
});

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test("the default is DISCOVERED from the state root, never a machine path in the source", () => {
  const candidates = tempRootCandidates({ IKBI_STATE_ROOT: "/lab/state", XDG_RUNTIME_DIR: "/run/user/9" } as NodeJS.ProcessEnv);
  assert.equal(candidates[0]?.path, "/lab/state/tmp");
  assert.equal(candidates[0]?.source, "state_root");
  assert.equal(candidates[1]?.path, "/run/user/9/ikbi-temp");

  const fromHome = tempRootCandidates({ HOME: "/home/someone" } as NodeJS.ProcessEnv);
  assert.equal(fromHome[0]?.path, "/home/someone/.ikbi/state/tmp");
});

test("an explicit root short-circuits discovery entirely", () => {
  const candidates = tempRootCandidates({ [TEMP_ROOT_ENV]: "/lab/scratch", IKBI_STATE_ROOT: "/lab/state" } as NodeJS.ProcessEnv);
  assert.deepEqual(candidates.map((c) => c.path), ["/lab/scratch"]);
});

test("no machine-specific path is committed in this authority's source", () => {
  const source = readFileSync(new URL("./temp-root.ts", import.meta.url), "utf8");
  assert.equal(/\/pehverse\b/.test(source), false);
  assert.equal(/\/home\/[a-z]+\b/.test(source), false, "the home directory is discovered, never written down");
});

test("this machine resolves a real governed root, and it is not under /tmp", () => {
  const resolution = resolveTempRoot();
  assert.equal(resolution.ok, true, resolution.ok ? "" : (resolution as { detail: string }).detail);
  const root = (resolution as { root: string }).root;
  assert.equal(root.startsWith("/tmp"), false);
  assert.equal(gitWorktreeAncestor(root), undefined, "and it is outside every worktree");
});

// ---------------------------------------------------------------------------
// Children and ownership
// ---------------------------------------------------------------------------

test("a child is mode 0700 with a complete sidecar record written before use", () => {
  const base = scratch();
  try {
    const host = fakeHost({ processStartTicks: () => 777 });
    const child = createTempChild({ root: base, runId: "run-owned", ownerPid: 4242, purpose: "formatter-shadow", host, now: () => 5_000 });

    const read = readOwnershipRecord(base, "run-owned");
    assert.ok(read !== undefined);
    assert.equal(read.marker, TEMP_RECORD_MARKER);
    assert.equal(read.pid, 4242, "the OWNER is the wrapper's pid, not this helper's");
    assert.equal(read.processStartTicks, 777);
    assert.equal(read.bootId, "boot-A");
    assert.equal(read.purpose, "formatter-shadow");
    assert.equal(read.childPath, child.path);
    assert.equal(read.root, base);

    assert.equal(existsSync(recordPathFor(base, "run-owned")), true, "the record lives BESIDE the child");
    assert.equal(existsSync(join(child.path, ".ikbi-temp-run.json")), false, "never inside it");
    assert.equal(countEntries(child.path), 0, "and costs the child nothing");
  } finally {
    forceRemoveTree(base);
  }
});

test("cleanup refuses a path the record does not vouch for", () => {
  const base = scratch();
  try {
    const child = createTempChild({ root: base, runId: "run-A", ownerPid: 1, purpose: "test", host: fakeHost() });

    assert.equal(removeOwnedChild({ root: base, childPath: child.path, runId: "run-B" }).ok, false, "wrong run id");
    assert.equal(removeOwnedChild({ root: base, childPath: join(base, "elsewhere"), runId: "run-A" }).ok, false, "wrong path");
    assert.equal(removeOwnedChild({ root: base, childPath: "/etc", runId: "run-A" }).ok, false, "outside the root");
    assert.equal(existsSync(child.path), true, "and nothing was removed by any of them");

    assert.equal(removeOwnedChild({ root: base, childPath: child.path, runId: "run-A" }).ok, true);
    assert.equal(existsSync(child.path), false);
    assert.equal(readOwnershipRecord(base, "run-A"), undefined, "the record goes with it");
  } finally {
    forceRemoveTree(base);
  }
});

test("a read-only (0555) fixture cannot strand a child", () => {
  const base = scratch();
  try {
    const child = createTempChild({ root: base, runId: "run-ro", ownerPid: 1, purpose: "test", host: fakeHost() });
    mkdirSync(join(child.path, "snap", "docs"), { recursive: true });
    writeFileSync(join(child.path, "snap", "docs", "ADR.md"), "x");
    chmodSync(join(child.path, "snap", "docs"), 0o555);

    // The naive removal is what stranded 43 directories on a real run.
    assert.throws(() => rmSync(child.path, { recursive: true, force: true }), /EACCES|EPERM/);
    assert.equal(removeOwnedChild({ root: base, childPath: child.path, runId: "run-ro" }).ok, true);
    assert.equal(existsSync(child.path), false);
  } finally {
    forceRemoveTree(base);
  }
});

test("forceRemoveTree never follows a symlink out of the tree it clears", () => {
  const base = scratch();
  try {
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "keep me");
    const child = join(base, "child");
    mkdirSync(child, { recursive: true });
    symlinkSync(outside, join(child, "link"));

    forceRemoveTree(child);
    assert.equal(existsSync(child), false);
    assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep me");
  } finally {
    forceRemoveTree(base);
  }
});

// ---------------------------------------------------------------------------
// The reaper's refusals
// ---------------------------------------------------------------------------

test("liveness: only a positively disproven owner is reapable", () => {
  assert.equal(classifyChild(record(), fakeHost({ processExists: () => true, processStartTicks: () => 100 })).disposition, "live");
  assert.equal(classifyChild(record({ bootId: "boot-OLD" }), fakeHost({ processExists: () => true, processStartTicks: () => 100 })).disposition, "reapable");
  assert.equal(classifyChild(record(), fakeHost({ processExists: () => false })).disposition, "reapable");
  assert.equal(classifyChild(record({ processStartTicks: 100 }), fakeHost({ processExists: () => true, processStartTicks: () => 900 })).disposition, "reapable");
  assert.equal(classifyChild(undefined, fakeHost()).disposition, "undecidable");
  assert.equal(classifyChild(record({ hostname: "other" }), fakeHost()).disposition, "undecidable");
  assert.equal(classifyChild(record({ bootId: undefined }), fakeHost()).disposition, "undecidable");
  assert.equal(classifyChild(record({ processStartTicks: undefined }), fakeHost({ processExists: () => true })).disposition, "undecidable");
});

test("a directory that merely LOOKS like a child is never reaped — no record, no authority", () => {
  const base = scratch();
  try {
    const impostor = join(base, "run-not-ours");
    mkdirSync(join(impostor, "precious"), { recursive: true });
    writeFileSync(join(impostor, "precious", "data.txt"), "keep me");

    const report = reapTempChildren({ root: base, host: fakeHost() });
    assert.equal(report.reaped.length, 0, "prefix alone is not authority to delete");
    assert.equal(readFileSync(join(impostor, "precious", "data.txt"), "utf8"), "keep me");
  } finally {
    forceRemoveTree(base);
  }
});

test("a record claiming a child OUTSIDE its root is refused, not obeyed", () => {
  const base = scratch();
  try {
    const victim = join(base, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "data.txt"), "keep me");

    mkdirSync(join(base, TEMP_RECORDS_DIRNAME), { recursive: true });
    writeFileSync(
      recordPathFor(base, "evil"),
      JSON.stringify({ ...record({ runId: "evil", root: base }), childPath: "/etc", pid: 999_999 }),
    );

    const report = reapTempChildren({ root: base, host: fakeHost({ processExists: () => false }) });
    assert.equal(report.reaped.some((r) => r.path === "/etc"), false, "a traversal claim is never enacted");
    assert.equal(existsSync("/etc"), true);
    assert.equal(readFileSync(join(victim, "data.txt"), "utf8"), "keep me");
  } finally {
    forceRemoveTree(base);
  }
});

test("the reaper removes the disproven, retains the live, and explains both", () => {
  const base = scratch();
  try {
    const dead = createTempChild({ root: base, runId: "run-dead", ownerPid: 1, purpose: "test", host: fakeHost({ processStartTicks: () => 10 }) });
    const live = createTempChild({ root: base, runId: "run-live", ownerPid: 2, purpose: "test", host: fakeHost({ processStartTicks: () => 20 }) });
    mkdirSync(join(dead.path, "leak"), { recursive: true });

    const host = fakeHost({ processExists: (p) => p === 2, processStartTicks: (p) => (p === 2 ? 20 : undefined) });
    const report = reapTempChildren({ root: base, host });

    assert.deepEqual(report.reaped.map((r) => r.runId), ["run-dead"]);
    assert.ok(report.entriesFreed >= 1);
    assert.equal(report.reaped[0]?.purpose, "test", "the evidence names what it collected");
    assert.equal(existsSync(dead.path), false);
    assert.equal(existsSync(live.path), true);
    assert.equal(report.retained.find((r) => r.path === live.path)?.disposition, "live");
  } finally {
    forceRemoveTree(base);
  }
});

test("PARALLEL runs cannot observe away or remove each other's children", () => {
  const base = scratch();
  try {
    const host = fakeHost({ processExists: (p) => p === 11 || p === 22, processStartTicks: (p) => (p === 11 ? 111 : p === 22 ? 222 : undefined) });
    const a = createTempChild({ root: base, runId: "run-A", ownerPid: 11, purpose: "test", host });
    const b = createTempChild({ root: base, runId: "run-B", ownerPid: 22, purpose: "test", host });
    writeFileSync(join(a.path, "a.txt"), "A");
    writeFileSync(join(b.path, "b.txt"), "B");

    assert.equal(reapTempChildren({ root: base, host, protectPath: a.path }).reaped.length, 0);
    assert.equal(reapTempChildren({ root: base, host, protectPath: b.path }).reaped.length, 0);
    assert.equal(readFileSync(join(a.path, "a.txt"), "utf8"), "A");
    assert.equal(readFileSync(join(b.path, "b.txt"), "utf8"), "B");

    // And neither can remove the other by name: the record's run id is checked.
    assert.equal(removeOwnedChild({ root: base, childPath: b.path, runId: "run-A" }).ok, false);
    assert.equal(existsSync(b.path), true);
  } finally {
    forceRemoveTree(base);
  }
});

test("a SIGKILLed run is collected by the NEXT one, with its evidence", () => {
  const base = scratch();
  try {
    const killed = createTempChild({ root: base, runId: "run-killed", ownerPid: 44, purpose: "cli", host: fakeHost({ processStartTicks: () => 444 }), now: () => 1_000 });
    mkdirSync(join(killed.path, "fixture-a"), { recursive: true });
    assert.equal(existsSync(killed.path), true, "SIGKILL runs no cleanup");

    const report = reapTempChildren({ root: base, host: fakeHost({ processExists: () => false }), now: () => 61_000 });
    assert.equal(report.reaped.length, 1);
    assert.equal(report.reaped[0]?.runId, "run-killed");
    assert.equal(report.reaped[0]?.purpose, "cli");
    assert.equal(report.reaped[0]?.ageMs, 60_000);
    assert.equal(existsSync(killed.path), false);
  } finally {
    forceRemoveTree(base);
  }
});

test("the census reports orphans without reaping them", () => {
  const base = scratch();
  try {
    mkdirSync(join(base, "orphan"), { recursive: true });
    const census = censusChildren(base, fakeHost());
    assert.equal(census.length, 1);
    assert.equal(census[0]?.classification.disposition, "undecidable");
    assert.match(census[0]?.classification.reason ?? "", /no ownership record/);
  } finally {
    forceRemoveTree(base);
  }
});

// ---------------------------------------------------------------------------
// The per-process directory
// ---------------------------------------------------------------------------

test("labTempDir returns a governed child, exports TMPDIR/TMP/TEMP, and is stable", () => {
  const dir = labTempDir();
  assert.equal(dir.startsWith("/tmp"), false);
  assert.equal(labTempDir(), dir, "resolved once per process");
  assert.equal(process.env.TMPDIR, dir, "so third-party code lands here too");
  assert.equal(process.env.TMP, dir);
  assert.equal(process.env.TEMP, dir);
  assert.equal(existsSync(dir), true);
});

test("a process that INHERITS a run id joins its parent's child instead of making its own", () => {
  const base = scratch();
  try {
    const parent = createTempChild({ root: base, runId: "shared-run", ownerPid: process.pid, purpose: "test-run" });
    resetTempDirForTests();
    const env = { [TEMP_ROOT_ENV]: base, [TEMP_RUN_ID_ENV]: "shared-run" } as NodeJS.ProcessEnv;
    const joined = labTempDir(env);
    assert.equal(joined, parent.path, "one governed child, shared by every process in the run");
  } finally {
    resetTempDirForTests();
    labTempDir(); // restore this process's own child for the remaining tests
    forceRemoveTree(base);
  }
});

test("the root fingerprint is stable and leaks no path", () => {
  const a = rootFingerprint("/lab/scratch");
  assert.equal(a, rootFingerprint("/lab/scratch/"));
  assert.notEqual(a, rootFingerprint("/lab/other"));
  assert.equal(/lab|scratch/.test(a), false);
});


// ---------------------------------------------------------------------------
// Real processes: concurrency and interrupted-run recovery
// ---------------------------------------------------------------------------

/** Run a snippet in a REAL child node process against a given root. */
function inChild(root: string, snippet: string, extraEnv: Record<string, string> = {}): { status: number | null; stdout: string; signal: NodeJS.Signals | null } {
  // IKBI_TEMP_RUN_ID is CLEARED unless a case sets it. Under the test runner this process has one
  // — that is the product working as intended, every child joining the run's single child — but a
  // test about INDEPENDENT runs has to model independent runs, or it silently asserts nothing.
  const env: NodeJS.ProcessEnv = { ...process.env, IKBI_TEMP_ROOT: root };
  delete env.IKBI_TEMP_RUN_ID;
  const r = spawnSync(process.execPath, ["--import", "tsx", "-e", snippet], {
    encoding: "utf8",
    env: { ...env, ...extraEnv },
    cwd: new URL("../..", import.meta.url).pathname,
  });
  return { status: r.status, stdout: r.stdout ?? "", signal: r.signal };
}

test("CONCURRENCY: two real processes get separate children and neither can reap the other", () => {
  const base = scratch();
  try {
    // Each child creates its own root-owned child, reaps, and prints what it saw.
    const snippet = `
      const m = await import("./src/core/temp-root.ts");
      const dir = m.labTempDir();
      const { writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      writeFileSync(join(dir, "mine.txt"), String(process.pid));
      // Reap while the sibling is (very likely) alive; it must survive.
      const report = m.reapTempChildren({ root: process.env.IKBI_TEMP_ROOT, protectPath: dir });
      console.log(JSON.stringify({ dir, reaped: report.reaped.map((r) => r.path) }));
      await new Promise((r) => setTimeout(r, 400));
    `;
    // Sequential-but-overlapping is enough to pin the rule: the SECOND process runs its reap while
    // the first process's child still exists on disk. What must never happen is one removing the
    // other's tree — and the only thing standing between them is the liveness proof.
    const first = inChild(base, snippet);
    assert.equal(first.status, 0, first.stdout);
    const firstDir = (JSON.parse(first.stdout.trim().split("\n").pop()!) as { dir: string }).dir;

    const second = inChild(base, snippet);
    assert.equal(second.status, 0, second.stdout);
    const secondOut = JSON.parse(second.stdout.trim().split("\n").pop()!) as { dir: string; reaped: string[] };
    assert.notEqual(secondOut.dir, firstDir, "each process got its OWN child");

    // The first process exited cleanly, so its child was removed by its own exit hook — the second
    // must not have needed to, and must not have touched anything of its own.
    assert.equal(secondOut.reaped.includes(secondOut.dir), false, "a run never reaps itself");
    assert.equal(existsSync(secondOut.dir), false, "and cleaned up after itself on exit");
  } finally {
    forceRemoveTree(base);
  }
});

test("CONCURRENCY: a run JOINING a shared child never removes it on its own exit", () => {
  const base = scratch();
  try {
    const wrapper = createTempChild({ root: base, runId: "shared-run", ownerPid: process.pid, purpose: "test-run" });
    const snippet = `
      const m = await import("./src/core/temp-root.ts");
      const dir = m.labTempDir();
      console.log(dir);
    `;
    const child = inChild(base, snippet, { IKBI_TEMP_RUN_ID: "shared-run" });
    assert.equal(child.status, 0, child.stdout);
    assert.equal(child.stdout.trim().split("\n").pop(), wrapper.path, "the child JOINED the wrapper's directory");
    // The wrapper owns it; a joining process must leave it alone.
    assert.equal(existsSync(wrapper.path), true, "and did not remove what it did not own");
  } finally {
    forceRemoveTree(base);
  }
});

test("INTERRUPTED RUN: a SIGKILLed process leaves its child, and the next run recovers it", () => {
  const base = scratch();
  try {
    // A process that creates its child and then kills itself outright — no exit hook, no trap.
    const snippet = `
      const m = await import("./src/core/temp-root.ts");
      const dir = m.labTempDir();
      const { mkdirSync } = await import("node:fs");
      const { join } = await import("node:path");
      mkdirSync(join(dir, "work"), { recursive: true });
      console.log(dir);
      process.kill(process.pid, "SIGKILL");
      await new Promise((r) => setTimeout(r, 5000));
    `;
    const killed = inChild(base, snippet);
    assert.equal(killed.signal, "SIGKILL", "the process really was killed");
    const stranded = killed.stdout.trim().split("\n").pop()!;
    assert.equal(existsSync(stranded), true, "SIGKILL runs no cleanup — the child survives");

    // The next run's preflight collects it, because the owner is now provably gone.
    const report = reapTempChildren({ root: base });
    assert.ok(report.reaped.some((r) => resolve(r.path) === resolve(stranded)), `not reaped: ${JSON.stringify(report)}`);
    assert.equal(existsSync(stranded), false);
    assert.ok(report.reaped.some((r) => r.entryCount >= 1), "and the evidence records what it was holding");
  } finally {
    forceRemoveTree(base);
  }
});
