/**
 * `ikbi heal` — preview (read-only) + the fail-closed --run gate. Uses injected receipts + a fake
 * runHeal so no build ever spawns. Pins: preview lists only harness-suspect failures; --run refuses
 * without the opt-in AND without --yes; a gated --run invokes the loop and prints the disposition.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Receipt, ReceiptQuery } from "../core/receipt/index.js";
import { createHealCli } from "./heal.js";
import type { SelfHealFailure, SelfHealResult } from "../modules/self-heal/index.js";

/** A worker.run.summary receipt that classifies as harness-suspect (checks_unresolvable). */
function harnessReceipt(taskId: string, repo = "/repos/ikbi"): Receipt {
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
  failure: { taskId: "t1", classification: { category: "harness", harnessSuspect: true, signal: "checks_unresolvable", evidence: "no manifest" }, targetRepo: "/repos/ikbi" },
  candidate: { produced: true, changedFiles: ["src/x.ts"], branch: "ikbi/ws/1" },
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
  assert.equal(seen?.targetRepo, "/repos/ikbi");
  assert.match(c.out, /APPLIED to a branch/);
  assert.match(c.out, /ikbi\/ws\/1/);
  assert.equal(c.exit, 0, "a landed fix is a success exit");
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
