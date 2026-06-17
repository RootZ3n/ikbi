/**
 * ikbi worker-model — FIX DIAGNOSIS (docs/FIX-MODE-DESIGN.md §3, stage 4 CLASSIFY).
 *
 * Diagnosis comes FIRST, before any edit. This classifies a reproduced failure into a
 * category that GATES the rest of the pipeline. The thin slice supports three:
 *
 *   • implementation_bug — the code is wrong, the test is right → fix the code.
 *   • test_bug           — the test is wrong, the code is right → refuse (without
 *                          --allow-test-edits, editing tests is forbidden).
 *   • tool_limitation    — the verifier could not even run/parse the tests → not a
 *                          project failure; nothing to fix by editing code.
 *
 * The KEY insight: to tell implementation_bug from test_bug, the model must READ both the
 * code AND the test and reason about which one is correct. A collection/tool crash needs no
 * model — it is decided deterministically from the parsed output (an AssertionError means a
 * test actually ran and disagreed with the code; a collection error means it never ran).
 *
 * SECURITY: the code, test, and check output are UNTRUSTED data — they ride into the model
 * through the neutralization chokepoint (#8), never raw-concatenated into the trusted
 * instruction.
 */

import { neutralizeUntrusted, toUntrustedMessage } from "../../core/injection/index.js";
import type { NeutralizedContent, UntrustedContext } from "../../core/injection/contract.js";
import type { AgentIdentity, ModelMessage, ModelRequest, ModelResponse } from "../../core/provider/contract.js";
import { builderModel } from "./role-models.js";
import type { DiagnosisCategory, ParsedOutcomes } from "./fix-receipt.js";

/** A candidate file the diagnosis may read (code or test). */
export interface DiagnosisFile {
  readonly path: string;
  readonly content: string;
  readonly isTest: boolean;
}

export interface DiagnosisInput {
  readonly outcomes: ParsedOutcomes;
  readonly rawOutput: string;
  readonly files: readonly DiagnosisFile[];
  readonly goal?: string;
}

export interface Diagnosis {
  readonly category: DiagnosisCategory;
  readonly confidence: number;
  readonly evidence: string;
  readonly affectedFiles: readonly string[];
}

export interface DiagnosisDeps {
  /** The model seam — the SAME `invokeModel` build mode uses. */
  readonly invokeModel: (request: ModelRequest) => Promise<ModelResponse>;
  /** #8 neutralization seam. Default: the core chokepoint. */
  readonly neutralize?: (content: string, context: UntrustedContext) => NeutralizedContent;
  /** Model id. Default: the configured builder model. */
  readonly modelId?: string;
  /** Identity for the model call. Default: a fix-role identity. */
  readonly identity?: AgentIdentity;
}

const DEFAULT_IDENTITY: AgentIdentity = { agentId: "fix", functionalRole: "fix" };
const DIAGNOSIS_TEMPERATURE = 0;
const DIAGNOSIS_MAX_TOKENS = 1_024;

/** The trusted system instruction for the classify-only model call. */
export const DIAGNOSIS_SYSTEM =
  "You are a failure-diagnosis classifier for a code repair engine. A check FAILED. You are given " +
  "the source code, the test (if any), and the failing output. Decide which of FOUR categories applies:\n" +
  "  - \"implementation_bug\": the CODE is wrong and the TEST is correct. Fix the code.\n" +
  "  - \"test_bug\": the TEST is wrong (e.g. asserts the wrong expected value) and the CODE is correct.\n" +
  "  - \"tool_limitation\": the VERIFICATION TOOL (linter, type checker, formatter) is wrong — it rejects " +
  "valid code. The code and tests are both correct. Do NOT edit the code; the tool needs fixing or updating.\n" +
  "  - \"verifier_environment_missing\": the check failed because a required tool/binary is not installed " +
  "or not available. The code and tests are both correct. Do NOT edit the code.\n\n" +
  "KEY DISTINCTIONS:\n" +
  "- If pytest assertions fail → implementation_bug or test_bug (read code AND test to decide).\n" +
  "- If a LINTER/FORMATTER/TYPE-CHECKER fails on code that pytest passes → tool_limitation.\n" +
  "- If the check command itself cannot run (missing binary, permission denied) → verifier_environment_missing.\n" +
  "- If a non-pytest tool prints errors about valid syntax → tool_limitation.\n\n" +
  "Reply with ONLY a JSON object:\n" +
  '{"category": "implementation_bug" | "test_bug" | "tool_limitation" | "verifier_environment_missing", "confidence": 0.0-1.0, "evidence": "<one sentence>", "affectedFiles": ["path", ...]}\n' +
  "affectedFiles must list the file(s) that are WRONG (code file for implementation_bug, test file for test_bug, " +
  "tool config for tool_limitation, empty for verifier_environment_missing). " +
  "Do NOT include any prose outside the JSON.";

/** Extract the first balanced top-level JSON object from a model response (tolerant of prose). */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Clamp a model-supplied confidence into [0,1]; default 0.5 when missing/garbage. */
function clampConfidence(v: unknown): number {
  const n = typeof v === "number" ? v : Number.NaN;
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/**
 * Classify a reproduced failure. Collection/tool crashes are decided deterministically
 * (no model); assertion failures need the model to read code + test and judge which is
 * correct. NEVER throws — a model/parse failure degrades to `unresolved`.
 */
export async function diagnoseFailure(input: DiagnosisInput, deps: DiagnosisDeps): Promise<Diagnosis> {
  // A check that did not actually fail has nothing to diagnose.
  if (input.outcomes.passed) {
    return { category: "unresolved", confidence: 1, evidence: "the failing check did not reproduce (it passed) — nothing to diagnose", affectedFiles: [] };
  }

  // STAGE-4a (deterministic): a COLLECTION / tool crash means the tests never ran. The verifier
  // could not parse/execute the code — a tool limitation, not a code or test bug.
  if (input.outcomes.collectionError) {
    return {
      category: "tool_limitation",
      confidence: 0.85,
      evidence: `the check failed during collection/setup (the tests never ran): ${input.outcomes.summary}`,
      affectedFiles: [],
    };
  }

  // STAGE-4a2 (deterministic): the check command was denied by governed-exec or the binary is
  // missing. This is an environment issue — the code and tests are fine.
  if (/denied|not on the allowlist|not found|No such file|permission denied/i.test(input.rawOutput) &&
      !/AssertionError|FAILED|FAIL\b/.test(input.rawOutput)) {
    return {
      category: "verifier_environment_missing",
      confidence: 0.9,
      evidence: `the check command failed due to environment/access issues (not a code failure): ${input.rawOutput.slice(0, 200)}`,
      affectedFiles: [],
    };
  }

  // STAGE-4a3 (deterministic): a non-pytest linter/formatter/type-checker failed but tests pass.
  // The tool rejects valid code — this is a tool limitation, not a code bug.
  const hasTestFailures = input.outcomes.failingTests.length > 0 || /FAIL\b|FAILED|AssertionError/.test(input.rawOutput);
  const looksLikeLinter = /E\d{3}\b|W\d{3}\b|lint|format|style|mypy|flake8|pylint|ruff|gdlint/i.test(input.rawOutput);
  if (!hasTestFailures && looksLikeLinter) {
    return {
      category: "tool_limitation",
      confidence: 0.85,
      evidence: `a linter/formatter/type-checker failed on code that has no test failures — tool limitation, not a code bug`,
      affectedFiles: [],
    };
  }

  // STAGE-4b (model): an assertion failed — a test ran and disagreed with the code. Read both and
  // decide whether the CODE is wrong (implementation_bug) or the TEST is wrong (test_bug).
  const neutralize = deps.neutralize ?? neutralizeUntrusted;
  const identity = deps.identity ?? DEFAULT_IDENTITY;
  const modelId = deps.modelId ?? builderModel();

  const fileBlocks = input.files
    .map((f) => `--- ${f.path} ${f.isTest ? "(TEST)" : "(CODE)"} ---\n${f.content}`)
    .join("\n\n");
  const contextBody = [
    input.goal !== undefined && input.goal.length > 0 ? `CONTEXT: ${input.goal}` : "",
    "FAILING CHECK OUTPUT:",
    input.rawOutput.length > 0 ? input.rawOutput : "(no output captured)",
    "",
    "FILES:",
    fileBlocks.length > 0 ? fileBlocks : "(no files supplied)",
  ]
    .filter((s) => s.length > 0)
    .join("\n");

  const untrusted: ModelMessage = toUntrustedMessage(neutralize(contextBody, { source: "external", identity, origin: "fix_diagnosis" }), { role: "user" });
  const messages: ModelMessage[] = [{ role: "system", content: DIAGNOSIS_SYSTEM }, untrusted];

  let raw: string;
  try {
    const response = await deps.invokeModel({
      model: modelId,
      temperature: DIAGNOSIS_TEMPERATURE,
      maxTokens: DIAGNOSIS_MAX_TOKENS,
      identity,
      messages,
      metadata: { fixStage: "diagnose" },
    });
    raw = response.content;
  } catch (err) {
    return { category: "unresolved", confidence: 0, evidence: `diagnosis model call failed: ${err instanceof Error ? err.message : String(err)}`, affectedFiles: [] };
  }

  const VALID_CATEGORIES = new Set(["implementation_bug", "test_bug", "tool_limitation", "verifier_environment_missing"]);
  const obj = extractJsonObject(raw);
  const category = obj?.category;
  if (typeof category !== "string" || !VALID_CATEGORIES.has(category)) {
    return { category: "unresolved", confidence: 0.2, evidence: `could not classify from the model response (got: ${typeof category === "string" ? category : "no category"})`, affectedFiles: [] };
  }

  // Default affectedFiles from the model; fall back to the obvious file for the category.
  const modelFiles = Array.isArray(obj?.affectedFiles) ? (obj!.affectedFiles as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const fallback = category === "test_bug"
    ? input.files.filter((f) => f.isTest).map((f) => f.path)
    : category === "implementation_bug"
      ? input.files.filter((f) => !f.isTest).map((f) => f.path)
      : []; // tool_limitation / verifier_environment_missing — no files to fix
  const affectedFiles = modelFiles.length > 0 ? modelFiles : fallback;

  return {
    category: category as DiagnosisCategory,
    confidence: clampConfidence(obj?.confidence),
    evidence: typeof obj?.evidence === "string" && obj.evidence.length > 0 ? obj.evidence : `classified as ${category}`,
    affectedFiles,
  };
}
