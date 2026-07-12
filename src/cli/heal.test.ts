/**
 * `ikbi heal` — preview (read-only) + the fail-closed --run gate. Uses injected receipts + a fake
 * runHeal so no build ever spawns. Pins: preview lists only harness-suspect failures; --run refuses
 * without the opt-in AND without --yes; a gated --run invokes the loop and prints the disposition.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createHealCli, SELF_HEAL_REPO } from "./heal.js";
import type { SelfHealFailure, SelfHealResult } from "../modules/self-heal/index.js";

/** A worker.run.summary receipt that classifies as self-healable harness-suspect (test_evidence). */
function harnessReceipt(taskId: string, repo = SELF_HEAL_REPO): Receipt {
  return {
    operation: "worker.run.summary", requestId: taskId,
    outcome: { status: "rejected", detail: "Verification ran zero tests." },
    metadata: { taskId, outcome: "rejected", targetRepo: repo },
  } as unknown as Receipt;
}
/** A harness-suspect receipt that requires operator/config action, not code self-heal. */
function configGateReceipt(taskId: string, repo = SELF_HEAL_REPO): Receipt {
  return {
    operation: "worker.run.summary", requestId: taskId,
    outcome: { status: "rejected", detail: "No project manifest or verifier detected." },
    metadata: { taskId, outcome: "rejected", targetRepo: repo },
  } as unknown as Receipt;
}
/** A plain model failure (NOT harness-suspect) — must never be offered to self-heal. */
function modelReceipt(taskId: string): Receipt {
  return {
    operation: "worker.run.summary", requestId: taskId,
    outcome: { status: "failure", detail: "the model wrote something wrong" },
    metadata: { taskId, outcome: "failure" },
  } as unknown as Receipt;
}

function harness(list: Receipt[]) {
  return { query: async (_f: ReceiptQuery = {}): Promise<Receipt[]> => [...list] };
}

function cap() {
  let out = ""; let errText = ""; let exit = 0;
  return {
    stdout: (s: string) => { out += s; }, stderr: (s: string) => { errText += s; }, setExit: (c: number) => { exit = c; },
    get out() { return out; }, get err() { return errText; }, get exit() { return exit; },
  };
}

const okResult: SelfHealResult = {
  verdict: { disposition: "applied", verified: true, requiresHuman: false, requiresOpusReview: false, reasons: ["verified and low blast-radius"] },
  failure: { taskId: "t1", classification: { category: "harness", harnessSuspect: true, selfHealable: true, signal: "test_evidence", evidence: "zero tests" }, targetRepo: SELF_HEAL_REPO },
  candidate: { produced: true, changedFiles: ["src/x.ts"], branch: "ikbi/ws/1" },
  suite: { green: true, testCount: 3070 },
  judge: { pass: true },
  blastRadius: { severity: "low", reasons: [], requiresHuman: false, requiresOpusReview: false, autoApplyEligible: true },
  reason: "self-heal t1: auto-applied to a branch",
};

test("preview lists ONLY harness-suspect failures (model failures are excluded)", async () => {
  const c = cap();
  const cli = createHealCli({ receipts: harness([harnessReceipt("t1"), modelReceipt("t2")]), stdout: c.stdout, stderr: c.stderr, setExit: c.setExit });
  await cli.run([]);
  assert.match(c.out, /t1/);
  assert.doesNotMatch(c.out, /t2/, "a plain model failure is not a self-heal candidate");
  assert.match(c.out, /candidates for self-heal/);
  assert.equal(c.exit, 0);
});

test("preview with no harness-suspect failures says nothing to do", async () => {
  const c = cap();
  const cli = createHealCli({ receipts: harness([modelReceipt("t2")]), stdout: c.stdout, stderr: c.stderr, setExit: c.setExit });
  await cli.run([]);
  assert.match(c.out, /nothing for self-heal to do/i);
});

test("--run is FAIL-CLOSED without the opt-in (never invokes the loop)", async () => {
  const c = cap();
  let invoked = false;
  const cli = createHealCli({
    receipts: harness([harnessReceipt("t1")]), enabled: undefined,
    runHeal: async () => { invoked = true; return okResult; },
    stdout: c.stdout, stderr: c.stderr, setExit: c.setExit,
  });
  await cli.run(["--task", "t1", "--run", "--yes"]);
  assert.equal(invoked, false, "the loop must not run when IKBI_SELFHEAL_ENABLE is unset");
  assert.match(c.err, /not enabled|IKBI_SELFHEAL_ENABLE/);
  assert.equal(c.exit, 1);
});

test("--run refuses without --yes even when enabled", async () => {
  const c = cap();
  let invoked = false;
  const cli = createHealCli({
    receipts: harness([harnessReceipt("t1")]), enabled: "true",
    runHeal: async () => { invoked = true; return okResult; },
    stdout: c.stdout, stderr: c.stderr, setExit: c.setExit,
  });
  await cli.run(["--task", "t1", "--run"]);
  assert.equal(invoked, false);
  assert.match(c.err, /--yes/);
  assert.equal(c.exit, 1);
});

test("--run (enabled + --yes) invokes the loop and prints the disposition", async () => {
  const c = cap();
  let seen: SelfHealFailure | undefined;
  const cli = createHealCli({
    receipts: harness([harnessReceipt("t1")]), enabled: "true",
    runHeal: async (f) => { seen = f; return okResult; },
    stdout: c.stdout, stderr: c.stderr, setExit: c.setExit,
  });
  await cli.run(["--task", "t1", "--run", "--yes"]);
  assert.equal(seen?.taskId, "t1");
  assert.equal(seen?.targetRepo, SELF_HEAL_REPO);
  assert.match(c.out, /APPLIED to a branch/);
  assert.match(c.out, /ikbi\/ws\/1/);
  assert.match(c.out, /suite: green \(3070 tests\)/, "the gate's test count is surfaced for audit");
  assert.match(c.out, /judge: pass/);
  assert.equal(c.exit, 0, "a landed fix is a success exit");
});

test("--run refuses operator/config harness signals that are not self-healable", async () => {
  const c = cap();
  let invoked = false;
  const cli = createHealCli({
    receipts: harness([configGateReceipt("t1")]), enabled: "true",
    runHeal: async () => { invoked = true; return okResult; },
    stdout: c.stdout, stderr: c.stderr, setExit: c.setExit,
  });
  await cli.run(["--task", "t1", "--run", "--yes"]);
  assert.equal(invoked, false);
  assert.match(c.err, /not self-healable|operator action/);
  assert.equal(c.exit, 1);
});

test("--run refuses an external target repo unless the dangerous override is explicit", async () => {
  const c = cap();
  let invoked = false;
  const cli = createHealCli({
    receipts: harness([harnessReceipt("t1", "/repos/other")]), enabled: "true",
    runHeal: async () => { invoked = true; return okResult; },
    stdout: c.stdout, stderr: c.stderr, setExit: c.setExit,
  });
  await cli.run(["--task", "t1", "--run", "--yes"]);
  assert.equal(invoked, false);
  assert.match(c.err, /restricted to the ikbi repo/);
  assert.equal(c.exit, 1);
});

test("--run can target an external repo only with --unsafe-allow-external-repo", async () => {
  const c = cap();
  let seen: SelfHealFailure | undefined;
  const cli = createHealCli({
    receipts: harness([harnessReceipt("t1", "/repos/other")]), enabled: "true",
    runHeal: async (f) => { seen = f; return okResult; },
    stdout: c.stdout, stderr: c.stderr, setExit: c.setExit,
  });
  await cli.run(["--task", "t1", "--run", "--yes", "--unsafe-allow-external-repo"]);
  assert.equal(seen?.targetRepo, "/repos/other");
  assert.equal(c.exit, 0);
});

test("preview keeps external and non-healable harness suspects visible but marked skipped", async () => {
  const c = cap();
  const cli = createHealCli({
    receipts: harness([harnessReceipt("external", "/repos/other"), configGateReceipt("config")]),
    stdout: c.stdout, stderr: c.stderr, setExit: c.setExit,
  });
  await cli.run([]);
  assert.match(c.out, /external/);
  assert.match(c.out, /skipped: external repo/);
  assert.match(c.out, /config/);
  assert.match(c.out, /not self-healable/);
});

test("--candidates lists self-heal branches (label-filtered, excludes discarded)", async () => {
  const c = cap();
  const records = [
    { id: "ws-a", targetRepo: "/repos/ikbi", baseBranch: "main", baseRef: "r", scratchBranch: "ikbi/ws/ws-a", path: "/wt/ws-a", identity: { agentId: "x", trustTier: "trusted" }, state: "allocated", createdAt: 1, updatedAt: 1, label: "self-heal:t1" },
    { id: "ws-b", targetRepo: "/repos/ikbi", baseBranch: "main", baseRef: "r", scratchBranch: "ikbi/ws/ws-b", path: "/wt/ws-b", identity: { agentId: "x", trustTier: "trusted" }, state: "discarded", createdAt: 2, updatedAt: 2, label: "self-heal:t2" },
    { id: "ws-c", targetRepo: "/repos/other", baseBranch: "main", baseRef: "r", scratchBranch: "ikbi/ws/ws-c", path: "/wt/ws-c", identity: { agentId: "x", trustTier: "trusted" }, state: "allocated", createdAt: 3, updatedAt: 3, label: "worker:build-9" },
  ];
  const cli = createHealCli({ workspaces: { list: async () => records as never }, stdout: c.stdout, stderr: c.stderr, setExit: c.setExit });
  await cli.run(["--candidates"]);
  assert.match(c.out, /ikbi\/ws\/ws-a/, "the live self-heal candidate is listed");
  assert.match(c.out, /healed t1/);
  assert.doesNotMatch(c.out, /ws-b/, "a discarded candidate is excluded");
  assert.doesNotMatch(c.out, /ws-c/, "a non-self-heal (worker) workspace is excluded");
  assert.match(c.out, /ikbi workspace discard/, "points at the existing prune surface");
});

test("--candidates with none pending says so", async () => {
  const c = cap();
  const cli = createHealCli({ workspaces: { list: async () => [] }, stdout: c.stdout, stderr: c.stderr, setExit: c.setExit });
  await cli.run(["--candidates"]);
  assert.match(c.out, /nothing pending review/i);
});

test("--run with an unknown task id errors", async () => {
  const c = cap();
  const cli = createHealCli({
    receipts: harness([harnessReceipt("t1")]), enabled: "true",
    runHeal: async () => okResult, stdout: c.stdout, stderr: c.stderr, setExit: c.setExit,
  });
  await cli.run(["--task", "nope", "--run", "--yes"]);
  assert.match(c.err, /no harness-suspect failure with task id/);
  assert.equal(c.exit, 1);
});

test("--run requires --task", async () => {
  const c = cap();
  const cli = createHealCli({ receipts: harness([harnessReceipt("t1")]), enabled: "true", stdout: c.stdout, stderr: c.stderr, setExit: c.setExit });
  await cli.run(["--run", "--yes"]);
  assert.match(c.err, /requires --task/);
  assert.equal(c.exit, 1);
});
