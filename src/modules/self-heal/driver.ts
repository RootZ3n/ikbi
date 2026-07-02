/**
 * ikbi self-heal — runSelfHeal: the executed loop.
 *
 * Turns the pure decideDisposition() policy into a run. From a harness-suspect failure it: generates
 * a candidate fix (build on the ikbi repo, in an isolated branch), runs BOTH correctness gates (the
 * full ikbi suite + the deterministic judge), assesses the blast-radius (deterministic authority
 * gate), asks the policy for the disposition, requests Opus advice when the disposition needs it, and
 * receipts the terminal outcome. Every impure step is an injected EXECUTOR, so the sequencing is
 * driven here while the decision stays pure.
 *
 * SAFETY: the driver never merges and never touches `main`. generateFix lands the candidate on its
 * OWN branch; the disposition only decides that branch's STATUS. The worst case is a branch left for
 * a human to read — self-heal cannot, by construction, change the running ikbi.
 */

import { assessBlastRadius } from "../self-monitor/blast-radius.js";
import { decideDisposition } from "./policy.js";
import type {
  SelfHealDriverInput,
  SelfHealExecutors,
  SelfHealResult,
  SelfHealVerdict,
} from "./contract.js";

/** Build the one-line human-facing reason from the verdict + failure. */
function summarize(verdict: SelfHealVerdict, taskId: string): string {
  const head = {
    applied: "auto-applied to a branch (verified, low-risk)",
    "awaiting-authorization": "verified — awaiting a human decision (Opus advises)",
    "diagnosed-proposal": "not applied — surfaced as a diagnosis",
    rejected: "no action taken",
  }[verdict.disposition];
  return `self-heal ${taskId}: ${head}. ${verdict.reasons[0] ?? ""}`.trim();
}

export async function runSelfHeal(input: SelfHealDriverInput, ex: SelfHealExecutors): Promise<SelfHealResult> {
  const { failure } = input;

  // SHORT-CIRCUIT — never spend a build (tokens + disk) on a failure self-heal will not act on. The
  // policy makes the same call, but we must not run generateFix just to be told "not harness-suspect".
  if (!failure.classification.harnessSuspect) {
    const verdict = decideDisposition({
      harnessSuspect: false,
      candidateProduced: false,
      suiteGreen: false,
      judgePass: false,
      blastRadius: assessBlastRadius({ changedFiles: [] }),
    });
    const result: SelfHealResult = { verdict, failure, reason: summarize(verdict, failure.taskId) };
    await ex.receipt(result);
    return result;
  }

  // STEP 1 — generate the candidate (the only token/disk-spending step).
  const candidate = await ex.generateFix(failure);
  if (!candidate.produced) {
    const verdict = decideDisposition({
      harnessSuspect: true,
      candidateProduced: false,
      suiteGreen: false,
      judgePass: false,
      blastRadius: assessBlastRadius({ changedFiles: [] }),
    });
    const result: SelfHealResult = { verdict, failure, candidate, reason: summarize(verdict, failure.taskId) };
    await ex.receipt(result);
    return result;
  }

  // STEP 2 — the two CORRECTNESS gates, then the deterministic authority gate.
  const suite = await ex.runSuite(candidate);
  const judge = await ex.runJudge(candidate);
  const blastRadius = assessBlastRadius({
    changedFiles: candidate.changedFiles,
    ...(candidate.deletedFiles !== undefined ? { deletedFiles: candidate.deletedFiles } : {}),
    ...(candidate.linesChanged !== undefined ? { linesChanged: candidate.linesChanged } : {}),
    ...(input.testCountBefore !== undefined ? { testCountBefore: input.testCountBefore } : {}),
    // Prefer the suite's observed count; fall back to any count the build reported.
    ...(suite.testCount !== undefined ? { testCountAfter: suite.testCount } : {}),
    ...(candidate.touchesFrozenContract !== undefined ? { touchesFrozenContract: candidate.touchesFrozenContract } : {}),
  });

  // STEP 3 — the pure disposition.
  const verdict = decideDisposition({
    harnessSuspect: true,
    candidateProduced: true,
    suiteGreen: suite.green,
    judgePass: judge.pass,
    blastRadius,
  });

  // STEP 4 — Opus advises ONLY when the disposition asks for it (verified + high/max). Advisory only:
  // it never changes the disposition — the human reads it and decides.
  let advice: string | undefined;
  if (verdict.requiresOpusReview) {
    advice = await ex.opusAdvise({ failure, candidate, blastRadius });
  }

  const result: SelfHealResult = {
    verdict,
    failure,
    candidate,
    suite,
    judge,
    blastRadius,
    ...(advice !== undefined ? { advice } : {}),
    reason: summarize(verdict, failure.taskId),
  };
  await ex.receipt(result);
  return result;
}
