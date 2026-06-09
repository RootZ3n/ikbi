/**
 * ikbi worker-model — PRODUCTION HARDENING DEFAULTS (the audit-confirmed fixes).
 *
 * Proves the hardened paths are the PRODUCTION DEFAULT and that legacy stays reachable only
 * as an explicit override:
 *   F1 — fresh production worker defaults to LADDER verification.
 *   F2 — fresh production worker defaults to INDEX retrieval.
 *   F7 — IKBI_VERIFY=legacy / IKBI_RETRIEVAL=legacy still select the legacy paths.
 *   E  — the resolved modes are reported on the run result (observability).
 *
 * These test the WIRING DECISION (production ⇒ ladder/index) deterministically, without the
 * heavy verifier/scout internals: the verifier mode is asserted via the explicit `mode` the
 * orchestrator threads (captured by a spy verifier), and retrieval via a spy retrieval API.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isExplicitLegacyRetrieval,
  isExplicitLegacyVerify,
  resolveRetrievalMode,
  resolveVerificationMode,
  safetyPosture,
} from "./modes.js";
import { createVerifier } from "./verifier.js";
import { createScout } from "./scout.js";
import type { ProjectRetrievalApi } from "../project-retrieval/index.js";
import type { OperationContext } from "../../core/identity/index.js";
import type { RoleContext, RoleEngine } from "./contract.js";

// ── F1/F2 (pure resolver): production defaults to hardened; explicit env wins ────────────────

test("F1: resolveVerificationMode — production with NO env ⇒ ladder (hardened default)", () => {
  assert.equal(resolveVerificationMode({}, { production: true }), "ladder");
});

test("F2: resolveRetrievalMode — production with NO env ⇒ index (hardened default)", () => {
  assert.equal(resolveRetrievalMode({}, { production: true }), "index");
});

test("F7: explicit IKBI_VERIFY=legacy / IKBI_RETRIEVAL=legacy override the hardened default", () => {
  assert.equal(resolveVerificationMode({ IKBI_VERIFY: "legacy" }, { production: true }), "legacy");
  assert.equal(resolveRetrievalMode({ IKBI_RETRIEVAL: "legacy" }, { production: true }), "legacy");
  assert.equal(isExplicitLegacyVerify({ IKBI_VERIFY: "legacy" }), true);
  assert.equal(isExplicitLegacyRetrieval({ IKBI_RETRIEVAL: "legacy" }), true);
});

test("explicit IKBI_VERIFY=ladder / IKBI_RETRIEVAL=index opt-in still works (and case/space-insensitive)", () => {
  assert.equal(resolveVerificationMode({ IKBI_VERIFY: " Ladder " }, { production: false }), "ladder");
  assert.equal(resolveRetrievalMode({ IKBI_RETRIEVAL: "INDEX" }, { production: false }), "index");
});

test("BACK-COMPAT: a NON-production (bare/test) construction stays legacy unless env opts in", () => {
  assert.equal(resolveVerificationMode({}, { production: false }), "legacy");
  assert.equal(resolveRetrievalMode({}, { production: false }), "legacy");
});

test("safetyPosture: both hardened ⇒ HARDENED, both legacy ⇒ LEGACY, split ⇒ MIXED", () => {
  assert.equal(safetyPosture("ladder", "index"), "HARDENED");
  assert.equal(safetyPosture("legacy", "legacy"), "LEGACY");
  assert.equal(safetyPosture("ladder", "legacy"), "MIXED");
  assert.equal(safetyPosture("legacy", "index"), "MIXED");
});

// ── F1 (verifier path): the explicit `mode` the production wiring threads SELECTS the path ───

const PCTX = { identity: { identity: { agentId: "a" } } } as unknown as OperationContext;
const okExec = { run: async () => ({ executed: true, exitCode: 0, stdoutTail: "", stderrTail: "" }) } as never;

function ladderFakes() {
  // Minimal index + plan so ladder produces a GREEN without real project scanning.
  const data = { packages: [] } as never;
  const plan = {
    scope: "full" as const, blocked: false, blockReasons: [], neutralPackages: [], receipts: [],
    stages: [{ stage: "root", tasks: [{ package: "", cwd: "", name: "test", command: "node", args: ["-e", "0"], scope: "full" as const, reason: "r", blocking: false }] }],
  } as never;
  return {
    index: { refresh: async () => ({ data }) },
    plan: () => plan,
    triage: () => ({ passed: true, failures: [], errorSummary: "", detectedFrameworks: ["node"] }) as never,
  };
}

const ctx = { workspace: { path: "/tmp/x", baseRef: "HEAD" } } as unknown as RoleContext;

test("F1 (wiring): a verifier built with mode:'ladder' runs the LADDER path (scope-stamped green)", async () => {
  const f = ladderFakes();
  const v = createVerifier({ governedExec: okExec, parentCtx: PCTX, diff: async () => "", planningDiff: async () => "", mode: "ladder", index: f.index, plan: f.plan, triage: f.triage });
  const r = await v(ctx);
  assert.equal(r.outcome, "success");
  assert.equal((r.detail as { verificationMode?: string }).verificationMode, "ladder");
  assert.match(r.summary ?? "", /scope/i, "ladder green is scope-stamped");
});

test("F7 (wiring): a verifier built with mode:'legacy' runs the LEGACY path (plain 'all checks passed')", async () => {
  const v = createVerifier({ governedExec: okExec, parentCtx: PCTX, diff: async () => "", mode: "legacy" });
  const r = await v(ctx);
  assert.equal(r.outcome, "success");
  assert.equal((r.detail as { verificationMode?: string }).verificationMode, "legacy");
  assert.equal((r.detail as { verificationScope?: string }).verificationScope, undefined, "legacy has no scope stamp");
});

// ── F2 (scout path): the explicit `mode` SELECTS index retrieval ─────────────────────────────

const engine: RoleEngine = {
  invokeModel: async () => ({ content: "- finding", model: "m", usage: { inputTokens: 1, outputTokens: 1 } }) as never,
  neutralizeUntrusted: ((raw: string) => raw) as never,
};
const scoutCtx = (path: string) => ({ workspace: { path }, task: { goal: "fix the widget" }, identity: { agentId: "s" }, engine } as unknown as RoleContext);

test("F2 (wiring): a scout built with mode:'index' delegates to project-retrieval (not the legacy scan)", async () => {
  let retrieveCalled = 0;
  const retrieval: ProjectRetrievalApi = {
    retrieve: async () => { retrieveCalled += 1; return { files: [{ path: "widget.ts", reasons: ["name"], why: "goal match" }], receipts: ["index retrieval"] }; },
  } as never;
  const s = createScout({ mode: "index", retrieval });
  const r = await s(scoutCtx(process.cwd()));
  assert.equal(retrieveCalled, 1, "the index retrieval path was taken");
  assert.equal(r.outcome, "success");
  assert.equal((r.detail as { retrievalMode?: string }).retrievalMode, "index");
});

test("F2 (fail-safe): index retrieval that throws falls back to the legacy scan, reported as index-fallback", async () => {
  const retrieval: ProjectRetrievalApi = { retrieve: async () => { throw new Error("index down"); } } as never;
  const s = createScout({ mode: "index", retrieval });
  const r = await s(scoutCtx(process.cwd()));
  assert.equal(r.outcome, "success", "the flag NEVER makes scout worse — it falls back");
  assert.equal((r.detail as { retrievalMode?: string }).retrievalMode, "index-fallback");
});

test("F7 (wiring): a scout built with mode:'legacy' uses the legacy scan (no retrieval call)", async () => {
  let retrieveCalled = 0;
  const retrieval: ProjectRetrievalApi = { retrieve: async () => { retrieveCalled += 1; return { files: [], receipts: [] }; } } as never;
  const s = createScout({ mode: "legacy", retrieval });
  const r = await s(scoutCtx(process.cwd()));
  assert.equal(retrieveCalled, 0, "legacy mode never calls retrieval");
  assert.equal((r.detail as { retrievalMode?: string }).retrievalMode, "legacy");
});
