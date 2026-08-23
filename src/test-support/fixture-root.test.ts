/**
 * THE TEST-FACING FIXTURE HELPER.
 *
 * It opens by REPRODUCING both original leak causes — a suite that throws before its cleanup, and
 * a fixture that leaves a directory read-only — because a containment mechanism never shown
 * catching the thing it was built for is just an assertion about itself.
 *
 * The reaper, the ownership records and the root validation are NOT tested here: they live in
 * `src/core/temp-root.ts` and are covered by `temp-root.test.ts`. This file covers only what this
 * layer still owns.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  countEntries,
  fixtureLedger,
  forceRemoveTree,
  labTempDir,
  makeFixtureDir,
  parseDfInodes,
  removeFixtureDir,
  resetFixtureLedger,
  withFixtureDir,
  withFixtureDirSync,
} from "./fixture-root.js";

/** A scratch area for this suite itself — under the GOVERNED root, never the system temp directory. */
function scratch(): string {
  return mkdtempSync(join(labTempDir(), "fixture-suite-"));
}

// ---------------------------------------------------------------------------
// The leaks, reproduced
// ---------------------------------------------------------------------------

test("REPRODUCTION: a suite that throws before cleanup leaks its fixture directory", () => {
  const base = scratch();
  try {
    const leaked: string[] = [];
    const legacySuite = (failing: boolean): void => {
      const dir = mkdtempSync(join(base, "legacy-"));
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
    assert.equal(leaked.filter((d) => existsSync(d)).length, 5, "every failing legacy suite leaked");
    assert.ok(countEntries(base) >= 5, "and the leaks are still consuming inodes");
  } finally {
    forceRemoveTree(base);
  }
});

test("REPRODUCTION: a read-only (0555) directory defeats an otherwise-correct cleanup", () => {
  const base = scratch();
  try {
    const fixture = join(base, "snap");
    mkdirSync(join(fixture, "docs"), { recursive: true });
    writeFileSync(join(fixture, "docs", "ADR.md"), "content");
    chmodSync(join(fixture, "docs"), 0o555);

    assert.throws(() => rmSync(fixture, { recursive: true, force: true }), /EACCES|EPERM/);
    assert.equal(existsSync(fixture), true, "the fixture outlived a cleanup that did run");

    forceRemoveTree(fixture);
    assert.equal(existsSync(fixture), false, "the force-removing walk collects it");
  } finally {
    spawnSync("chmod", ["-R", "u+rwX", base]);
    forceRemoveTree(base);
  }
});

// ---------------------------------------------------------------------------
// withFixtureDir — every exit path
// ---------------------------------------------------------------------------

test("withFixtureDir removes its directory on success, on throw, and on rejection", async () => {
  resetFixtureLedger();
  const seen: string[] = [];

  assert.equal(await withFixtureDir("case-success", (dir) => { seen.push(dir); return "value"; }), "value");
  await assert.rejects(
    withFixtureDir("case-assertion", (dir) => { seen.push(dir); assert.equal(1, 2, "a deliberate assertion failure"); }),
    /deliberate assertion failure/,
  );
  await assert.rejects(
    withFixtureDir("case-rejection", async (dir) => { seen.push(dir); await Promise.resolve(); throw new Error("async boom"); }),
    /async boom/,
  );

  for (const dir of seen) assert.equal(existsSync(dir), false, `${dir} was collected whatever the outcome`);
  assert.equal(fixtureLedger().survivors.length, 0);
});

test("withFixtureDirSync collects on a synchronous throw", () => {
  resetFixtureLedger();
  let captured = "";
  assert.throws(() => withFixtureDirSync("case-sync", (dir) => { captured = dir; throw new Error("setup failure"); }), /setup failure/);
  assert.equal(existsSync(captured), false);
});

test("a SETUP failure before the body runs still leaves nothing behind", async () => {
  resetFixtureLedger();
  let captured = "";
  await assert.rejects(
    withFixtureDir("case-setup", (dir) => { captured = dir; JSON.parse("{{ not json"); return dir; }),
    SyntaxError,
  );
  assert.equal(existsSync(captured), false);
});

test("a TIMEOUT that rejects the body still collects the fixture", async () => {
  resetFixtureLedger();
  let captured = "";
  await assert.rejects(
    withFixtureDir("case-timeout", async (dir) => {
      captured = dir;
      await new Promise((_r, reject) => setTimeout(() => reject(new Error("timed out")), 5));
    }),
    /timed out/,
  );
  assert.equal(existsSync(captured), false);
});

test("a CANCELLED body — an aborted signal — still collects the fixture", async () => {
  resetFixtureLedger();
  const controller = new AbortController();
  let captured = "";
  const pending = withFixtureDir("case-cancel", async (dir) => {
    captured = dir;
    await new Promise((_r, reject) => {
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
    withFixtureDir("case-child", async (dir) => {
      captured = dir;
      const child = spawnSync(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], { encoding: "utf8" });
      assert.notEqual(child.signal, null, "the child really was signalled");
      throw new Error("child interrupted");
    }),
    /child interrupted/,
  );
  assert.equal(existsSync(captured), false);
});

test("a fixture left READ-ONLY is still collected by withFixtureDir", async () => {
  resetFixtureLedger();
  let captured = "";
  await withFixtureDir("case-readonly", (dir) => {
    captured = dir;
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "a.md"), "x");
    chmodSync(join(dir, "docs"), 0o555);
  });
  assert.equal(existsSync(captured), false);
});

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

test("the ledger separates created from removed and names the true survivors", () => {
  resetFixtureLedger();
  const kept = makeFixtureDir("ledger-kept");
  const collected = makeFixtureDir("ledger-collected");
  removeFixtureDir(collected);

  const ledger = fixtureLedger();
  assert.equal(ledger.created.length, 2);
  assert.deepEqual(ledger.removed, [collected]);
  assert.deepEqual(ledger.survivors, [kept], "a created-and-never-removed fixture is reported, not hidden");

  removeFixtureDir(kept);
  assert.equal(fixtureLedger().survivors.length, 0);
});

test("every fixture lands under the GOVERNED root, never /lab-fake", () => {
  resetFixtureLedger();
  const dir = makeFixtureDir("under-governed-root");
  try {
    assert.ok(dir.startsWith(labTempDir()), `${dir} is inside ${labTempDir()}`);
    assert.equal(dir.startsWith("/lab-fake"), false);
  } finally {
    removeFixtureDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Inode accounting
// ---------------------------------------------------------------------------

test("df -i output is parsed from its POSIX form", () => {
  const usage = parseDfInodes("Filesystem      Inodes   IUsed  IFree IUse% Mounted on\ntmpfs          1048576 1048575      1  100% /somewhere\n");
  assert.ok(usage !== undefined);
  assert.equal(usage.total, 1_048_576);
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
    forceRemoveTree(base);
  }
});
