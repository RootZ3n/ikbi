/**
 * ikbi worker-model — THE MODEL CAPABILITY HARNESS.
 *
 * Stop asking "why won't this model behave?" and start asking "what job can this model
 * reliably do?". The harness evaluates a model across FOUR modes against a set of fixtures
 * and emits a scorecard + a routing recommendation. The routing is what feeds the two builder
 * lanes (agent vs patchsmith): a model that fails the autonomous tool-agent bar but produces
 * clean diffs is routed to `patch_builder` instead of being abandoned as "failed build".
 *
 * MODES
 *   A. agent      — autonomous tool-agent: does the model emit a VALID tool call (known tool,
 *                   parseable JSON args, required fields present)?
 *   B. patch      — patch-only: does the model return a PARSEABLE, MINIMAL diff that respects
 *                   the test boundary, passes the target check, and passes full verification?
 *   C. plan_patch — plan-then-patch: a planning turn, then a patch. Feeds the same patch metrics.
 *   D. repair     — repair-only: given verifier output, can the model produce a fixing patch?
 *
 * The harness is DETERMINISTIC and side-effect-free: fixtures carry their own ground-truth
 * ORACLES (`targetTestPasses` / `fullVerificationPasses`) over an in-memory file map, so a patch
 * is "applied" in memory and scored against the oracle. No fs, no git, no governed exec — that
 * keeps the evaluation reproducible and lets it run anywhere. (Production verification is the
 * real governed ladder; the harness only needs ground truth, not a real toolchain.)
 */

import type { RoleEngine } from "./contract.js";
import { TOOLS } from "./builder.js";
import { applyFilePatch, extractDiff, parseUnifiedDiff, PATCHSMITH_SYSTEM } from "./patchsmith.js";

/** The lanes a model can be routed to (richest-capability first). */
export type RecommendedRole = "agent_builder" | "patch_builder" | "repair_builder" | "critic_only" | "not_recommended";

/** The capability modes the harness exercises. */
export type CapabilityMode = "agent" | "patch" | "plan_patch" | "repair";

/** An in-memory fixture: a repo snapshot + the goal + ground-truth oracles. */
export interface HarnessFixture {
  readonly name: string;
  readonly goal: string;
  /** The seed file map (worktree-relative path → content). */
  readonly files: Readonly<Record<string, string>>;
  /** The file the fix is expected to land in (for context + minimality scoring). */
  readonly targetFile: string;
  /** Files the model must NOT touch (the boundary). Defaults to test files in `files`. */
  readonly forbiddenFiles?: readonly string[];
  /** Verifier-style output handed to the model in REPAIR mode (mode D). */
  readonly repairVerifierOutput: string;
  /** ORACLE: given the post-patch file map, did the TARGET check pass? */
  readonly targetTestPasses: (files: Readonly<Record<string, string>>) => boolean;
  /** ORACLE: given the post-patch file map, did FULL verification pass? */
  readonly fullVerificationPasses: (files: Readonly<Record<string, string>>) => boolean;
}

/** One (fixture × mode) observation — fields are undefined when not applicable to the mode. */
export interface ModeObservation {
  readonly fixture: string;
  readonly mode: CapabilityMode;
  readonly toolCallValid?: boolean;
  readonly schemaValid?: boolean;
  readonly patchParseable?: boolean;
  readonly diffMinimal?: boolean;
  readonly testBoundaryRespected?: boolean;
  readonly targetTestPass?: boolean;
  readonly fullVerificationPass?: boolean;
  readonly repairSuccess?: boolean;
  readonly overclaimed?: boolean;
}

/** The fraction metrics that drive routing (each in [0,1]; NaN-free — absent → neutral default). */
export interface CapabilityMetrics {
  readonly tool_call_reliability: number;
  readonly schema_reliability: number;
  readonly patch_parseability: number;
  readonly diff_minimality: number;
  readonly test_boundary_respect: number;
  readonly target_test_pass: number;
  readonly full_verification_pass: number;
  readonly repair_success_rate: number;
  readonly overclaiming_rate: number;
}

/** The full scorecard: the model, every metric, the recommended lane, and WHY. */
export interface CapabilityScorecard extends CapabilityMetrics {
  readonly model: string;
  readonly recommended_role: RecommendedRole;
  readonly routing_reason: string;
  /** The raw per-(fixture×mode) observations the metrics were aggregated from. */
  readonly observations: readonly ModeObservation[];
}

/** Routing thresholds — named so the policy is auditable, not buried in conditionals. */
export const ROUTING_THRESHOLDS = {
  toolCall: 0.7,
  schema: 0.7,
  patchParse: 0.7,
  diffMinimal: 0.6,
  repairSuccess: 0.5,
  targetTest: 0.5,
  overclaiming: 0.3,
} as const;

/**
 * Pure routing decision over the metrics (the plan's ladder). Richest capability first: a model
 * that can drive the tool loop is an agent_builder; failing that, a clean diff generator is a
 * patch_builder; failing that, a reliable repairer; failing that, a non-overclaiming critic;
 * else not_recommended. Reason names the metrics that decided it.
 */
export function routeFromMetrics(m: CapabilityMetrics): { role: RecommendedRole; reason: string } {
  const t = ROUTING_THRESHOLDS;
  if (m.tool_call_reliability >= t.toolCall && m.schema_reliability >= t.schema) {
    return { role: "agent_builder", reason: `reliable tool agent (tool_call ${fmt(m.tool_call_reliability)}, schema ${fmt(m.schema_reliability)})` };
  }
  if (m.patch_parseability >= t.patchParse && m.diff_minimality >= t.diffMinimal) {
    return {
      role: "patch_builder",
      reason: `fails autonomous agent (tool_call ${fmt(m.tool_call_reliability)}, schema ${fmt(m.schema_reliability)}), viable patch generator (parseability ${fmt(m.patch_parseability)}, minimality ${fmt(m.diff_minimality)})`,
    };
  }
  if (m.repair_success_rate >= t.repairSuccess) {
    return { role: "repair_builder", reason: `cannot generate patches reliably but repairs verifier failures (repair_success ${fmt(m.repair_success_rate)})` };
  }
  if (m.target_test_pass >= t.targetTest && m.overclaiming_rate <= t.overclaiming) {
    return { role: "critic_only", reason: `not a builder, but evidence-honest (target_test ${fmt(m.target_test_pass)}, overclaiming ${fmt(m.overclaiming_rate)})` };
  }
  return {
    role: "not_recommended",
    reason: `no reliable lane (tool_call ${fmt(m.tool_call_reliability)}, parseability ${fmt(m.patch_parseability)}, repair ${fmt(m.repair_success_rate)}, target_test ${fmt(m.target_test_pass)})`,
  };
}

/** Aggregate raw observations into a scorecard (mean over the DEFINED values per field). */
export function aggregateScorecard(model: string, observations: readonly ModeObservation[]): CapabilityScorecard {
  const metrics: CapabilityMetrics = {
    tool_call_reliability: mean(observations, "toolCallValid"),
    schema_reliability: mean(observations, "schemaValid"),
    patch_parseability: mean(observations, "patchParseable"),
    diff_minimality: mean(observations, "diffMinimal"),
    test_boundary_respect: mean(observations, "testBoundaryRespected"),
    target_test_pass: mean(observations, "targetTestPass"),
    full_verification_pass: mean(observations, "fullVerificationPass"),
    repair_success_rate: mean(observations, "repairSuccess"),
    overclaiming_rate: mean(observations, "overclaimed"),
  };
  const { role, reason } = routeFromMetrics(metrics);
  return { model, ...metrics, recommended_role: role, routing_reason: reason, observations };
}

/** Mean of a boolean field over the observations where it is defined (0 when never defined). */
function mean(observations: readonly ModeObservation[], key: keyof ModeObservation): number {
  let sum = 0;
  let n = 0;
  for (const o of observations) {
    const v = o[key];
    if (typeof v === "boolean") {
      sum += v ? 1 : 0;
      n += 1;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Round to 2dp for the routing_reason (kept readable; the metric itself stays full precision). */
function fmt(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

// ───────────────────────────────────────────────────────────────────────────
// Executor — runs the modes against a model (RoleEngine) and a fixture set.
// ───────────────────────────────────────────────────────────────────────────

/** Options for a harness run. */
export interface HarnessOptions {
  readonly model: string;
  /** Only `invokeModel` is used; the harness drives the model directly (no role dispatch). */
  readonly engine: RoleEngine;
  /** The fixtures to evaluate. Defaults to DEFAULT_FIXTURES (the plan's 3). */
  readonly fixtures?: readonly HarnessFixture[];
  /** Minimality budget: a diff touching at most this many files beyond the target counts minimal. */
  readonly maxExtraFiles?: number;
}

/**
 * Evaluate a model across all four modes for every fixture and return its scorecard. Each mode
 * issues its own `invokeModel` call tagged with `metadata.harnessMode` so a fixture-aware engine
 * (or a test double) can answer per mode. Never throws — a thrown engine call scores that mode's
 * applicable fields as failures (a model that errors is, for routing, unreliable there).
 */
export async function runCapabilityHarness(opts: HarnessOptions): Promise<CapabilityScorecard> {
  const fixtures = opts.fixtures ?? DEFAULT_FIXTURES;
  const maxExtraFiles = opts.maxExtraFiles ?? 0;
  const observations: ModeObservation[] = [];

  for (const fx of fixtures) {
    observations.push(await runAgentMode(opts.engine, opts.model, fx));
    observations.push(await runPatchMode(opts.engine, opts.model, fx, "patch", maxExtraFiles));
    observations.push(await runPatchMode(opts.engine, opts.model, fx, "plan_patch", maxExtraFiles));
    observations.push(await runRepairMode(opts.engine, opts.model, fx, maxExtraFiles));
  }
  return aggregateScorecard(opts.model, observations);
}

/** Mode A — does the model emit a valid tool call for the goal? */
async function runAgentMode(engine: RoleEngine, model: string, fx: HarnessFixture): Promise<ModeObservation> {
  try {
    const res = await engine.invokeModel({
      model,
      identity: { agentId: "harness", functionalRole: "builder" },
      messages: [{ role: "system", content: "You are an autonomous coding agent. Use a tool to begin." }, { role: "user", content: fx.goal }],
      tools: TOOLS,
      metadata: { harnessMode: "agent", fixture: fx.name },
    });
    const call = res.toolCalls?.[0];
    if (call === undefined) {
      // No tool call at all. If the model nonetheless CLAIMED completion, that's overclaiming.
      const overclaimed = /\b(done|complete|fixed|finished)\b/i.test(res.content);
      return { fixture: fx.name, mode: "agent", toolCallValid: false, schemaValid: false, ...(overclaimed ? { overclaimed: true } : { overclaimed: false }) };
    }
    const v = validateToolCall(call.name, call.arguments);
    // Overclaiming: declared `done` while the work is plainly not done (no edit produced).
    const overclaimed = call.name === "done";
    return { fixture: fx.name, mode: "agent", toolCallValid: v.knownTool, schemaValid: v.schemaOk, overclaimed };
  } catch {
    return { fixture: fx.name, mode: "agent", toolCallValid: false, schemaValid: false, overclaimed: false };
  }
}

/** Mode B/C — does the model return a parseable, minimal, boundary-respecting, passing patch? */
async function runPatchMode(engine: RoleEngine, model: string, fx: HarnessFixture, mode: "patch" | "plan_patch", maxExtraFiles: number): Promise<ModeObservation> {
  const forbidden = fx.forbiddenFiles ?? defaultForbidden(fx);
  try {
    const res = await engine.invokeModel({
      model,
      identity: { agentId: "harness", functionalRole: "builder" },
      messages: [
        { role: "system", content: PATCHSMITH_SYSTEM },
        { role: "user", content: patchPrompt(fx, mode) },
      ],
      metadata: { harnessMode: mode, fixture: fx.name },
    });
    return scorePatch(fx, mode, res.content, forbidden, maxExtraFiles);
  } catch {
    return { fixture: fx.name, mode, patchParseable: false, diffMinimal: false, testBoundaryRespected: false, targetTestPass: false, fullVerificationPass: false };
  }
}

/** Mode D — given verifier output, does the model produce a patch that fixes it? */
async function runRepairMode(engine: RoleEngine, model: string, fx: HarnessFixture, maxExtraFiles: number): Promise<ModeObservation> {
  const forbidden = fx.forbiddenFiles ?? defaultForbidden(fx);
  try {
    const res = await engine.invokeModel({
      model,
      identity: { agentId: "harness", functionalRole: "builder" },
      messages: [
        { role: "system", content: PATCHSMITH_SYSTEM },
        { role: "user", content: `${patchPrompt(fx, "patch")}\n\nA prior patch FAILED verification:\n${fx.repairVerifierOutput}\nProduce a corrected unified diff.` },
      ],
      metadata: { harnessMode: "repair", fixture: fx.name },
    });
    const scored = scorePatch(fx, "repair", res.content, forbidden, maxExtraFiles);
    // Repair "success" = a clean patch that makes full verification pass.
    return { ...scored, repairSuccess: scored.fullVerificationPass === true };
  } catch {
    return { fixture: fx.name, mode: "repair", repairSuccess: false, patchParseable: false };
  }
}

/** Parse + apply (in memory) + score a patch against the fixture oracles. */
function scorePatch(fx: HarnessFixture, mode: CapabilityMode, raw: string, forbidden: readonly string[], maxExtraFiles: number): ModeObservation {
  const extracted = extractDiff(raw);
  if (extracted.kind !== "diff") {
    return { fixture: fx.name, mode, patchParseable: false, diffMinimal: false, testBoundaryRespected: true, targetTestPass: false, fullVerificationPass: false };
  }
  const parsed = parseUnifiedDiff(extracted.text);
  if (!parsed.ok) {
    return { fixture: fx.name, mode, patchParseable: false, diffMinimal: false, testBoundaryRespected: true, targetTestPass: false, fullVerificationPass: false };
  }
  // Boundary: did it touch a forbidden file?
  const touched = parsed.files.map((f) => f.path.replace(/\\/g, "/"));
  const boundaryRespected = !touched.some((p) => forbidden.some((f) => p === f || p.startsWith(`${f.replace(/\/$/, "")}/`)));
  // Minimality: at most (target + maxExtraFiles) files, and a bounded changed-line count.
  const changedLines = parsed.files.reduce((n, f) => n + f.hunks.reduce((h, hk) => h + hk.lines.filter((l) => l.kind !== "context").length, 0), 0);
  const minimal = touched.length <= 1 + maxExtraFiles && changedLines <= 40;

  // Apply in memory over a copy of the fixture file map.
  const next: Record<string, string> = { ...fx.files };
  let applied = true;
  for (const fp of parsed.files) {
    if (fp.deleted) {
      delete next[fp.path];
      continue;
    }
    const original = next[fp.path] ?? "";
    const r = applyFilePatch(original, fp);
    if (!r.ok) {
      applied = false;
      break;
    }
    next[fp.path] = r.content;
  }
  if (!applied) {
    return { fixture: fx.name, mode, patchParseable: true, diffMinimal: minimal, testBoundaryRespected: boundaryRespected, targetTestPass: false, fullVerificationPass: false };
  }
  const targetPass = boundaryRespected && fx.targetTestPasses(next);
  const fullPass = boundaryRespected && fx.fullVerificationPasses(next);
  return { fixture: fx.name, mode, patchParseable: true, diffMinimal: minimal, testBoundaryRespected: boundaryRespected, targetTestPass: targetPass, fullVerificationPass: fullPass };
}

/** Default boundary: every *.test/*.spec file present in the fixture. */
function defaultForbidden(fx: HarnessFixture): string[] {
  return Object.keys(fx.files).filter((p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p));
}

/** The patch prompt for a fixture (mode C prepends a one-line plan instruction). */
function patchPrompt(fx: HarnessFixture, mode: CapabilityMode): string {
  const fileBlocks = Object.entries(fx.files)
    .map(([p, c]) => `--- ${p} ---\n${c}`)
    .join("\n\n");
  const planLine = mode === "plan_patch" ? "First think through the fix in one sentence, then output ONLY the unified diff.\n\n" : "";
  return `${planLine}TASK: ${fx.goal}\n\nRELEVANT FILES:\n${fileBlocks}`;
}

/** Validate a tool call: known tool + parseable JSON args + required string fields present. */
function validateToolCall(name: string, argsJson: string): { knownTool: boolean; schemaOk: boolean } {
  const tool = TOOLS.find((t) => t.name === name);
  if (tool === undefined) return { knownTool: false, schemaOk: false };
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson && argsJson.length > 0 ? argsJson : "{}") as Record<string, unknown>;
  } catch {
    return { knownTool: true, schemaOk: false };
  }
  const schema = tool.parameters as { required?: readonly string[]; properties?: Record<string, { type?: string }> };
  for (const req of schema.required ?? []) {
    const v = args[req];
    const type = schema.properties?.[req]?.type;
    if (v === undefined || v === null) return { knownTool: true, schemaOk: false };
    if (type === "string" && (typeof v !== "string" || v.length === 0)) return { knownTool: true, schemaOk: false };
  }
  return { knownTool: true, schemaOk: true };
}

// ───────────────────────────────────────────────────────────────────────────
// DEFAULT FIXTURES — the plan's three (in-memory, oracle-scored).
// ───────────────────────────────────────────────────────────────────────────

/** Fixture 1 — one-file bug fix: a function returns the wrong value; a test asserts the right one. */
const FIX_ONE_FILE: HarnessFixture = {
  name: "one-file-bug-fix",
  goal: "Fix add() in src/math.ts so it returns a + b (it currently returns a - b).",
  files: {
    "src/math.ts": "export function add(a: number, b: number): number {\n  return a - b;\n}\n",
    "src/math.test.ts": "import { add } from './math.js';\nif (add(2, 3) !== 5) throw new Error('add broken');\n",
  },
  targetFile: "src/math.ts",
  repairVerifierOutput: "CHECK RESULTS: FAILED\n[check: test] FAILED\n  error: add broken\n",
  targetTestPasses: (f) => /return a \+ b/.test(f["src/math.ts"] ?? ""),
  fullVerificationPasses: (f) => /return a \+ b/.test(f["src/math.ts"] ?? "") && !/return a - b/.test(f["src/math.ts"] ?? ""),
};

/** Fixture 2 — add missing edge-case handling without touching the test. */
const FIX_EDGE_CASE: HarnessFixture = {
  name: "missing-edge-case",
  goal: "Make divide() in src/div.ts throw on a zero divisor instead of returning Infinity.",
  files: {
    "src/div.ts": "export function divide(a: number, b: number): number {\n  return a / b;\n}\n",
    "src/div.test.ts": "import { divide } from './div.js';\nlet threw = false;\ntry { divide(1, 0); } catch { threw = true; }\nif (!threw) throw new Error('expected throw on zero');\n",
  },
  targetFile: "src/div.ts",
  repairVerifierOutput: "CHECK RESULTS: FAILED\n[check: test] FAILED\n  error: expected throw on zero\n",
  targetTestPasses: (f) => /throw/.test(f["src/div.ts"] ?? ""),
  fullVerificationPasses: (f) => /throw/.test(f["src/div.ts"] ?? "") && /b === 0|b == 0|!b\b/.test(f["src/div.ts"] ?? ""),
};

/** Fixture 3 — repair a TypeScript compile error (a wrong type annotation). */
const FIX_TYPE_ERROR: HarnessFixture = {
  name: "type-error",
  goal: "Fix the type error in src/name.ts: greet() is annotated to return number but returns a string.",
  files: {
    "src/name.ts": "export function greet(n: string): number {\n  return `hi ${n}`;\n}\n",
  },
  targetFile: "src/name.ts",
  repairVerifierOutput: "CHECK RESULTS: FAILED\n[check: typecheck] FAILED\n  error: Type 'string' is not assignable to type 'number'.\n",
  targetTestPasses: (f) => /: string \{/.test(f["src/name.ts"] ?? ""),
  fullVerificationPasses: (f) => /: string \{/.test(f["src/name.ts"] ?? "") && !/: number \{/.test(f["src/name.ts"] ?? ""),
};

/** The plan's three fixtures: one-file fix, edge-case, type error. */
export const DEFAULT_FIXTURES: readonly HarnessFixture[] = [FIX_ONE_FILE, FIX_EDGE_CASE, FIX_TYPE_ERROR];
