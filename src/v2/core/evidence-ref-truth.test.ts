/**
 * A RECEIPT MUST NOT CLAIM A MUTATION THAT DID NOT HAPPEN.
 *
 * `sourceRepositoryMutated` is documented as true "exactly when the target ref moved", and it was
 * derived as `accepted && promotions.length > 0` — a second copy of `promoted` that never consulted
 * a ref. Publishing a candidate whose tree equals the base tree is a lawful no-op: the CAS records
 * `beforeRef === afterRef` and the operator's HEAD does not move. The receipt still said the
 * operator's repository had been mutated.
 *
 * Observed end to end before the fix: a builder whose `create_file` applied no mutation
 * (mutationsApplied 0, candidateMutated false, HEAD unchanged) produced
 * `sourceRepositoryMutated: true`.
 *
 * The literals below are the two ref shapes that matter, written out rather than produced by a
 * constructor that could drift with the code under test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeEvidence, type RunTerminalOutcome } from "./result.js";
import type { RunLedgerView } from "./lifecycle.js";

const REF_A = "e9aeaec88f9d5276de787fb81a83669b7c1c206f";
const REF_B = "c31cfceb610a5d0695a9b882018c53537ac4ebaa";

/** A ledger that recorded exactly one promotion — the case the old expression keyed on. */
const PROMOTED_LEDGER = {
  configurations: ["cfg"],
  resolutions: ["res"],
  retrievals: ["ret"],
  contexts: ["ctx"],
  snapshots: ["snap"],
  workspaces: ["ws"],
  observations: [],
  mutations: [],
  invocations: ["inv"],
  candidates: ["cand"],
  verifications: ["ver"],
  promotions: ["promo"],
} as unknown as RunLedgerView;

const ACCEPTED = {
  kind: "accepted",
  candidateId: "cand",
  verificationId: "ver",
  promotionId: "promo",
} as unknown as RunTerminalOutcome;

test("evidence: a NO-OP promotion does not claim the operator's repository changed", () => {
  const e = summarizeEvidence(PROMOTED_LEDGER, ACCEPTED, 0, { beforeRef: REF_A, afterRef: REF_A });
  assert.equal(e.promoted, true, "the promotion really did land");
  assert.equal(e.sourceRepositoryMutated, false, "but the ref did not move, so nothing was mutated");
});

test("evidence: a promotion that MOVED the ref does claim the repository changed", () => {
  const e = summarizeEvidence(PROMOTED_LEDGER, ACCEPTED, 0, { beforeRef: REF_A, afterRef: REF_B });
  assert.equal(e.promoted, true);
  assert.equal(e.sourceRepositoryMutated, true);
});

test("evidence: `promoted` and `sourceRepositoryMutated` are NOT the same fact", () => {
  // The defect was that these two were computed from the same expression. If they ever collapse
  // back together, a no-op promotion starts lying again.
  const noop = summarizeEvidence(PROMOTED_LEDGER, ACCEPTED, 0, { beforeRef: REF_A, afterRef: REF_A });
  assert.notEqual(
    noop.promoted,
    noop.sourceRepositoryMutated,
    "a landed no-op is promoted WITHOUT mutating the source",
  );
});

test("evidence: a run that never promoted claims neither", () => {
  const ledger = { ...PROMOTED_LEDGER, promotions: [] } as unknown as RunLedgerView;
  const withheld = { kind: "withheld", candidateId: "cand", verificationId: "ver", reason: "awaiting_promotion" } as unknown as RunTerminalOutcome;
  const e = summarizeEvidence(ledger, withheld, 0, undefined);
  assert.equal(e.promoted, false);
  assert.equal(e.sourceRepositoryMutated, false);
});
