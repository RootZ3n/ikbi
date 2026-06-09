/**
 * ikbi verification-ladder — planner acceptance tests (pure, fixture ProjectIndexData literals).
 *
 * Proves impact scoping, the nearest→package→full ordering, conservative escalation, the
 * no-vacuous-green rules, and the HARD invariant: required-but-underivable full ⇒ a blocking
 * marker, never a passable empty full stage.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileEntry, ImportEdge, PackageEntry, ProjectIndexData } from "../project-index/index.js";
import { createVerificationLadder } from "./index.js";

const plan = createVerificationLadder().planVerification;

function file(path: string, opts: { isTest?: boolean; size?: number } = {}): FileEntry {
  return { path, lang: path.endsWith(".ts") ? "ts" : "other", size: opts.size ?? 50, mtimeMs: 0, hash: "h", isTest: opts.isTest ?? false };
}
function pkg(root: string, scripts: Record<string, string>, manager: PackageEntry["manager"] = "pnpm"): PackageEntry {
  return { root, name: root || "root", manager, scripts };
}
function edge(from: string, to: string): ImportEdge {
  return { from, to, specifier: "x", kind: "relative" };
}
function mkData(p: Partial<ProjectIndexData>): ProjectIndexData {
  return {
    version: 1, repoPath: "/r", repoHash: "abc",
    files: p.files ?? [], packages: p.packages ?? [], imports: p.imports ?? [],
    fileToTests: p.fileToTests ?? {}, truncated: p.truncated ?? false,
  };
}
const stageOf = (pl: ReturnType<typeof plan>, name: string) => pl.stages.find((s) => s.stage === name);

test("local change → impact scope: nearest tests + package checks, no full stage", () => {
  const data = mkData({
    packages: [pkg("packages/a", { test: "vitest run", build: "tsc -p ." })],
    files: [file("packages/a/src/foo.ts"), file("packages/a/src/foo.test.ts", { isTest: true })],
    fileToTests: { "packages/a/src/foo.ts": ["packages/a/src/foo.test.ts"] },
  });
  const pl = plan({ data, changedFiles: ["packages/a/src/foo.ts"] });
  assert.equal(pl.escalateToFull, false);
  assert.equal(pl.scope, "impact");
  assert.equal(pl.status, "ok");
  assert.deepEqual(pl.affectedPackages, ["packages/a"]);
  const near = stageOf(pl, "nearest-tests");
  assert.ok(near, "nearest-tests stage present");
  assert.deepEqual(near?.tasks[0]?.targets, ["packages/a/src/foo.test.ts"], "narrowed to the colocated test");
  assert.ok(stageOf(pl, "package-checks"), "package-checks present");
  assert.equal(stageOf(pl, "full"), undefined, "no full stage for a local change");
});

test("cross-package import → escalate to full", () => {
  const data = mkData({
    packages: [pkg("", { test: "pnpm -r test" }), pkg("packages/a", { test: "vitest" }), pkg("packages/b", { test: "vitest" })],
    files: [file("packages/a/src/util.ts"), file("packages/b/src/x.ts")],
    imports: [edge("packages/b/src/x.ts", "packages/a/src/util.ts")], // b imports a's util
  });
  const pl = plan({ data, changedFiles: ["packages/a/src/util.ts"] });
  assert.equal(pl.escalateToFull, true);
  assert.ok(pl.escalationReasons.some((r) => /cross-cutting/.test(r)));
  assert.equal(pl.scope, "full");
  assert.equal(pl.status, "ok");
  assert.ok(stageOf(pl, "full"), "full stage present (root has a test script)");
});

test("shared/root file (tsconfig) → escalate to full", () => {
  const data = mkData({
    packages: [pkg("", { test: "pnpm -r test" }), pkg("packages/a", { test: "vitest" })],
    files: [file("tsconfig.json"), file("packages/a/src/foo.ts")],
  });
  const pl = plan({ data, changedFiles: ["tsconfig.json", "packages/a/src/foo.ts"] });
  assert.equal(pl.escalateToFull, true);
  assert.ok(pl.escalationReasons.some((r) => /shared\/root file changed: tsconfig\.json/.test(r)));
  assert.ok(stageOf(pl, "full"));
});

test("transitive reverse-import dependent's test is pulled into affectedTests (same package, no escalation)", () => {
  const data = mkData({
    packages: [pkg("packages/a", { test: "vitest" })],
    files: [file("packages/a/src/util.ts"), file("packages/a/src/widget.ts"), file("packages/a/src/widget.test.ts", { isTest: true })],
    imports: [edge("packages/a/src/widget.ts", "packages/a/src/util.ts")], // widget imports util
    fileToTests: { "packages/a/src/widget.ts": ["packages/a/src/widget.test.ts"] },
  });
  const pl = plan({ data, changedFiles: ["packages/a/src/util.ts"] });
  assert.equal(pl.escalateToFull, false, "same-package dependent → no cross-package escalation");
  assert.ok(pl.affectedTests.includes("packages/a/src/widget.test.ts"), "dependent's test pulled in transitively");
});

test("a package with no runnable script is NEUTRAL, never counted green", () => {
  const data = mkData({
    packages: [pkg("", { test: "pnpm -r test" }), pkg("packages/a", {})], // a has NO scripts
    files: [file("packages/a/src/foo.ts")],
  });
  const pl = plan({ data, changedFiles: ["packages/a/src/foo.ts"] });
  assert.deepEqual(pl.neutralPackages, ["packages/a"]);
  // all affected packages neutral ⇒ a scoped pass would be vacuous ⇒ escalate to full
  assert.equal(pl.escalateToFull, true);
  assert.ok(pl.escalationReasons.some((r) => /vacuous/.test(r)));
  assert.ok(stageOf(pl, "full"), "full derivable from the root package");
});

test("INVARIANT: escalate-to-full but NO runnable full check ⇒ BLOCKED with a non-passable marker (never an empty full stage)", () => {
  const data = mkData({
    packages: [pkg("packages/a", {})], // a is neutral, and there is NO root package and no fullChecks
    files: [file("packages/a/src/foo.ts")],
  });
  const pl = plan({ data, changedFiles: ["packages/a/src/foo.ts"] });
  assert.equal(pl.escalateToFull, true, "full required (all affected neutral)");
  assert.equal(pl.status, "blocked");
  assert.equal(pl.blocked, true);
  assert.ok(pl.blockReasons.some((r) => /REQUIRED.*no runnable full-repo checks/i.test(r)), "block reason explains required-but-unavailable");
  const full = stageOf(pl, "full");
  assert.ok(full, "a full stage exists");
  assert.equal(full?.tasks.length, 1, "exactly the blocking marker — NOT an empty (vacuously-green) stage");
  assert.equal(full?.tasks[0]?.blocking, true, "the marker is blocking");
  assert.equal(full?.tasks[0]?.command, "", "the marker is non-runnable (empty command)");
  assert.ok(pl.receipts.some((r) => /^BLOCKED:/.test(r)), "receipts record the block");
});

test("operator fullChecks override makes full derivable (no block)", () => {
  const data = mkData({ packages: [pkg("packages/a", {})], files: [file("packages/a/src/foo.ts")] });
  const pl = plan({ data, changedFiles: ["packages/a/src/foo.ts"], opts: { fullChecks: [{ name: "test", command: "make", args: ["test"] }] } });
  assert.equal(pl.escalateToFull, true);
  assert.equal(pl.blocked, false);
  assert.equal(stageOf(pl, "full")?.tasks[0]?.command, "make", "operator full check used");
});

test("empty / garbage input → escalate to full with a reason (and blocked when no full derivable)", () => {
  const pl = plan({ data: mkData({}), changedFiles: [] });
  assert.equal(pl.escalateToFull, true);
  assert.ok(pl.escalationReasons.length > 0, "a reason is given");
  assert.equal(pl.blocked, true, "no packages ⇒ no full ⇒ blocked (never a vacuous pass)");
});

test("deterministic: identical inputs → identical plan", () => {
  const data = mkData({
    packages: [pkg("", { test: "pnpm -r test" }), pkg("packages/a", { test: "vitest" })],
    files: [file("packages/a/src/foo.ts"), file("packages/a/src/foo.test.ts", { isTest: true })],
    fileToTests: { "packages/a/src/foo.ts": ["packages/a/src/foo.test.ts"] },
  });
  const a = plan({ data, changedFiles: ["packages/a/src/foo.ts"] });
  const b = plan({ data, changedFiles: ["packages/a/src/foo.ts"] });
  assert.deepEqual(a, b);
});
