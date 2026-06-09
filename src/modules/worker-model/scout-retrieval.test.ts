/**
 * ikbi worker-model — scout retrieval wiring (IKBI_RETRIEVAL=index).
 *
 * Proves the before/after contrast on a fixture whose relevant files sit OUTSIDE the first 40
 * traversal files: legacy scan misses them, index-backed retrieval finds them (incl. the related
 * test), reasons are surfaced, failure falls back to legacy, and the DEFAULT stays legacy.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { AgentIdentity } from "../../core/identity/contract.js";
import { neutralizeUntrusted as coreNeutralize } from "../../core/injection/index.js";
import type { ModelResponse } from "../../core/provider/contract.js";
import { autonomyForTier } from "../../core/trust/index.js";
import type { WorkspaceHandle } from "../../core/workspace/contract.js";
import { createProjectIndex } from "../project-index/index.js";
import { createProjectRetrieval, type ProjectRetrievalApi } from "../project-retrieval/index.js";
import { createScout } from "./scout.js";
import type { RoleContext } from "./contract.js";

const IDENTITY: AgentIdentity = { agentId: "worker-1", functionalRole: "scout", trustTier: "probation", spawnedFrom: "parent-1" };

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeBigFixture(): { repo: string; stateRoot: string } {
  const repo = mkdtempSync(join(tmpdir(), "ikbi-scout-pr-repo-"));
  const stateRoot = mkdtempSync(join(tmpdir(), "ikbi-scout-pr-state-"));
  for (let i = 0; i < 45; i += 1) {
    const n = String(i).padStart(2, "0");
    write(repo, `noise${n}.ts`, `export const n${n} = ${i};\n`);
  }
  write(repo, "CLAUDE.md", "# Project rules\n- Prefer readable code.\n");
  write(repo, "package.json", JSON.stringify({ name: "big-root", private: true, scripts: { build: "tsc -b" } }));
  write(repo, "packages/feature/package.json", JSON.stringify({ name: "@big/feature", scripts: { test: "vitest run" } }));
  write(repo, "packages/feature/src/widget.ts", 'export function renderWidget(): string {\n  return "widget";\n}\n');
  write(repo, "packages/feature/src/widget.test.ts", 'import { renderWidget } from "./widget";\nimport { it } from "node:test";\nit("w", () => renderWidget());\n');
  write(repo, "packages/feature/src/index.ts", 'import { renderWidget } from "./widget";\nexport const ui = renderWidget();\n');
  return { repo, stateRoot };
}

function modelResponse(content: string): ModelResponse {
  return {
    contractVersion: "1.1.0", model: "mimo-v2.5", provider: "mimo", providerModelId: "mimo-v2.5",
    content, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    cost: { usd: 0, promptUsd: 0, cachedUsd: 0, completionUsd: 0, rate: { promptPerMTok: 0, completionPerMTok: 0 } },
    latencyMs: 1, fellBack: false, attempts: [],
  };
}

function makeCtx(dir: string, goal: string): RoleContext {
  const workspace: WorkspaceHandle = {
    id: "ws1", targetRepo: dir, baseBranch: "main", baseRef: "x", scratchBranch: "ikbi/ws/ws1",
    path: dir, identity: IDENTITY, state: "allocated", createdAt: 0,
  };
  return {
    task: { taskId: "t-1", targetRepo: dir, goal },
    role: "scout",
    identity: IDENTITY,
    autonomy: autonomyForTier("probation"),
    workspace,
    priorResults: [],
    engine: {
      invokeModel: async () => modelResponse("- finding one"),
      neutralizeUntrusted: (content, context) => coreNeutralize(content, context),
    },
  };
}

interface ScoutDetail {
  retrievalMode: "index" | "legacy";
  filesScanned: number;
  structure: Array<{ path: string }>;
  retrieval?: { selected: Array<{ path: string; reasons: string[] }> };
}

const indexRetrieval = (stateRoot: string): ProjectRetrievalApi => createProjectRetrieval({ index: createProjectIndex({ stateRoot }) });

test("scout wiring: DEFAULT (no flag) uses the legacy scan and misses out-of-sample files", async () => {
  const { repo, stateRoot } = makeBigFixture();
  try {
    const result = await createScout({ env: {} })(makeCtx(repo, "Fix the widget bug in the feature package"));
    const d = result.detail as unknown as ScoutDetail;
    assert.equal(result.outcome, "success");
    assert.equal(d.retrievalMode, "legacy", "default is legacy");
    assert.equal(d.filesScanned, 40, "legacy capped at 40 files");
    assert.ok(!d.structure.some((s) => s.path.includes("widget")), "legacy scan missed the widget file");
    assert.match(result.summary ?? "", /via legacy scan/, "summary records the legacy path");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("scout wiring: IKBI_RETRIEVAL=index finds the out-of-sample target + its related test, with reasons", async () => {
  const { repo, stateRoot } = makeBigFixture();
  try {
    const result = await createScout({ env: { IKBI_RETRIEVAL: "index" }, retrieval: indexRetrieval(stateRoot) })(
      makeCtx(repo, "Fix the widget bug in the feature package"),
    );
    const d = result.detail as unknown as ScoutDetail;
    assert.equal(d.retrievalMode, "index", "index path used");
    const scanned = new Set(d.structure.map((s) => s.path));
    assert.ok(scanned.has("packages/feature/src/widget.ts"), "index retrieval found the widget file legacy missed");
    assert.ok(scanned.has("packages/feature/src/widget.test.ts"), "and its colocated test");
    const sel = new Map((d.retrieval?.selected ?? []).map((s) => [s.path, s.reasons]));
    assert.ok(sel.get("packages/feature/src/widget.ts")?.includes("goal-name-match"), "reason tag surfaced for the target");
    assert.ok(sel.get("packages/feature/src/widget.test.ts")?.includes("test-of-seed"), "reason tag surfaced for the test");
    assert.match(result.summary ?? "", /via index retrieval/, "summary records the index path");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test("scout wiring: a retrieval failure falls back safely to the legacy scan", async () => {
  const { repo, stateRoot } = makeBigFixture();
  try {
    const failing: ProjectRetrievalApi = { retrieve: async () => { throw new Error("index boom"); } };
    const result = await createScout({ env: { IKBI_RETRIEVAL: "index" }, retrieval: failing })(makeCtx(repo, "Fix the widget bug"));
    const d = result.detail as unknown as ScoutDetail;
    assert.equal(result.outcome, "success", "scout still succeeds via fallback");
    assert.equal(d.retrievalMode, "legacy", "fell back to legacy");
    assert.match(result.summary ?? "", /fell back to legacy scan/, "summary records the fallback");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(stateRoot, { recursive: true, force: true });
  }
});
