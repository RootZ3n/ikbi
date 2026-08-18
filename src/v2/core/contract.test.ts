/**
 * The two v2 seams: candidate strategy (shadow + tournament survive) and
 * state-bound mutation (hash-anchored editing). Neither is implemented in this
 * slice; what IS pinned here is the semantics later slices must not drift from.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CANDIDATE_STRATEGIES,
  defaultStrategyPlan,
  isCandidateStrategyKind,
  isStaleObservation,
  sameObservedState,
  type ObservedStateIdentity,
} from "./contract.js";

const regular = (sha: string, len: number): ObservedStateIdentity => ({
  kind: "regular",
  sha256: sha,
  byteLength: len,
  symlinkTarget: null,
});

test("strategy seam: shadow and tournament are first-class strategies, not modes", () => {
  assert.deepEqual([...CANDIDATE_STRATEGIES], ["single", "shadow", "tournament"]);
  assert.ok(isCandidateStrategyKind("tournament"));
  assert.equal(isCandidateStrategyKind("competitive-v1"), false, "unknown strategies fail closed");
});

test("strategy seam: only `single` is capped at one candidate", () => {
  assert.equal(defaultStrategyPlan("single").maxCandidates, 1);
  assert.ok(defaultStrategyPlan("shadow").maxCandidates > 1, "shadow is multi-candidate by definition");
  assert.ok(defaultStrategyPlan("tournament").maxCandidates > 1, "tournament is multi-candidate by definition");
});

test("state-bound mutation: identical observed state is a match (the CAS succeeds)", () => {
  assert.ok(sameObservedState(regular("aa", 2), regular("aa", 2)));
  assert.equal(isStaleObservation(regular("aa", 2), regular("aa", 2)), false);
});

test("state-bound mutation: ANY drift makes the observation stale", () => {
  const observed = regular("aa", 2);
  const drifted: readonly ObservedStateIdentity[] = [
    regular("bb", 2), // content changed under us
    regular("aa", 3), // length changed
    { kind: "missing", sha256: null, byteLength: null, symlinkTarget: null }, // deleted
    { kind: "directory", sha256: null, byteLength: null, symlinkTarget: null }, // replaced by a dir
    { kind: "symlink", sha256: "aa", byteLength: 2, symlinkTarget: "/etc/passwd" }, // swapped for a symlink
  ];
  for (const current of drifted) {
    assert.ok(isStaleObservation(observed, current), `${current.kind}/${String(current.sha256)} is stale`);
  }
});

test("state-bound mutation: file MODE is not content identity", () => {
  // Permissions changing must not, by itself, invalidate an observation — the
  // identity is content. (The v1 donor makes the same call; v2 keeps it.)
  assert.ok(sameObservedState(regular("aa", 2), regular("aa", 2)));
});

test("state-bound mutation: an empty file and a missing file are NOT the same state", () => {
  const empty: ObservedStateIdentity = { kind: "empty", sha256: null, byteLength: 0, symlinkTarget: null };
  const missing: ObservedStateIdentity = { kind: "missing", sha256: null, byteLength: null, symlinkTarget: null };
  assert.ok(isStaleObservation(empty, missing), "create-vs-truncate must never be confused");
});
