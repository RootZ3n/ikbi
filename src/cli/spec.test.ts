import assert from "node:assert/strict";
import { test } from "node:test";

import { createSpecCli, renderSpec } from "./spec.js";
import type { SpecArtifact } from "../modules/spec-artifact/index.js";

function spec(over: Partial<SpecArtifact> = {}): SpecArtifact {
  return {
    id: "spec-abc",
    goal: "add OAuth login",
    steps: [
      { index: 1, goal: "add the auth route", targetFiles: ["src/auth.ts"] },
      { index: 2, goal: "wire the session middleware" },
    ],
    status: "draft",
    createdAt: "2026-06-23T00:00:00Z",
    updatedAt: "2026-06-23T00:00:00Z",
    ...over,
  } as SpecArtifact;
}

function cli(over: Parameters<typeof createSpecCli>[0] = {}) {
  let out = "";
  let err = "";
  let exit: number | undefined;
  const c = createSpecCli({ stdout: (s) => { out += s; }, stderr: (s) => { err += s; }, setExit: (n) => { exit = n; }, ...over });
  return { run: c.run, get out() { return out; }, get err() { return err; }, get exit() { return exit; } };
}

test("renderSpec shows status in plain language and lists steps", () => {
  const s = renderSpec(spec());
  assert.match(s, /Spec spec-abc/);
  assert.match(s, /draft — editable/);
  assert.match(s, /1\. add the auth route/);
  assert.match(s, /src\/auth\.ts/);
});

test("list shows id, status, and step count", () => {
  const c = cli({ list: () => [spec()] });
  c.run(["list"]);
  assert.match(c.out, /Specs \(1\)/);
  assert.match(c.out, /spec-abc/);
  assert.match(c.out, /2 step/);
  assert.match(c.out, /Next:/);
});

test("list is friendly when empty", () => {
  const c = cli({ list: () => [] });
  c.run(["list"]);
  assert.match(c.out, /No specs yet/);
});

test("status renders one spec; unknown id errors", () => {
  const c = cli({ get: (id) => (id === "spec-abc" ? spec() : undefined) });
  c.run(["status", "spec-abc"]);
  assert.match(c.out, /Status:/);
  const c2 = cli({ get: () => undefined });
  c2.run(["status", "nope"]);
  assert.match(c2.err, /no spec "nope"/);
  assert.equal(c2.exit, 1);
});

test("create generates a spec and reports it", () => {
  const c = cli({ create: (goal) => spec({ goal }) });
  c.run(["create", "add", "OAuth", "login"]);
  assert.match(c.out, /Created spec spec-abc/);
  assert.match(c.out, /Next:/);
});

test("create with no goal errors", () => {
  const c = cli();
  c.run(["create"]);
  assert.match(c.err, /usage: ikbi spec create/);
  assert.equal(c.exit, 1);
});

test("no subcommand prints usage", () => {
  const c = cli();
  c.run([]);
  assert.match(c.out, /Usage: ikbi spec/);
});
