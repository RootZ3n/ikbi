/*
  THE CHECK WORKING DIRECTORY, as verification IDENTITY.

  The canonicalization and the operator-config parsing live with the checks module and are
  tested there. This is the half that belongs to v2: a plan's identity must distinguish
  the same command run in two different directories, because they are two different exams
  over two different trees.

  (These tests live here rather than beside the parser because v1 must not import v2 —
  `isolation.test.ts` enforces that, and it caught this file in the wrong place.)
*/

import "../test-env.js"; // MUST be first: hermetic synthetic dev-key opt-in, before core config loads
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildVerificationPlan } from "./verification.js";

/* ── Verification identity ───────────────────────────────────────────────── */

test("check cwd: the same command in two directories is two different exams", () => {
  /*
    The plan digest must distinguish them. If it did not, a run verified in `backend`
    could present itself as one verified in `frontend`, and the verification identity
    would be a lie about which code was actually exercised.
  */
  const plan = (cwd: string) =>
    buildVerificationPlan({
      checks: [{ name: "build", command: "npm", args: ["run", "build"], cwd }],
      timeoutMs: 1_000,
      source: "env",
    });
  assert.notEqual(plan("frontend").planId, plan("backend").planId);
  assert.equal(plan("frontend").planId, plan("frontend").planId, "and it is stable");
});

test("check cwd: an omitted cwd and an explicit undefined share one identity", () => {
  /*
    The plan builder receives an ALREADY-CANONICAL directory — `.` and `./` were
    normalized to "the root" by the checks module before they got here — so the only
    representation of the root it ever sees is absence. Both spellings of absence must
    hash identically, or an old rootless plan would stop matching itself.
  */
  const omitted = buildVerificationPlan({ checks: [{ name: "t", command: "pnpm", args: ["test"] }], timeoutMs: 1_000, source: "env" });
  const again = buildVerificationPlan({ checks: [{ name: "t", command: "pnpm", args: ["test"] }], timeoutMs: 1_000, source: "env" });
  assert.equal(omitted.planId, again.planId, "a rootless plan hashes as it always did");
  assert.equal(omitted.checks[0]!.cwd, undefined, "and carries no cwd key");
  /* `exactOptionalPropertyTypes` makes absence the ONLY spelling of the root: a check
     literal cannot even say `cwd: undefined`, so there is no second representation to
     disagree with this one. */
});

test("check cwd: the plan carries the directory through to execution", () => {
  const plan = buildVerificationPlan({
    checks: [{ name: "build", command: "npm", args: ["run", "build"], cwd: "frontend" }],
    timeoutMs: 1_000,
    source: "env",
  });
  assert.equal(plan.checks[0]!.cwd, "frontend");
});
