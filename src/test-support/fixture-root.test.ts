/**
 * The fixture-root authority's own suite.
 *
 * It opens by REPRODUCING the incident — a bounded imitation of the suite that exhausted a
 * tmpfs's inodes — because a containment mechanism that is never shown catching the thing it
 * was built for is just an assertion about itself. Everything after that pins the reaper's
 * refusals, which are the dangerous half: this code deletes directories.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FIXTURE_RECORDS_DIRNAME,
  FIXTURE_RECORD_MARKER,
  FIXTURE_RECORD_VERSION,
  baseFingerprint,
  censusRunRoots,
  classifyRunRoot,
  countEntries,
  createRunRoot,
  fixtureLedger,
  makeFixtureDir,
  parseDfInodes,
  forceRemoveTree,
  readOwnershipRecord,
  recordPathFor,
  reapStaleRunRoots,
  removeFixtureDir,
  removeOwnedRunRoot,
  resetFixtureLedger,
  resolveFixtureBase,
  withFixtureDir,
  withFixtureDirSync,
  type FixtureOwnershipRecord,
  type HostLivenessFacts,
} from "./fixture-root.js";

/** A scratch area for this suite itself, cleaned by its own `finally`. */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ikbi-fixture-root-suite-"));
}

/** Host facts with no real process table behind them, so liveness is exactly what we say. */
function fakeHost(over: Partial<HostLivenessFacts> = {}): HostLivenessFacts {
  return {
    hostname: "test-host",
    bootId: "boot-A",
    processExists: () => false,
    processStartTicks: () => undefined,
    ...over,
  };
}

/**
 * Overrides where an explicit `undefined` means ABSENT, not "keep the default".
 * The optional fields are exactly the ones whose absence changes a classification, so a
 * test has to be able to say "this record has no boot id" and mean it.
 */
type RecordOverrides = { [K in keyof FixtureOwnershipRecord]?: FixtureOwnershipRecord[K] | undefined };

function record(over: RecordOverrides = {}): FixtureOwnershipRecord {
  const base: Record<string, unknown> = {
    marker: FIXTURE_RECORD_MARKER,
    version: FIXTURE_RECORD_VERSION,
    runId: "run-1",
    rootPath: "/unused/run-1",
    hostname: "test-host",
    bootId: "boot-A",
    pid: 4242,
    processStartTicks: 100,
    createdAt: 1_000,
  };
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base as unknown as FixtureOwnershipRecord;
}

// ---------------------------------------------------------------------------
// The leak, reproduced
// ---------------------------------------------------------------------------

test("REPRODUCTION: suites that throw before cleanup leak their fixture directories forever", () => {
  const base = scratch();
  try {
    // The pre-fix shape: each "suite" mkdtemps under the ambient temp root and removes it
    // on the happy path only. A throw skips the cleanup, exactly as ~600 real call sites do.
    const leaked: string[] = [];
    const legacySuite = (failing: boolean): void => {
      const dir = mkdtempSync(join(base, "ikbi-legacy-"));
      leaked.push(dir);
      if (failing) throw new Error("assertion failed");
      rmSync(dir, { recursive: true, force: true });
    };

    for (let i = 0; i < 10; i += 1) {
      try {
        legacySuite(i % 2 === 0);
      } catch {
        /* the suite reports the failure and moves on — the directory does not */
      }
    }

    const survivors = leaked.filter((d) => existsSync(d));
    assert.equal(survivors.length, 5, "every failing legacy suite leaked its directory");
    // And nothing about the ambient root collects them: they outlive the process that made
    // them, which is precisely how 65,645 entries accumulated.
    assert.ok(countEntries(base) >= 5, "the leaked directories are still consuming inodes");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("REMEDIATION: containment removes the whole run root, so a leaked fixture dies with its run", () => {
  const base = scratch();
  try {
    const host = fakeHost({ processExists: () => true, processStartTicks: () => 100 });
    const root = createRunRoot({ base, runId: "run-contained", ownerPid: 4242, host, now: () => 1_000 });

    // Suites leak into the run root, as they always did.
    for (let i = 0; i < 10; i += 1) mkdirSync(join(root.path, `ikbi-legacy-${i}`), { recursive: true });
    assert.ok(countEntries(root.path) >= 10, "the leaks landed inside the run root");

    const gone = removeOwnedRunRoot({ base, rootPath: root.path, runId: "run-contained" });
    assert.equal(gone.ok, true);
    assert.equal(existsSync(root.path), false, "the run root and every leak inside it are gone");
    // Only the (now empty) sidecar directory remains: no fixture survived the run.
    assert.equal(censusRunRoots(base, host).length, 0, "no fixture root survived the run");
    assert.equal(countEntries(join(base, FIXTURE_RECORDS_DIRNAME)), 0, "the run's record was collected with it");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("REPRODUCTION: a fixture that leaves a read-only directory defeats its own cleanup", () => {
  const base = scratch();
  try {
    // The shape a real suite leaves behind when it exercises read-only behaviour. One run
    // stranded 43 of these, and every cleanup that reached one died on it.
    const fixture = join(base, "ikbi-snap-readonly");
    mkdirSync(join(fixture, "docs"), { recursive: true });
    writeFileSync(join(fixture, "docs", "ADR.md"), "content");
    chmodSync(join(fixture, "docs"), 0o555);

    // A correct-looking `finally` is not enough: a file cannot be unlinked from a directory
    // its owner cannot write, so the cleanup throws and the fixture survives.
    assert.throws(() => rmSync(fixture, { recursive: true, force: true }), /EACCES|EPERM/);
    assert.equal(existsSync(fixture), true, "the fixture outlived a cleanup that did run");
  } finally {
    spawnSync("chmod", ["-R", "u+rwX", base]);
    rmSync(base, { recursive: true, force: true });
  }
});

test("REMEDIATION: forceRemoveTree restores owner write on directories and removes the tree", () => {
  const base = scratch();
  try {
    const fixture = join(base, "ikbi-snap-readonly");
    mkdirSync(join(fixture, "docs", "nested"), { recursive: true });
    writeFileSync(join(fixture, "docs", "ADR.md"), "content");
    writeFileSync(join(fixture, "docs", "nested", "deep.md"), "content");
    chmodSync(join(fixture, "docs", "nested"), 0o555);
    chmodSync(join(fixture, "docs"), 0o555);

    forceRemoveTree(fixture);
    assert.equal(existsSync(fixture), false, "read-only directories no longer strand a fixture");
  } finally {
    spawnSync("chmod", ["-R", "u+rwX", base]);
    rmSync(base, { recursive: true, force: true });
  }
});

test("a run root full of read-only fixtures is still fully removed by cleanup", () => {
  const base = scratch();
  try {
    const root = createRunRoot({ base, runId: "run-readonly", ownerPid: 1, host: fakeHost() });
    const fixture = join(root.path, "ikbi-snap-x");
    mkdirSync(join(fixture, "docs"), { recursive: true });
    writeFileSync(join(fixture, "docs", "a.md"), "x");
    chmodSync(join(fixture, "docs"), 0o555);

    const gone = removeOwnedRunRoot({ base, rootPath: root.path, runId: "run-readonly" });
    assert.equal(gone.ok, true);
    assert.equal(existsSync(root.path), false);
  } finally {
    spawnSync("chmod", ["-R", "u+rwX", base]);
    rmSync(base, { recursive: true, force: true });
  }
});

test("forceRemoveTree never follows a symlink out of the tree it is clearing", () => {
  const base = scratch();
  try {
    const outside = join(base, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "precious.txt"), "keep me");

    const fixture = join(base, "fixture");
    mkdirSync(fixture, { recursive: true });
    symlinkSync(outside, join(fixture, "link-to-outside"));

    forceRemoveTree(fixture);
    assert.equal(existsSync(fixture), false);
    assert.equal(existsSync(join(outside, "precious.txt")), true, "the symlink target was untouched");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a partially-removed root keeps its record, so the next run can finish the job", () => {
  const base = scratch();
  try {
    const root = createRunRoot({ base, runId: "run-partial", ownerPid: 1, host: fakeHost() });
    mkdirSync(join(root.path, "leftover"), { recursive: true });

    // The record is a sidecar, so even if the root is half-gone it still says whose it is.
    rmSync(join(root.path, "leftover"), { recursive: true, force: true });
    assert.ok(readOwnershipRecord(base, "run-partial") !== undefined, "authority survived the partial removal");

    const report = reapStaleRunRoots({ base, host: fakeHost({ processExists: () => false }) });
    assert.equal(report.reaped.length, 1);
    assert.equal(existsSync(root.path), false);
    assert.equal(readOwnershipRecord(base, "run-partial"), undefined, "and the record is collected with it");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The ownership record
// ---------------------------------------------------------------------------

test("a run root is 0700 and carries a complete ownership record before it is used", () => {
  const base = scratch();
  try {
    const host = fakeHost({ processStartTicks: () => 777 });
    const root = createRunRoot({ base, runId: "run-owned", ownerPid: 4242, host, now: () => 5_000 });

    const read = readOwnershipRecord(base, "run-owned");
    assert.ok(read !== undefined);
    assert.equal(read.marker, FIXTURE_RECORD_MARKER);
    assert.equal(read.version, FIXTURE_RECORD_VERSION);
    assert.equal(read.runId, "run-owned");
    assert.equal(read.hostname, "test-host");
    assert.equal(read.bootId, "boot-A");
    assert.equal(read.pid, 4242, "the OWNER is the wrapper's pid, not this helper's");
    assert.equal(read.processStartTicks, 777);
    assert.equal(read.createdAt, 5_000);
    assert.equal(read.rootPath, root.path);
    assert.equal(existsSync(recordPathFor(base, "run-owned")), true, "the record lives BESIDE the root, not inside it");
    assert.equal(existsSync(join(root.path, "ikbi-test-run.json")), false);

    const mode = spawnSync("stat", ["-c", "%a", root.path], { encoding: "utf8" });
    if (mode.status === 0) assert.equal(mode.stdout.trim(), "700", "the run root is private");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the owner pid is the wrapper, not the process that happened to create the root", () => {
  const base = scratch();
  try {
    const root = createRunRoot({ base, runId: "run-owner", ownerPid: 999_001, host: fakeHost() });
    assert.equal(root.record.pid, 999_001);
    assert.notEqual(root.record.pid, process.pid);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Classification — the refusals
// ---------------------------------------------------------------------------

test("a live owner is never reapable", () => {
  const c = classifyRunRoot(record(), fakeHost({ processExists: () => true, processStartTicks: () => 100 }));
  assert.equal(c.disposition, "live");
});

test("a root from a previous boot is reapable — the owner cannot be running", () => {
  const c = classifyRunRoot(record({ bootId: "boot-OLD" }), fakeHost({ bootId: "boot-A", processExists: () => true, processStartTicks: () => 100 }));
  assert.equal(c.disposition, "reapable");
  assert.match(c.reason, /before the current boot/);
});

test("a dead pid on this boot is reapable", () => {
  const c = classifyRunRoot(record(), fakeHost({ processExists: () => false }));
  assert.equal(c.disposition, "reapable");
  assert.match(c.reason, /is gone/);
});

test("a RECYCLED pid is reapable — matching pid with different start ticks is a different process", () => {
  const c = classifyRunRoot(record({ processStartTicks: 100 }), fakeHost({ processExists: () => true, processStartTicks: () => 900 }));
  assert.equal(c.disposition, "reapable");
  assert.match(c.reason, /recycled/);
});

test("a live pid whose start ticks MATCH is live even though the pid could have been reused", () => {
  const c = classifyRunRoot(record({ processStartTicks: 100 }), fakeHost({ processExists: () => true, processStartTicks: () => 100 }));
  assert.equal(c.disposition, "live");
});

test("an unreadable, absent or foreign record is undecidable and never removed", () => {
  assert.equal(classifyRunRoot(undefined, fakeHost()).disposition, "undecidable");
  assert.equal(classifyRunRoot(record({ marker: "something-else" as never }), fakeHost()).disposition, "undecidable");
  assert.equal(classifyRunRoot(record({ version: 99 }), fakeHost()).disposition, "undecidable");
  assert.equal(classifyRunRoot(record({ hostname: "other-host" }), fakeHost()).disposition, "undecidable");
});

test("with no boot id the reaper can prove nothing, so nothing is reapable", () => {
  assert.equal(classifyRunRoot(record(), fakeHost({ bootId: undefined })).disposition, "undecidable");
  assert.equal(classifyRunRoot(record({ bootId: undefined }), fakeHost()).disposition, "undecidable");
});

test("a live pid with no recorded start ticks is undecidable, not live and not reapable", () => {
  const c = classifyRunRoot(record({ processStartTicks: undefined }), fakeHost({ processExists: () => true }));
  assert.equal(c.disposition, "undecidable");
  assert.match(c.reason, /pid reuse/);
});

// ---------------------------------------------------------------------------
// Reaping
// ---------------------------------------------------------------------------

test("the reaper removes only disproven roots and explains every one it retains", () => {
  const base = scratch();
  try {
    const dead = createRunRoot({ base, runId: "run-dead", ownerPid: 1, host: fakeHost({ processStartTicks: () => 10 }) });
    const live = createRunRoot({ base, runId: "run-live", ownerPid: 2, host: fakeHost({ processStartTicks: () => 20 }) });
    mkdirSync(join(dead.path, "leak"), { recursive: true });

    const host = fakeHost({
      processExists: (pid) => pid === 2,
      processStartTicks: (pid) => (pid === 2 ? 20 : undefined),
    });
    const report = reapStaleRunRoots({ base, host });

    assert.equal(report.reaped.length, 1);
    assert.equal(report.reaped[0]?.runId, "run-dead");
    assert.ok(report.entriesFreed >= 1, "the report accounts for the inodes it freed");
    assert.equal(existsSync(dead.path), false);
    assert.equal(existsSync(live.path), true, "the live run's root is untouched");
    assert.equal(report.retained.length, 1);
    assert.equal(report.retained[0]?.disposition, "live");
    assert.ok((report.retained[0]?.reason ?? "").length > 0, "a retained root is explained");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a directory that merely LOOKS like a run root is never reaped — no record, no authority", () => {
  const base = scratch();
  try {
    // Same naming convention, no ownership record: a developer's scratch, or another tool's.
    const impostor = join(base, "run-not-ours");
    mkdirSync(join(impostor, "precious"), { recursive: true });
    writeFileSync(join(impostor, "precious", "data.txt"), "keep me");

    const report = reapStaleRunRoots({ base, host: fakeHost() });

    assert.equal(report.reaped.length, 0, "prefix alone is not authority to delete");
    assert.equal(existsSync(join(impostor, "precious", "data.txt")), true);
    assert.ok(report.retained.some((r) => r.disposition === "undecidable"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a corrupt ownership record makes a root undecidable, not reapable", () => {
  const base = scratch();
  try {
    const root = join(base, "run-corrupt");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(base, FIXTURE_RECORDS_DIRNAME), { recursive: true });
    writeFileSync(recordPathFor(base, "run-corrupt"), "{ this is not json");

    const report = reapStaleRunRoots({ base, host: fakeHost() });
    assert.equal(report.reaped.length, 0);
    assert.equal(existsSync(root), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("dryRun classifies and accounts without removing anything", () => {
  const base = scratch();
  try {
    const dead = createRunRoot({ base, runId: "run-dead", ownerPid: 1, host: fakeHost({ processStartTicks: () => 10 }) });
    const report = reapStaleRunRoots({ base, host: fakeHost({ processExists: () => false }), dryRun: true });
    assert.equal(report.reaped.length, 1);
    assert.equal(existsSync(dead.path), true, "a dry run removes nothing");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a run never reaps its own root, even when its own liveness cannot be established", () => {
  const base = scratch();
  try {
    const mine = createRunRoot({ base, runId: "run-mine", ownerPid: 1, host: fakeHost({ processStartTicks: () => 10 }) });
    const report = reapStaleRunRoots({ base, host: fakeHost({ processExists: () => false }), protectPath: mine.path });
    assert.equal(report.reaped.length, 0);
    assert.equal(existsSync(mine.path), true);
    assert.match(report.retained[0]?.reason ?? "", /own root/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parallel runners
// ---------------------------------------------------------------------------

test("two concurrent runners each reap neither the other's root nor their own", () => {
  const base = scratch();
  try {
    const hostA = fakeHost({ processExists: (p) => p === 11 || p === 22, processStartTicks: (p) => (p === 11 ? 111 : p === 22 ? 222 : undefined) });
    const a = createRunRoot({ base, runId: "run-A", ownerPid: 11, host: hostA });
    const b = createRunRoot({ base, runId: "run-B", ownerPid: 22, host: hostA });

    // Runner A starts up and reaps; runner B is mid-run.
    const fromA = reapStaleRunRoots({ base, host: hostA, protectPath: a.path });
    assert.equal(fromA.reaped.length, 0, "A removed nothing — B is alive and A protects itself");

    // And symmetrically.
    const fromB = reapStaleRunRoots({ base, host: hostA, protectPath: b.path });
    assert.equal(fromB.reaped.length, 0);

    assert.equal(existsSync(a.path), true);
    assert.equal(existsSync(b.path), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a parallel runner's root survives even when a THIRD, dead run is reaped alongside it", () => {
  const base = scratch();
  try {
    const host = fakeHost({ processExists: (p) => p === 22, processStartTicks: (p) => (p === 22 ? 222 : undefined) });
    const live = createRunRoot({ base, runId: "run-live", ownerPid: 22, host: fakeHost({ processStartTicks: () => 222 }) });
    const dead = createRunRoot({ base, runId: "run-dead", ownerPid: 33, host: fakeHost({ processStartTicks: () => 333 }) });

    const report = reapStaleRunRoots({ base, host });
    assert.deepEqual(report.reaped.map((r) => r.runId), ["run-dead"]);
    assert.equal(existsSync(live.path), true);
    assert.equal(existsSync(dead.path), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SIGKILL: evidence, then safe collection on the next run
// ---------------------------------------------------------------------------

test("a SIGKILLed run leaves its root behind, and the NEXT run collects it with its evidence intact", () => {
  const base = scratch();
  try {
    // The killed run: root created, fixtures inside, no trap ever fired.
    const killed = createRunRoot({ base, runId: "run-killed", ownerPid: 44, host: fakeHost({ processStartTicks: () => 444 }), now: () => 1_000 });
    mkdirSync(join(killed.path, "fixture-a"), { recursive: true });
    mkdirSync(join(killed.path, "fixture-b"), { recursive: true });
    assert.equal(existsSync(killed.path), true, "SIGKILL runs no cleanup — the root survives");

    // The next run: the owner is provably gone.
    const report = reapStaleRunRoots({ base, host: fakeHost({ processExists: () => false }), now: () => 61_000 });

    assert.equal(report.reaped.length, 1);
    const evidence = report.reaped[0]!;
    assert.equal(evidence.runId, "run-killed", "the reap report names what it collected");
    assert.ok(evidence.entryCount >= 2, "and how many inodes that run was holding");
    assert.equal(evidence.ageMs, 60_000, "and how long it had been abandoned");
    assert.match(evidence.reason, /gone/);
    assert.equal(existsSync(killed.path), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// removeOwnedRunRoot — the cleanup path's own refusals
// ---------------------------------------------------------------------------

test("cleanup refuses a path that is not a run root, or belongs to a different run", () => {
  const base = scratch();
  try {
    const other = join(base, "somebody-elses-directory");
    mkdirSync(other, { recursive: true });
    const bad = removeOwnedRunRoot({ base, rootPath: other, runId: "run-x" });
    assert.equal(bad.ok, false);
    assert.equal(existsSync(other), true, "a directory with no record is never removed by cleanup");

    const root = createRunRoot({ base, runId: "run-A", ownerPid: 1, host: fakeHost() });
    const wrongRun = removeOwnedRunRoot({ base, rootPath: root.path, runId: "run-B" });
    assert.equal(wrongRun.ok, false);
    assert.equal(existsSync(root.path), true, "cleanup checks the run id, not just the path it was handed");

    const right = removeOwnedRunRoot({ base, rootPath: root.path, runId: "run-A" });
    assert.equal(right.ok, true);
    assert.equal(existsSync(root.path), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The fixture helper — every exit path
// ---------------------------------------------------------------------------

test("withFixtureDir removes its directory on success, on throw, and on rejection", async () => {
  resetFixtureLedger();
  const seen: string[] = [];

  const ok = await withFixtureDir("ikbi-case-success", (dir) => {
    seen.push(dir);
    assert.equal(existsSync(dir), true);
    return "value";
  });
  assert.equal(ok, "value");

  await assert.rejects(
    withFixtureDir("ikbi-case-assertion", (dir) => {
      seen.push(dir);
      assert.equal(1, 2, "a deliberate assertion failure");
    }),
    /deliberate assertion failure/,
  );

  await assert.rejects(
    withFixtureDir("ikbi-case-rejection", async (dir) => {
      seen.push(dir);
      await Promise.resolve();
      throw new Error("async boom");
    }),
    /async boom/,
  );

  for (const dir of seen) assert.equal(existsSync(dir), false, `${dir} was collected whatever the outcome`);
  assert.equal(fixtureLedger().survivors.length, 0);
});

test("withFixtureDirSync collects on a synchronous throw", () => {
  resetFixtureLedger();
  let captured = "";
  assert.throws(() => {
    withFixtureDirSync("ikbi-case-sync", (dir) => {
      captured = dir;
      throw new Error("setup failure");
    });
  }, /setup failure/);
  assert.equal(existsSync(captured), false);
});

test("a SETUP failure before the body runs still leaves nothing behind", async () => {
  resetFixtureLedger();
  let captured = "";
  await assert.rejects(
    withFixtureDir("ikbi-case-setup", (dir) => {
      captured = dir;
      // The shape of a setup failure: the fixture exists, then the arrangement throws.
      JSON.parse("{{ not json");
      return dir;
    }),
    SyntaxError,
  );
  assert.equal(existsSync(captured), false);
});

test("a TIMEOUT that rejects the body still collects the fixture", async () => {
  resetFixtureLedger();
  let captured = "";
  await assert.rejects(
    withFixtureDir("ikbi-case-timeout", async (dir) => {
      captured = dir;
      await new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), 5));
    }),
    /timed out/,
  );
  assert.equal(existsSync(captured), false);
});

test("a CANCELLED body — an aborted signal — still collects the fixture", async () => {
  resetFixtureLedger();
  const controller = new AbortController();
  let captured = "";
  const pending = withFixtureDir("ikbi-case-cancel", async (dir) => {
    captured = dir;
    await new Promise((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(existsSync(captured), false);
});

test("an INTERRUPTED child process does not keep the fixture alive", async () => {
  resetFixtureLedger();
  let captured = "";
  await assert.rejects(
    withFixtureDir("ikbi-case-child", async (dir) => {
      captured = dir;
      // A child that is killed mid-flight: the suite still unwinds through `finally`.
      const child = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { encoding: "utf8" });
      assert.notEqual(child.signal, null, "the child really was signalled");
      throw new Error("child interrupted");
    }),
    /child interrupted/,
  );
  assert.equal(existsSync(captured), false);
});

test("the ledger separates created from removed and names the true survivors", () => {
  resetFixtureLedger();
  const kept = makeFixtureDir("ikbi-ledger-kept");
  const collected = makeFixtureDir("ikbi-ledger-collected");
  removeFixtureDir(collected);

  const ledger = fixtureLedger();
  assert.equal(ledger.created.length, 2);
  assert.deepEqual(ledger.removed, [collected]);
  assert.deepEqual(ledger.survivors, [kept], "a created-and-never-removed fixture is reported, not hidden");

  removeFixtureDir(kept);
  assert.equal(fixtureLedger().survivors.length, 0);
});

test("makeFixtureDir lands beneath the ambient temp root, so TMPDIR containment applies", () => {
  resetFixtureLedger();
  const dir = makeFixtureDir("ikbi-under-tmpdir");
  try {
    assert.ok(dir.startsWith(tmpdir()), `${dir} is inside ${tmpdir()}`);
  } finally {
    removeFixtureDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Base resolution and inode accounting
// ---------------------------------------------------------------------------

test("the fixture base comes from configuration and falls back to the ambient temp root", () => {
  assert.equal(resolveFixtureBase({ IKBI_TEST_FIXTURE_BASE: "/somewhere/else" } as NodeJS.ProcessEnv), "/somewhere/else");
  assert.equal(resolveFixtureBase({ IKBI_TEST_FIXTURE_BASE: "   " } as NodeJS.ProcessEnv), join(tmpdir(), "ikbi-test-fixtures"));
  assert.equal(resolveFixtureBase({} as NodeJS.ProcessEnv), join(tmpdir(), "ikbi-test-fixtures"));
});

test("no committed source names a specific host's fixture directory", () => {
  const source = readFileSync(new URL("./fixture-root.ts", import.meta.url), "utf8");
  assert.equal(/\/pehverse\b/.test(source), false, "the base is configuration, never a hard-coded host path");
});

test("df -i output is parsed from its POSIX form", () => {
  const usage = parseDfInodes("Filesystem      Inodes   IUsed  IFree IUse% Mounted on\ntmpfs          1048576 1048575      1  100% /tmp\n");
  assert.ok(usage !== undefined);
  assert.equal(usage.total, 1_048_576);
  assert.equal(usage.used, 1_048_575);
  assert.equal(usage.free, 1);
  assert.ok(usage.usedPercent > 99.9);
});

test("df parsing refuses output it cannot trust rather than inventing numbers", () => {
  assert.equal(parseDfInodes(""), undefined);
  assert.equal(parseDfInodes("Filesystem Inodes IUsed IFree IUse% Mounted on\n"), undefined);
  assert.equal(parseDfInodes("header\nnot numbers here at all\n"), undefined);
});

test("countEntries counts the whole subtree and is bounded", () => {
  const base = scratch();
  try {
    mkdirSync(join(base, "a", "b", "c"), { recursive: true });
    writeFileSync(join(base, "a", "b", "c", "f.txt"), "x");
    assert.equal(countEntries(base), 4, "a + b + c + f.txt");
    assert.ok(countEntries(base, 2) <= 2, "the bound is honoured");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the census reports each root's inode cost so consumption is visible, not inferred", () => {
  const base = scratch();
  try {
    const root = createRunRoot({ base, runId: "run-cost", ownerPid: 1, host: fakeHost() });
    mkdirSync(join(root.path, "x", "y"), { recursive: true });
    const census = censusRunRoots(base, fakeHost());
    assert.equal(census.length, 1);
    // x plus y — the record is a sidecar and costs the ROOT nothing.
    assert.equal(census[0]?.entryCount, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a census over a base that does not exist is empty, not an error", () => {
  assert.deepEqual(censusRunRoots(join(tmpdir(), `ikbi-absent-${Date.now()}`), fakeHost()), []);
});

test("the base fingerprint is stable and reveals no path", () => {
  const a = baseFingerprint("/some/base");
  assert.equal(a, baseFingerprint("/some/base/"));
  assert.notEqual(a, baseFingerprint("/other/base"));
  assert.equal(/some|base/.test(a), false);
});
