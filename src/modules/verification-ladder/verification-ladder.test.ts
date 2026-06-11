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
import { createVerificationLadder, isStubScript, verificationLadderConfig } from "./index.js";

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
    ...(p.graphHoles !== undefined ? { graphHoles: p.graphHoles } : {}),
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

test("unresolved asset graph hole → escalates to full, never unsafe impact-green", () => {
  const data = mkData({
    packages: [pkg("", { test: "pnpm -r test" }), pkg("packages/theme", { test: "vitest" })],
    files: [file("packages/theme/styles.css")],
    graphHoles: { unresolved: 1 },
  });
  const pl = plan({ data, changedFiles: ["packages/theme/styles.css"] });
  assert.equal(pl.scope, "full");
  assert.equal(pl.escalateToFull, true);
  assert.ok(pl.escalationReasons.some((r) => /graph hole/.test(r)), "asset graph uncertainty is explicit");
  assert.ok(stageOf(pl, "full"), "full stage present");
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

// ── P0/F1: stub/no-op verification scripts never produce green ──────────────────────
test("P0/F1: a root test script that is a STUB ('echo pass') does NOT produce green — it blocks", () => {
  const data = mkData({ packages: [pkg("", { test: "echo pass" })], files: [file("src/foo.ts")] });
  const pl = plan({ data, changedFiles: ["src/foo.ts"] });
  assert.ok(pl.stubScripts.includes("(root):test"), "the stub script is recorded");
  assert.equal(pl.status, "blocked", "a no-op check is not meaningful verification → blocked");
  assert.equal(pl.blocked, true);
  assert.ok(pl.escalationReasons.some((r) => /stub|no-op/.test(r)), "escalation cites the stub");
});

test("P0/F1: stub variants (true / exit 0 / : / empty / echo … && exit 0) are all detected", () => {
  for (const body of ["echo pass", "true", "exit 0", ":", "", "echo all good && exit 0"]) {
    assert.equal(isStubScript(body), true, `stub: "${body}"`);
  }
  for (const body of ["vitest run", "tsc --noEmit", "node test.js", "echo start && vitest run"]) {
    assert.equal(isStubScript(body), false, `real: "${body}"`);
  }
});

test("P0/F1: operator opt-in (trustTrivialScripts) lets a trivial script count", () => {
  const trusting = createVerificationLadder({ ...verificationLadderConfig, trustTrivialScripts: true }).planVerification;
  const data = mkData({ packages: [pkg("", { test: "echo pass" })], files: [file("src/foo.ts")] });
  const pl = trusting({ data, changedFiles: ["src/foo.ts"] });
  assert.equal(pl.blocked, false, "operator explicitly trusts trivial scripts");
  assert.ok(pl.stages.some((s) => s.tasks.length > 0), "a runnable task exists under the opt-in");
});

// ── P0/F2: unresolved path aliases force full verification ──────────────────────────
test("P0/F2: unresolved path aliases force full verification (graph holes)", () => {
  const base = mkData({ packages: [pkg("", { test: "pnpm -r test" }), pkg("packages/a", { test: "vitest" })], files: [file("packages/a/src/foo.ts")] });
  const data = { ...base, aliases: { present: true, unresolved: 2 } };
  const pl = plan({ data, changedFiles: ["packages/a/src/foo.ts"] });
  assert.equal(pl.escalateToFull, true);
  assert.ok(pl.escalationReasons.some((r) => /alias/.test(r)), "escalation cites unresolved aliases");
  assert.equal(pl.scope, "full");
});

test("P0/Fix3: comment-disguised no-ops and no-test passes are detected as stubs", () => {
  for (const body of ["exit 0 # but actually", "true # noop", ": # nothing", "echo pass # done", "jest --passWithNoTests", "vitest run --passWithNoTests"]) {
    assert.equal(isStubScript(body), true, `stub: "${body}"`);
  }
  for (const body of ["vitest run", "tsc --noEmit", "node test.js # run tests"]) {
    assert.equal(isStubScript(body), false, `real: "${body}"`);
  }
});

// ── C1: ladder emits the `run`-less shorthand for pnpm/yarn so governed-exec (which bans
//        `<mgr> run <script>`) lets a real typecheck/build pass instead of denying it → RED ──────
test("C1: non-test scripts use shorthand for pnpm/yarn, `run` only for npm", () => {
  const taskArgs = (manager: PackageEntry["manager"], key: string) => {
    const data = mkData({
      packages: [pkg("packages/a", { [key]: key === "typecheck" ? "tsc --noEmit" : "tsc -p ." }, manager)],
      files: [file("packages/a/src/foo.ts")],
    });
    const pl = plan({ data, changedFiles: ["packages/a/src/foo.ts"] });
    const task = stageOf(pl, "package-checks")?.tasks.find((t) => t.name === key);
    return { command: task?.command, args: task?.args };
  };
  // pnpm/yarn: `<mgr> typecheck` — NO `run` keyword (governed-exec bans `<mgr> run`).
  assert.deepEqual(taskArgs("pnpm", "typecheck"), { command: "pnpm", args: ["typecheck"] });
  assert.deepEqual(taskArgs("pnpm", "build"), { command: "pnpm", args: ["build"] });
  assert.deepEqual(taskArgs("yarn", "build"), { command: "yarn", args: ["build"] });
  // npm/unknown: `npm run <script>` shorthand is not valid → keep `run` (npm is not the ban target).
  assert.deepEqual(taskArgs("npm", "build"), { command: "npm", args: ["run", "build"] });
  assert.deepEqual(taskArgs("unknown", "build"), { command: "npm", args: ["run", "build"] });
  // `test` is always the bare `<mgr> test` for every manager.
  assert.deepEqual(taskArgs("pnpm", "test"), { command: "pnpm", args: ["test"] });
  assert.deepEqual(taskArgs("npm", "test"), { command: "npm", args: ["test"] });
});
