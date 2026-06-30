/**
 * Tests for applyConsultPatch: the frontier consult runs in patch mode (mocked), and the
 * returned unified diff is applied into a real temp worktree. Verification is the caller's job,
 * so these assert only that the diff parsed + landed (or failed closed without writing).
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { applyConsultPatch } from "./consult-apply.js";
import type { ApplyConsultPatchDeps } from "./consult-apply.js";
import type { ConsultResult } from "../consult/index.js";

const IDENTITY = { agentId: "consult-1", functionalRole: "consultant", trustTier: "operator" as const, spawnedFrom: "p" };

const GOOD_DIFF =
  "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export function add(a: number, b: number): number {\n-  return a - b;\n+  return a + b;\n }\n";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ikbi-consult-apply-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a - b;\n}\n");
  return root;
}

function consultReturning(answer: string): ApplyConsultPatchDeps {
  return {
    runConsult: async (req): Promise<ConsultResult> => {
      assert.equal(req.mode, "patch", "applyConsultPatch must request a patch");
      return {
        modelId: "sonnet-4.6",
        tier: "frontier",
        mode: "patch",
        answer,
        packet: {} as unknown as ConsultResult["packet"],
        usage: {} as unknown as ConsultResult["usage"],
        cost: {} as unknown as ConsultResult["cost"],
        retrieval: { files: 1, lowConfidence: false }
      };
    }
  };
}

test("applies a frontier unified diff into the worktree", async () => {
  const root = await makeRepo();
  try {
    const res = await applyConsultPatch(
      { workspacePath: root, request: { question: "fix add", identity: IDENTITY } },
      consultReturning(GOOD_DIFF)
    );
    assert.equal(res.applied, true);
    assert.deepEqual(res.filesChanged, ["src/math.ts"]);
    assert.equal(res.modelId, "sonnet-4.6");
    const patched = await readFile(path.join(root, "src", "math.ts"), "utf8");
    assert.match(patched, /return a \+ b;/, "the diff actually landed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed (non-diff) frontier answer fails closed without writing", async () => {
  const root = await makeRepo();
  try {
    const res = await applyConsultPatch(
      { workspacePath: root, request: { question: "fix add", identity: IDENTITY } },
      consultReturning("I think the bug is in the subtraction, you should add instead.")
    );
    assert.equal(res.applied, false);
    assert.equal(res.stopReason, "no_diff");
    const untouched = await readFile(path.join(root, "src", "math.ts"), "utf8");
    assert.match(untouched, /return a - b;/, "nothing written on a non-diff answer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a diff that escapes the worktree is rejected (path violation), nothing written", async () => {
  const root = await makeRepo();
  try {
    const escape = "--- a/../evil.ts\n+++ b/../evil.ts\n@@ -0,0 +1 @@\n+pwned\n";
    const res = await applyConsultPatch(
      { workspacePath: root, request: { question: "x", identity: IDENTITY } },
      consultReturning(escape)
    );
    assert.equal(res.applied, false);
    assert.equal(res.stopReason, "path_violation");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a diff whose context doesn't match fails closed (patch_did_not_apply)", async () => {
  const root = await makeRepo();
  try {
    const mismatched =
      "--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1,3 +1,3 @@\n export function NONEXISTENT(): void {\n-  return 0;\n+  return 1;\n }\n";
    const res = await applyConsultPatch(
      { workspacePath: root, request: { question: "x", identity: IDENTITY } },
      consultReturning(mismatched)
    );
    assert.equal(res.applied, false);
    assert.equal(res.stopReason, "patch_did_not_apply");
    const untouched = await readFile(path.join(root, "src", "math.ts"), "utf8");
    assert.match(untouched, /return a - b;/, "no partial write on a non-applying hunk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
