/**
 * H1: the scout computes goalAlignment (status + summary) but it was dropped — never passed to the
 * builder. These tests prove the alignment summary now rides in the builder's prior-results block.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPriorResultsBlock, extractScout } from "./builder.js";
import type { RoleResult } from "./contract.js";

const scoutWithAlignment = (status: string, summary: string): RoleResult => ({
  role: "scout",
  outcome: "success",
  summary: "scouted",
  detail: { findings: [], brief: "Repository structure (1 file).", goalAlignment: { status, summary } },
});

test("extractScout surfaces the scout's goalAlignment (status + summary)", () => {
  const scout = extractScout([scoutWithAlignment("misaligned", "Goal references nope.ts but this file was not found")]);
  assert.deepEqual(scout.goalAlignment, { status: "misaligned", summary: "Goal references nope.ts but this file was not found" });
});

test("extractScout omits goalAlignment when the scout did not produce one", () => {
  const scout = extractScout([{ role: "scout", outcome: "success", summary: "s", detail: { findings: [], brief: "b" } }]);
  assert.equal(scout.goalAlignment, undefined);
});

test("buildPriorResultsBlock includes the goalAlignment summary when available", () => {
  const prior = [scoutWithAlignment("misaligned", "Goal references nope.ts but this file was not found in the repository")];
  const block = buildPriorResultsBlock(prior, extractScout(prior));
  assert.match(block, /GOAL ALIGNMENT \(misaligned\)/, "the alignment status is surfaced");
  assert.match(block, /Goal references nope\.ts but this file was not found/, "the alignment summary is surfaced");
});

test("buildPriorResultsBlock omits the goalAlignment line when the scout produced none", () => {
  const prior: RoleResult[] = [{ role: "scout", outcome: "success", summary: "s", detail: { findings: [], brief: "b" } }];
  const block = buildPriorResultsBlock(prior, extractScout(prior));
  assert.doesNotMatch(block, /GOAL ALIGNMENT/);
});
