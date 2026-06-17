/**
 * fix mode — THE FIX-RETRY LOOP (Gap M6).
 *
 * The cheap builder diagnoses a bug far more reliably than it fixes it on the first try. When a
 * patch applies cleanly but the check still fails, the pipeline feeds the verification output back
 * and re-prompts for a DIFFERENT approach, up to MAX_FIX_ATTEMPTS. These tests prove:
 *   A. a first patch that does not fix the bug is retried, the second patch fixes it → FIXED_NARROWLY,
 *      receipt.attempts === 2, and the retry prompt carried the previous (failed) diff + feedback.
 *   B. when every attempt fails verification (but never cheats), the loop gives up at
 *      MAX_FIX_ATTEMPTS → SAFE_FAIL with receipt.attempts === MAX_FIX_ATTEMPTS.
 *   C. an anti-cheat catch is TERMINAL on the first attempt — a cheat is never retried.
 *   D. a clean first-attempt fix records attempts === 1 (no needless retry).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { MAX_FIX_ATTEMPTS, runFixPipeline, type CheckRun, type FixCheckCommand } from "./fix.js";
import type { DiagnosisFile } from "./fix-diagnosis.js";

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

/**
 * A model fake that answers the diagnose call once and then returns one patch per attempt (keyed on
 * the `fixAttempt` metadata the pipeline tags onto each retry). Records every patch request body so
 * a test can assert the retry prompt carried the prior failed diff + feedback.
 */
function makeRetryModel(opts: { diagnose: string; patches: string[] }) {
  const patchRequests: ModelRequest[] = [];
  const invokeModel = async (req: ModelRequest): Promise<ModelResponse> => {
    const meta = req.metadata as Record<string, unknown> | undefined;
    if (meta?.fixStage === "diagnose") return modelResponse(opts.diagnose);
    if (meta?.fixStage === "patch") {
      patchRequests.push(req);
      const attempt = Number(meta.fixAttempt ?? patchRequests.length);
      return modelResponse(opts.patches[attempt - 1] ?? opts.patches[opts.patches.length - 1] ?? "");
    }
    return modelResponse("");
  };
  return { invokeModel, patchRequests };
}

const CHECK: FixCheckCommand = { command: "python3", args: ["-m", "pytest", "-q"] };
const STABLE_DEPS = { head: () => "test-head", now: () => "2026-06-17T00:00:00.000Z" };

const PASSING_OUTPUT = "1 passed in 0.01s";
function failingOutput(actual: string): string {
  return [
    "=================================== FAILURES ===================================",
    "___________________________________ test_add ___________________________________",
    `E       assert ${actual} == 5`,
    "=========================== short test summary info ============================",
    `FAILED test_calculator.py::test_add - assert ${actual} == 5`,
    "1 failed in 0.01s",
  ].join("\n");
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ikbi-fix-retry-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
  return dir;
}

function candidates(repo: string, names: Array<{ path: string; isTest: boolean }>): () => DiagnosisFile[] {
  return () => names.map((n) => ({ path: n.path, content: readFileSync(join(repo, n.path), "utf8"), isTest: n.isTest }));
}

const DIAGNOSIS = JSON.stringify({
  category: "implementation_bug",
  confidence: 0.95,
  evidence: "add returns the wrong value; the code is wrong, the test is correct",
  affectedFiles: ["calculator.py"],
});

/** Patch text: replace the body of `add` with `return <expr>` (a clean diff against the original). */
function patchTo(expr: string): string {
  return `--- a/calculator.py\n+++ b/calculator.py\n@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return ${expr}\n`;
}

// ────────────────────────────────────────────────────────────────────────────────
// A. first patch fails, retry succeeds → FIXED_NARROWLY, attempts === 2
// ────────────────────────────────────────────────────────────────────────────────

test("fix-retry: a first patch that does not fix the bug is retried and the second patch fixes it", async () => {
  const repo = makeRepo({
    "calculator.py": "def add(a, b):\n    return a - b\n",
    "test_calculator.py": "def test_add():\n    assert add(2, 3) == 5\n",
  });

  // The check passes ONLY when the code computes a + b. The first patch (a * b) does not.
  const runCheck = async (r: string): Promise<CheckRun> => {
    const code = readFileSync(join(r, "calculator.py"), "utf8");
    if (code.includes("a + b")) return { exitCode: 0, output: PASSING_OUTPUT };
    if (code.includes("a * b")) return { exitCode: 1, output: failingOutput("6") };
    return { exitCode: 1, output: failingOutput("-1") };
  };

  const model = makeRetryModel({ diagnose: DIAGNOSIS, patches: [patchTo("a * b"), patchTo("a + b")] });

  const outcome = await runFixPipeline(
    { repo, check: CHECK },
    { runCheck, invokeModel: model.invokeModel, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }, { path: "test_calculator.py", isTest: true }]), ...STABLE_DEPS },
  );

  assert.equal(outcome.result, "FIXED_NARROWLY");
  assert.equal(outcome.receipt.attempts, 2, "the receipt records two patch attempts");
  assert.deepEqual([...outcome.filesModified], ["calculator.py"]);
  assert.equal(outcome.receipt.antiCheat.passed, true);
  // The winning fix is on disk (the first, wrong patch was reverted before the retry).
  assert.ok(readFileSync(join(repo, "calculator.py"), "utf8").includes("return a + b"));

  // Two patch calls were made, and the SECOND carried the failed first diff + a retry instruction.
  assert.equal(model.patchRequests.length, 2);
  const retryReq = model.patchRequests[1];
  assert.ok(retryReq !== undefined);
  const retryBody = (retryReq.messages ?? []).map((m) => m.content).join("\n");
  assert.match(retryBody, /PREVIOUS PATCH FAILED VERIFICATION/);
  assert.match(retryBody, /a \* b/, "the prior failed diff is shown to the model on the retry");
});

// ────────────────────────────────────────────────────────────────────────────────
// B. every attempt fails → SAFE_FAIL at MAX_FIX_ATTEMPTS
// ────────────────────────────────────────────────────────────────────────────────

test("fix-retry: gives up at MAX_FIX_ATTEMPTS when no patch fixes the bug → SAFE_FAIL", async () => {
  const repo = makeRepo({
    "calculator.py": "def add(a, b):\n    return a - b\n",
    "test_calculator.py": "def test_add():\n    assert add(2, 3) == 5\n",
  });

  // The check NEVER passes (no patch ever produces a + b).
  const runCheck = async (): Promise<CheckRun> => ({ exitCode: 1, output: failingOutput("?") });

  // Three distinct, all-wrong patches — one per attempt.
  const model = makeRetryModel({ diagnose: DIAGNOSIS, patches: [patchTo("a * b"), patchTo("b - a"), patchTo("a % b")] });

  const outcome = await runFixPipeline(
    { repo, check: CHECK },
    { runCheck, invokeModel: model.invokeModel, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }, { path: "test_calculator.py", isTest: true }]), ...STABLE_DEPS },
  );

  assert.equal(outcome.result, "SAFE_FAIL");
  assert.equal(outcome.receipt.attempts, MAX_FIX_ATTEMPTS, "all attempts were spent before giving up");
  assert.equal(model.patchRequests.length, MAX_FIX_ATTEMPTS, "the model was re-prompted MAX_FIX_ATTEMPTS times");
  // Anti-cheat still passed (the patches were honest, just ineffective).
  assert.equal(outcome.receipt.antiCheat.passed, true);
});

// ────────────────────────────────────────────────────────────────────────────────
// C. an anti-cheat catch is terminal — a cheat is never retried
// ────────────────────────────────────────────────────────────────────────────────

test("fix-retry: an anti-cheat failure is terminal on the first attempt (a cheat is never retried)", async () => {
  const repo = makeRepo({
    "calculator.py": "def add(a, b):\n    return a + b\n",
    "test_calculator.py": "def test_add():\n    assert add(2, 3) == 6\n    assert add(0, 0) == 0\n",
  });

  // The genuine bug is the `== 6` assertion. Deleting it makes the check pass dishonestly.
  const runCheck = async (r: string): Promise<CheckRun> => {
    const t = readFileSync(join(r, "test_calculator.py"), "utf8");
    return t.includes("== 6") ? { exitCode: 1, output: failingOutput("5") } : { exitCode: 0, output: PASSING_OUTPUT };
  };

  const model = makeRetryModel({
    diagnose: JSON.stringify({ category: "test_bug", confidence: 0.9, evidence: "the first assertion expects 6 but add(2,3)=5", affectedFiles: ["test_calculator.py"] }),
    // CHEAT: delete the failing assertion. If retried, a second patch would follow.
    patches: [
      "--- a/test_calculator.py\n+++ b/test_calculator.py\n@@ -1,3 +1,2 @@\n def test_add():\n-    assert add(2, 3) == 6\n     assert add(0, 0) == 0\n",
      "SECOND PATCH SHOULD NEVER BE REQUESTED",
    ],
  });

  const outcome = await runFixPipeline(
    { repo, check: CHECK, allowTestEdits: true },
    { runCheck, invokeModel: model.invokeModel, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }, { path: "test_calculator.py", isTest: true }]), ...STABLE_DEPS },
  );

  assert.equal(outcome.result, "UNSAFE_FAIL");
  assert.equal(outcome.receipt.antiCheat.passed, false);
  assert.equal(outcome.receipt.attempts, 1, "the cheat was caught on attempt 1 and NOT retried");
  assert.equal(model.patchRequests.length, 1, "no second patch was requested after the anti-cheat catch");
});

// ────────────────────────────────────────────────────────────────────────────────
// D. a clean first-attempt fix records attempts === 1
// ────────────────────────────────────────────────────────────────────────────────

test("fix-retry: a first-attempt fix records attempts === 1 (no needless retry)", async () => {
  const repo = makeRepo({
    "calculator.py": "def add(a, b):\n    return a - b\n",
    "test_calculator.py": "def test_add():\n    assert add(2, 3) == 5\n",
  });
  const runCheck = async (r: string): Promise<CheckRun> => (readFileSync(join(r, "calculator.py"), "utf8").includes("a + b") ? { exitCode: 0, output: PASSING_OUTPUT } : { exitCode: 1, output: failingOutput("-1") });
  const model = makeRetryModel({ diagnose: DIAGNOSIS, patches: [patchTo("a + b")] });

  const outcome = await runFixPipeline(
    { repo, check: CHECK },
    { runCheck, invokeModel: model.invokeModel, candidateFiles: candidates(repo, [{ path: "calculator.py", isTest: false }, { path: "test_calculator.py", isTest: true }]), ...STABLE_DEPS },
  );

  assert.equal(outcome.result, "FIXED_NARROWLY");
  assert.equal(outcome.receipt.attempts, 1);
  assert.equal(model.patchRequests.length, 1, "no retry was triggered on a clean first fix");
});
