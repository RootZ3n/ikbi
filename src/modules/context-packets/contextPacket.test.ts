/**
 * Tests for the context-packets module: repo scan/map, byte-budgeted previews,
 * task-contract validation, the fitted context packet, and the tournament/patchsmith
 * bridges. Uses node:test against a real temp repo (the scanner/preview are fs-bound).
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { scanRepo, scanRepoContext } from "./repoScanner.js";
import { buildRepoContextMap } from "./repoMap.js";
import { previewRepoFiles } from "./filePreview.js";
import { validateTaskContract } from "./contract.js";
import { buildContextPacket, buildContextPacketFromContract, TaskContractPacketValidationError } from "./contextPacket.js";
import { buildTournamentTaskPacket, buildPatchsmithPrompt } from "./integration.js";

async function makeTempRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "ikbi-ctx-"));
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: { build: "tsc", test: "node --test" } }, null, 2));
  await writeFile(path.join(root, "README.md"), "# Fixture\n\nRun `npm run doctor` to check.\n");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "math.ts"), "export function clamp(value: number, min: number, max: number): number {\n  return value;\n}\n");
  await mkdir(path.join(root, "tests"), { recursive: true });
  await writeFile(path.join(root, "tests", "math.test.ts"), "import { clamp } from '../src/math.js';\n");
  await mkdir(path.join(root, "docs"), { recursive: true });
  await writeFile(path.join(root, "docs", "ARCHITECTURE.md"), "# Architecture\n");
  // an ignored dir must NOT be scanned
  await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "junk", "index.js"), "module.exports = {};\n");
  return root;
}

test("scanRepo classifies files into source/tests/docs/config and ignores node_modules", async () => {
  const root = await makeTempRepo();
  try {
    const map = await scanRepo(root);
    assert.equal(map.packageManager, "pnpm");
    assert.deepEqual(map.scripts, { build: "tsc", test: "node --test" });
    assert.ok(map.sections.source.some((f) => f.path === "src/math.ts"), "src/math.ts is source");
    assert.ok(map.sections.tests.some((f) => f.path === "tests/math.test.ts"), "tests/math.test.ts is a test");
    assert.ok(map.sections.docs.some((f) => f.path === "README.md"), "README.md is docs");
    assert.ok(map.sections.docs.some((f) => f.path === "docs/ARCHITECTURE.md"), "docs/ARCHITECTURE.md is docs");
    assert.ok(map.sections.config.some((f) => f.path === "package.json"), "package.json is config");
    // node_modules content must be absent
    assert.ok(!map.sections.source.some((f) => f.path.includes("node_modules")), "node_modules is ignored");
    assert.ok(map.totals.files >= 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildRepoContextMap is a pure fold over a snapshot", async () => {
  const root = await makeTempRepo();
  try {
    const snapshot = await scanRepoContext(root);
    const map = buildRepoContextMap(snapshot);
    assert.equal(map.root, snapshot.root);
    assert.equal(map.totals.tests, 1);
    assert.equal(map.totals.docs, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("previewRepoFiles honors per-file byte budget and marks truncation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ikbi-prev-"));
  try {
    const big = "x".repeat(5000);
    await writeFile(path.join(root, "big.ts"), big);
    const result = await previewRepoFiles(root, ["big.ts"], { maxBytesPerFile: 1000, maxTotalBytes: 32 * 1024 });
    assert.equal(result.previews.length, 1);
    const preview = result.previews[0]!;
    assert.equal(preview.bytesRead, 1000);
    assert.equal(preview.truncated, true);
    assert.equal(preview.text.length, 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("previewRepoFiles refuses absolute paths, traversal, and symlinks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ikbi-prev-"));
  try {
    await writeFile(path.join(root, "ok.ts"), "export const ok = 1;\n");
    await symlink(path.join(root, "ok.ts"), path.join(root, "link.ts"));
    const result = await previewRepoFiles(root, ["/etc/passwd", "../escape.ts", "link.ts", "ok.ts"]);
    assert.equal(result.previews.length, 1, "only ok.ts is previewed");
    assert.equal(result.previews[0]!.path, "ok.ts");
    const reasons = result.skipped.map((s) => s.reason).join(" | ");
    assert.match(reasons, /absolute paths are not allowed/);
    assert.match(reasons, /path traversal is not allowed/);
    assert.match(reasons, /symlinks are not followed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildContextPacket produces constraints, previews, and a truncation report", async () => {
  const root = await makeTempRepo();
  try {
    const repoMap = await scanRepo(root);
    const packet = await buildContextPacket({
      repoRoot: root,
      repoMap,
      task: {
        taskType: "failing_test_single_file_fix",
        goal: "Fix clamp in src/math.ts",
        allowedFiles: ["src/math.ts"],
        forbiddenFiles: ["tests/math.test.ts"],
        verificationRequired: ["pnpm test"]
      },
      selectedPaths: ["src/math.ts"]
    });
    assert.equal(packet.constraints.noUnlistedFiles, true);
    assert.equal(packet.constraints.workerAuthority, "propose_only");
    assert.equal(packet.constraints.verifierDeterminesTruth, true);
    assert.deepEqual(packet.constraints.forbiddenFiles, ["tests/math.test.ts"]);
    assert.equal(packet.selectedPreviews.length, 1);
    assert.match(packet.selectedPreviews[0]!.text, /export function clamp/);
    assert.equal(packet.truncation.packetTruncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildContextPacket shrinks the packet under a tight maxPacketChars ceiling", async () => {
  const root = await makeTempRepo();
  try {
    const repoMap = await scanRepo(root);
    const task = { taskType: "t", goal: "g", allowedFiles: ["src/math.ts", "README.md"] };
    const selectedPaths = ["src/math.ts", "README.md"];
    const full = await buildContextPacket({ repoRoot: root, repoMap, task, selectedPaths });
    const tight = await buildContextPacket({ repoRoot: root, repoMap, task, selectedPaths, budgets: { maxPacketChars: 900 } });
    // The ceiling is below the irreducible task/constraints/repoRoot floor, so the packet
    // does not reach 900 — but truncation must have run and meaningfully shrunk it.
    assert.equal(tight.truncation.packetTruncated, true);
    assert.ok(JSON.stringify(tight).length < JSON.stringify(full).length, "truncated packet is smaller than the full one");
    assert.equal(tight.selectedPreviews.every((p) => p.text.length === 0), true, "preview bodies are emptied to fit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("validateTaskContract accepts a safe contract and omits absent optionals", () => {
  const result = validateTaskContract({ taskType: "fix", goal: "do the thing", allowedFiles: ["src/a.ts"] });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.contract.allowedFiles, ["src/a.ts"]);
    assert.ok(!("forbiddenFiles" in result.contract), "absent optional is omitted, not undefined");
  }
});

test("validateTaskContract rejects unsafe paths, duplicates, and bad prompt quality", () => {
  const result = validateTaskContract({
    taskType: "fix",
    goal: "g",
    allowedFiles: ["../escape.ts", "dup.ts", "dup.ts"],
    promptQuality: "P9"
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const codes = result.errors.map((e) => e.code);
    assert.ok(codes.includes("unsafe_path"));
    assert.ok(codes.includes("duplicate_path"));
    assert.ok(codes.includes("invalid_prompt_quality"));
  }
});

test("buildContextPacketFromContract throws on an invalid contract", async () => {
  const root = await makeTempRepo();
  try {
    const repoMap = await scanRepo(root);
    await assert.rejects(
      () => buildContextPacketFromContract({ repoRoot: root, repoMap, contract: { taskType: "", goal: "", allowedFiles: [] } as never }),
      (err: unknown) => err instanceof TaskContractPacketValidationError
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildTournamentTaskPacket sizes the packet to the candidate context window", async () => {
  const root = await makeTempRepo();
  try {
    const repoMap = await scanRepo(root);
    const task = { goal: "Fix clamp", allowedFiles: ["src/math.ts", "README.md"], verificationRequired: ["pnpm test"] };
    const small = await buildTournamentTaskPacket({ repoRoot: root, repoMap, task, modelCapabilities: { contextWindow: 500 } });
    const large = await buildTournamentTaskPacket({ repoRoot: root, repoMap, task, modelCapabilities: { contextWindow: 100_000 } });
    // A smaller window yields a more aggressively truncated packet than a large one.
    assert.equal(small.truncation.maxPacketChars, 300, "ceiling is 60% of the 500-char window");
    assert.equal(small.truncation.packetTruncated, true);
    assert.ok(JSON.stringify(small).length < JSON.stringify(large).length, "tighter window => smaller packet");
    assert.equal(large.truncation.packetTruncated, false, "a large window does not truncate");
    assert.deepEqual(small.task.verificationRequired, ["pnpm test"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("buildPatchsmithPrompt embeds the goal, file previews, and constraints", async () => {
  const root = await makeTempRepo();
  try {
    const repoMap = await scanRepo(root);
    const packet = await buildContextPacket({
      repoRoot: root,
      repoMap,
      task: { taskType: "t", goal: "Fix clamp in src/math.ts", allowedFiles: ["src/math.ts"], forbiddenFiles: ["tests/math.test.ts"], verificationRequired: ["pnpm test"] },
      selectedPaths: ["src/math.ts"]
    });
    const prompt = buildPatchsmithPrompt(packet, { checkOutput: "clamp test FAILED" });
    assert.match(prompt, /TASK: Fix clamp in src\/math\.ts/);
    assert.match(prompt, /export function clamp/);
    assert.match(prompt, /clamp test FAILED/);
    assert.match(prompt, /Do NOT modify: tests\/math\.test\.ts/);
    assert.match(prompt, /pnpm test/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
