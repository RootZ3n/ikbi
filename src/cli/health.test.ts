import assert from "node:assert/strict";
import { test } from "node:test";

import { createHealthCli, renderReport } from "./health.js";
import { runAllAnalyzers } from "../modules/repo-doctor/index.js";

// Score this very repo — the analyzers are read-only and offline, so no fixture needed.
const REPO = new URL("../../", import.meta.url).pathname;

test("renderReport shows an overall score and all 6 dimensions", () => {
  const out = renderReport(runAllAnalyzers(REPO));
  assert.match(out, /Repo health: \d+\/100/);
  for (const dim of ["file-health", "dependency-health", "test-health", "doc-health", "import-health", "structure-health"]) {
    assert.match(out, new RegExp(dim), `report shows ${dim}`);
  }
});

test("CLI prints a human report with a Next: footer", () => {
  let buf = "";
  createHealthCli({ stdout: (s) => { buf += s; } }).run(["--repo", REPO]);
  assert.match(buf, /Repo health:/);
  assert.match(buf, /Next:/);
});

test("CLI --json emits a parseable report and no footer", () => {
  let buf = "";
  createHealthCli({ stdout: (s) => { buf += s; } }).run(["--repo", REPO, "--json"]);
  const parsed = JSON.parse(buf) as { overallScore: number; dimensions: unknown[] };
  assert.equal(typeof parsed.overallScore, "number");
  assert.equal(parsed.dimensions.length, 6);
  assert.doesNotMatch(buf, /Next:/);
});

test("CLI --dimension runs a single analyzer; unknown dimension fails closed", () => {
  let out = "";
  createHealthCli({ stdout: (s) => { out += s; } }).run(["--repo", REPO, "--dimension", "test-health", "--json"]);
  const one = JSON.parse(out) as { dimension: string };
  assert.equal(one.dimension, "test-health");

  let err = "";
  const prev = process.exitCode;
  createHealthCli({ stdout: () => {}, stderr: (s) => { err += s; } }).run(["--dimension", "nope"]);
  const code = process.exitCode;
  process.exitCode = prev; // restore so a fail-closed assertion doesn't taint the runner
  assert.match(err, /unknown dimension/);
  assert.equal(code, 1);
});
