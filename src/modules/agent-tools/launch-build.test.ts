/**
 * launch_build — Peh's confirm-gated bridge to a real ikbi build. These test the pure runner with a
 * MOCKED spawn (no subprocess): the guards (goal/repo required), the promoted-vs-not verdict, and
 * that the goal reaches `ikbi build` as a single argv element (never shell-interpolated → no inject).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import type { spawn as SpawnType } from "node:child_process";

import { runLaunchBuild } from "./launch-build.js";

/** A fake spawn that emits the given stdout then closes with `code`; records the argv it was given. */
function mockSpawn(stdout: string, code: number, sink?: { args?: readonly string[] }): typeof SpawnType {
  return ((_exec: string, args: readonly string[]) => {
    if (sink !== undefined) sink.args = args;
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (stdout.length > 0) child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code);
    });
    return child;
  }) as unknown as typeof SpawnType;
}

const throwingSpawn = (() => { throw new Error("spawn should not be called"); }) as unknown as typeof SpawnType;

test("a missing goal errors and never spawns", async () => {
  const r = await runLaunchBuild({}, { sessionRepo: "/x", cliEntry: "cli", execPath: "node", spawnFn: throwingSpawn });
  assert.equal(r.ok, false);
  assert.match(r.output, /needs a non-empty 'goal'/);
});

test("no target repo errors and never spawns", async () => {
  const r = await runLaunchBuild({ goal: "do x" }, { sessionRepo: undefined, cliEntry: "cli", execPath: "node", spawnFn: throwingSpawn });
  assert.equal(r.ok, false);
  assert.match(r.output, /no target repo/);
});

test("a promoted build → ok + promoted summary; goal is a single argv element (no shell)", async () => {
  const sink: { args?: readonly string[] } = {};
  const warnings: string[] = [];
  const spawnFn = mockSpawn('scout...\n"promoted": true\nUndo available: yes\nikbi undo build-9\n', 0, sink);
  const r = await runLaunchBuild({ goal: "add a health test", repo: "/repo/x" }, { sessionRepo: "/session/repo", cliEntry: "/dist/cli.js", execPath: "node", spawnFn, warn: (m) => warnings.push(m) });
  assert.equal(r.ok, true);
  assert.match(r.summary, /promoted/);
  // The stale explicit repo arg is ignored; the goal rides as ONE argv item, unescaped.
  assert.deepEqual([...(sink.args ?? [])].slice(0, 6), ["/dist/cli.js", "build", "add a health test", "--repo", "/session/repo", "--yes"]);
  assert.match(warnings.join("\n"), /ignoring model-supplied repo/);
});

test("uses the session repo when no repo arg is given", async () => {
  const sink: { args?: readonly string[] } = {};
  const spawnFn = mockSpawn("Build REJECTED\n", 0, sink);
  await runLaunchBuild({ goal: "x" }, { sessionRepo: "/session/repo", cliEntry: "cli", execPath: "node", spawnFn });
  assert.equal((sink.args ?? [])[4], "/session/repo");
});

test("a non-zero exit → not ok, not promoted", async () => {
  const spawnFn = mockSpawn("Build FAILED — builder\n", 1);
  const r = await runLaunchBuild({ goal: "x" }, { sessionRepo: "/session/repo", cliEntry: "cli", execPath: "node", spawnFn });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.summary, /promoted/);
});
