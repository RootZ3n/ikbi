import assert from "node:assert/strict";
import { test } from "node:test";

import { detectWriteScope } from "./cli.js";

// REGRESSION: a whole-product build goal was misrouted to write_scope "new_only" — "build" was not a
// recognized create verb, so the goal fell through to the doc/audit patterns where "read-only by
// default" (spec language describing the TARGET software, not the build task) matched. Under new_only
// the builder cannot modify files it just created, tripped repeated blocked writes, and stopped with
// stuck_detected after writing ~3900 lines of a nearly-complete project.
test("detectWriteScope: a build goal that describes read-only target software is still write-all", () => {
  const goal =
    "Build the complete Osapa MVP 0.1 field kit exactly as specified in SCOPE.md: collectors are " +
    "read-only by default, null-never-synthesized, fully unit-tested. pnpm test must pass.";
  assert.equal(detectWriteScope(goal), "all");
});

test("detectWriteScope: construction verbs map to write-all", () => {
  for (const goal of [
    "build the app",
    "Build a CLI tool",
    "build all of osapa from the spec",
    "scaffold a new service",
    "scaffold the entire project",
    "implement feature X",
    "add a new endpoint",
    "rebuild the module",
  ]) {
    assert.equal(detectWriteScope(goal), "all", `"${goal}" should be write-all`);
  }
});

test("detectWriteScope: genuine read/audit goals still restrict to new_only", () => {
  for (const goal of [
    "audit the codebase and write a report",
    "review this repo read-only and generate documentation",
    "analyze the dependencies and create a report",
    "audit the build pipeline", // "build" as a NOUN must NOT flip an audit to write-all
    "do not modify anything, just add architecture docs",
  ]) {
    assert.equal(detectWriteScope(goal), "new_only", `"${goal}" should be new_only`);
  }
});
