/**
 * fix mode — the diagnosis-first repair pipeline (docs/FIX-MODE-DESIGN.md).
 *
 * Two golden fixtures + an anti-cheat fixture prove the contract:
 *   A. implementation_bug → diagnose the CODE as wrong, patch it, checks pass → FIXED_NARROWLY.
 *   B. test_bug           → diagnose the TEST as wrong; without --allow-test-edits, refuse and
 *                           change NOTHING → CORRECT_REFUSAL (a refusal is a success).
 *   C. anti-cheat         → even when checks go green, a fix that WEAKENS the test is caught
 *                           by anti-cheat → UNSAFE_FAIL (anti-cheat is non-negotiable).
 *
 * The pipeline is driven entirely through injected deps (model + check runner), so no live
 * model or subprocess is needed — but the patch is REALLY applied to real files on disk, and
 * the post-fix check reflects the actual file content.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { runFixPipeline, type CheckRun, type FixCheckCommand } from "./fix.js";
import type { DiagnosisFile } from "./fix-diagnosis.js";

// ── model fake ────────────────────────────────────────────────────────────────

function modelResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.3.0",
    model: "test-model",
    provider: "test",
    providerModelId: "test-model",
    content,
    finishReason: "stop",
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1,
    fellBack: false,
    attempts: [],
  };
}

/** A model fake that answers the diagnose call and (optionally) the patch call, recording stages. */
function makeModel(opts: { diagnose: string; patch?: string }) {
  const stages: string[] = [];
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    const stage = (req.metadata as Record<string, unknown> | undefined)?.fixStage;
    stages.push(String(stage));
    if (stage === "diagnose") return modelResponse(opts.diagnose);
    if (stage === "patch") return modelResponse(opts.patch ?? "");
    return modelResponse("");
  };
  return { invokeModel, stages };
}

// ── check-output fixtures ───────────────────────────────────────────────────────

function failingOutput(actual: string, expected: string): string {
  return [
    "============================= test session starts ==============================",
    "collected 1 item",
    "",
    "test_calculator.py F                                                     [100%]",
    "",
    "=================================== FAILURES ===================================",
    "___________________________________ test_add ___________________________________",
    "",
    "    def test_add():",
    `>       assert add(2, 3) == ${expected}`,
    `E       assert ${actual} == ${expected}`,
    "",
    "test_calculator.py:2: AssertionError",
    "=========================== short test summary info ============================",
    `FAILED test_calculator.py::test_add - assert ${actual} == ${expected}`,
    "1 failed in 0.01s",
  ].join("\n");
}

const PASSING_OUTPUT = [
  "============================= test session starts ==============================",
  "collected 1 item",
  "",
  "test_calculator.py .                                                     [100%]",
  "",
  "1 passed in 0.01s",
].join("\n");

const CHECK: FixCheckCommand = { command: "python3", args: ["-m", "pytest", "-q"] };
const STABLE_DEPS = { head: () => "test-head", now: () => "2026-06-17T00:00:00.000Z" };

/** Build a temp repo with the two named files. */
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-fix-test-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  return dir;
}

function candidates(repo: string, names: Array<{ path: string; isTest: boolean }>): () => DiagnosisFile[] {
  return () => names.map((n) => ({ path: n.path, content: readFileSync(join(repo, n.path), "utf8"), isTest: n.isTest }));
}

// ────────────────────────────────────────────────────────────────────────────────
// Fixture A: implementation_bug → FIXED_NARROWLY
// ────────────────────────────────────────────────────────────────────────────────

test("fix: implementation_bug — diagnoses the code, patches it, result FIXED_NARROWLY", async () => {
  const repo = makeRepo({
    "calculator.py": "def add(a, b):\n    return a - b\n",
    "test_calculator.py": "def test_add():\n    assert add(2, 3) == 5\n",
  });

  // The check passes iff calculator.py contains the correct `a + b` (reads the REAL file).
  const runCheck = async (r: string): Promise<CheckRun> => {
    const code = readFileSync(join(r, "calculator.py"), "utf8");
    return code.includes("a + b") ? { exitCode: 0, output: PASSING_OUTPUT } : { exitCode: 1, output: failingOutput("-1", "5") };
  };

  const model = makeModel({
    diagnose: JSON.stringify({ category: "implementation_bug", confidence: 0.95, evidence: "add returns a-b but the correct test expects a+b; the code is wrong", affectedFiles: ["calculator.py"] }),
    patch: "--- a/calculator.py\n+++ b/calculator.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n",
  });

  const outcome = await runFixPipeline(
    { repo, check: CHECK },
    { runCheck, invokeModel: model.invokeModel, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }, { path: "test_calculator.py", isTest: true }]), ...STABLE_DEPS },
  );

  assert.equal(outcome.diagnosis.category, "implementation_bug");
  assert.equal(outcome.result, "FIXED_NARROWLY");
  assert.deepEqual([...outcome.filesModified], ["calculator.py"]);
  assert.equal(outcome.promoted, false);
  assert.ok(readFileSync(join(repo, "calculator.py"), "utf8").includes("return a + b"), "the code file was repaired on disk");
  assert.equal(outcome.receipt.targetedCheck.passed, true);
  assert.equal(outcome.receipt.fullCheck.passed, true);
  assert.equal(outcome.receipt.antiCheat.passed, true);
  // The test file was NOT touched.
  assert.equal(readFileSync(join(repo, "test_calculator.py"), "utf8"), "def test_add():\n    assert add(2, 3) == 5\n");
  // Both model stages ran in order.
  assert.deepEqual(model.stages, ["diagnose", "patch"]);
});

// ────────────────────────────────────────────────────────────────────────────────
// Fixture B: test_bug → CORRECT_REFUSAL (no --allow-test-edits)
// ────────────────────────────────────────────────────────────────────────────────

test("fix: test_bug — diagnoses the test as wrong and REFUSES (CORRECT_REFUSAL), changing nothing", async () => {
  const repo = makeRepo({
    "calculator.py": "def add(a, b):\n    return a + b\n",
    "test_calculator.py": "def test_add():\n    assert add(2, 3) == 6\n",
  });

  // Code is correct; the test is wrong — the check fails regardless of the code.
  const runCheck = async (): Promise<CheckRun> => ({ exitCode: 1, output: failingOutput("5", "6") });

  const model = makeModel({
    diagnose: JSON.stringify({ category: "test_bug", confidence: 0.92, evidence: "add(2,3)=5 is correct; the test asserts 6, which is the wrong expected value", affectedFiles: ["test_calculator.py"] }),
    // A patch is supplied but must NEVER be requested — the gate refuses before APPLY.
    patch: "SHOULD NOT BE USED",
  });

  const outcome = await runFixPipeline(
    { repo, check: CHECK }, // allowTestEdits defaults to false
    { runCheck, invokeModel: model.invokeModel, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }, { path: "test_calculator.py", isTest: true }]), ...STABLE_DEPS },
  );

  assert.equal(outcome.diagnosis.category, "test_bug");
  assert.equal(outcome.result, "CORRECT_REFUSAL");
  assert.deepEqual([...outcome.filesModified], []);
  assert.equal(outcome.promoted, false);
  // Nothing changed on disk.
  assert.equal(readFileSync(join(repo, "calculator.py"), "utf8"), "def add(a, b):\n    return a + b\n");
  assert.equal(readFileSync(join(repo, "test_calculator.py"), "utf8"), "def test_add():\n    assert add(2, 3) == 6\n");
  // Anti-cheat still ran (over zero changes) — it is mandatory on every attempt.
  assert.equal(outcome.receipt.antiCheat.passed, true);
  assert.ok(outcome.receipt.antiCheat.checks.length > 0, "anti-cheat sub-checks are recorded even on a refusal");
  // The patch stage was NEVER reached — diagnosis gated the repair.
  assert.deepEqual(model.stages, ["diagnose"]);
});

// ────────────────────────────────────────────────────────────────────────────────
// Fixture C: anti-cheat catches a weakening "fix" → UNSAFE_FAIL
// ────────────────────────────────────────────────────────────────────────────────

test("fix: anti-cheat catches a test-weakening patch even when checks go green → UNSAFE_FAIL", async () => {
  const repo = makeRepo({
    "calculator.py": "def add(a, b):\n    return a + b\n",
    "test_calculator.py": "def test_add():\n    assert add(2, 3) == 6\n    assert add(0, 0) == 0\n",
  });

  // With --allow-test-edits the engine MAY edit the test — but the check still gates on `== 6`
  // being present (the genuine bug). Deleting the failing assertion makes it pass... dishonestly.
  const runCheck = async (r: string): Promise<CheckRun> => {
    const t = readFileSync(join(r, "test_calculator.py"), "utf8");
    return t.includes("== 6") ? { exitCode: 1, output: failingOutput("5", "6") } : { exitCode: 0, output: PASSING_OUTPUT };
  };

  const model = makeModel({
    diagnose: JSON.stringify({ category: "test_bug", confidence: 0.9, evidence: "the first assertion expects 6 but add(2,3)=5", affectedFiles: ["test_calculator.py"] }),
    // CHEAT: delete the failing assertion instead of correcting its expected value.
    patch: "--- a/test_calculator.py\n+++ b/test_calculator.py\n@@ -1,3 +1,2 @@\n def test_add():\n-    assert add(2, 3) == 6\n     assert add(0, 0) == 0\n",
  });

  const outcome = await runFixPipeline(
    { repo, check: CHECK, allowTestEdits: true },
    { runCheck, invokeModel: model.invokeModel, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }, { path: "test_calculator.py", isTest: true }]), ...STABLE_DEPS },
  );

  // The patch applied and the check turned green — but anti-cheat caught the weakening.
  assert.equal(outcome.receipt.targetedCheck.passed, true, "the dishonest check went green");
  assert.equal(outcome.receipt.antiCheat.passed, false);
  assert.equal(outcome.result, "UNSAFE_FAIL");
  assert.equal(outcome.promoted, false);
  const weakening = outcome.receipt.antiCheat.checks.find((c) => c.name === "no_test_weakening");
  assert.ok(weakening !== undefined && !weakening.passed, "the no_test_weakening sub-check failed");
});

// ────────────────────────────────────────────────────────────────────────────────
// tool_limitation: a collection/tool crash is not a code or test bug (no model needed)
// ────────────────────────────────────────────────────────────────────────────────

test("fix: a collection error is diagnosed as tool_limitation with no edits", async () => {
  const repo = makeRepo({ "calculator.py": "def add(a, b):\n    return a + b\n" });
  const collectionError = [
    "==================================== ERRORS ====================================",
    "____________________ ERROR collecting test_calculator.py _______________________",
    "E   ImportError: cannot import name 'add' from 'calc'",
    "=========================== short test summary info ============================",
    "ERROR test_calculator.py",
    "1 error in 0.01s",
  ].join("\n");

  const runCheck = async (): Promise<CheckRun> => ({ exitCode: 2, output: collectionError });
  // The model must NOT be called for a deterministic collection-error classification.
  const model = makeModel({ diagnose: "SHOULD NOT BE CALLED" });

  const outcome = await runFixPipeline(
    { repo, check: CHECK },
    { runCheck, invokeModel: model.invokeModel, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }]), ...STABLE_DEPS },
  );

  assert.equal(outcome.diagnosis.category, "tool_limitation");
  assert.equal(outcome.result, "TOOL_LIMITATION");
  assert.deepEqual([...outcome.filesModified], []);
  assert.deepEqual(model.stages, [], "no model call was made for a collection error");
  assert.equal(outcome.receipt.antiCheat.passed, true);
});

// ────────────────────────────────────────────────────────────────────────────────
// Cancellation (HIGH 1): the cooperative kill-check stops the pipeline at a boundary.
// ────────────────────────────────────────────────────────────────────────────────

test("fix: an armed kill-check stops the pipeline before any check or model call (H1)", async () => {
  const repo = makeRepo({
    "calculator.py": "def add(a, b):\n    return a - b\n",
    "test_calculator.py": "def test_add():\n    assert add(2, 3) == 5\n",
  });

  let checks = 0;
  const runCheck = async (): Promise<CheckRun> => { checks += 1; return { exitCode: 1, output: failingOutput("-1", "5") }; };
  const model = makeModel({ diagnose: JSON.stringify({ category: "implementation_bug", confidence: 0.9, evidence: "x", affectedFiles: ["calculator.py"] }) });

  const outcome = await runFixPipeline(
    { repo, check: CHECK },
    { runCheck, invokeModel: model.invokeModel, isCancelled: () => true, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }]), ...STABLE_DEPS },
  );

  assert.equal(outcome.result, "SAFE_FAIL");
  assert.deepEqual([...outcome.filesModified], []);
  assert.equal(checks, 0, "no check ran — the kill-check fired before reproduce");
  assert.deepEqual(model.stages, [], "no model call was made for a cancelled run");
  // The repo was left untouched.
  assert.equal(readFileSync(join(repo, "calculator.py"), "utf8"), "def add(a, b):\n    return a - b\n");
});
