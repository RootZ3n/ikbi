/**
 * ikbi worker-model — FIX RECEIPT (the audit trail of a `ikbi fix` run).
 *
 * fix mode's receipt is richer than a build receipt: it records EVERY stage of the
 * 12-stage diagnosis-first pipeline (docs/FIX-MODE-DESIGN.md §8). The discipline is
 * simple and load-bearing — "if it's not in the receipt, it didn't happen". A refusal
 * is a first-class, fully-recorded outcome, not an empty result.
 *
 * PURE library: no IO, no model, no spawn. The pipeline (`fix.ts`) feeds it stage
 * results as it goes and finalizes with the classified outcome.
 */

/**
 * The diagnosis taxonomy (docs/FIX-MODE-DESIGN.md §3). The THIN SLICE classifies only
 * three of these (`implementation_bug`, `test_bug`, `tool_limitation`); the rest are
 * named so the receipt shape is stable as later categories are wired.
 */
export type DiagnosisCategory =
  | "implementation_bug"
  | "test_bug"
  | "tool_limitation"
  | "verifier_environment_missing"
  | "fixture_bug"
  | "contract_mismatch"
  | "parser_bug"
  | "receipt_metadata_gap"
  | "unsafe_repair_attempt"
  | "unresolved";

/** The terminal outcome of a fix run (docs/FIX-MODE-DESIGN.md §5). */
export type FixResult =
  | "FIXED_NARROWLY"
  | "CORRECT_REFUSAL"
  | "SAFE_FAIL"
  | "UNSAFE_FAIL"
  | "NEEDS_HUMAN"
  | "TOOL_LIMITATION"
  | "ENVIRONMENT_MISSING"
  | "UNRESOLVED";

/**
 * Structured parse of the failing check's output. Derived deterministically from the
 * check-triage parser (no model). `collectionError` distinguishes a TOOL/COLLECTION
 * failure (the verifier could not even run the tests) from an assertion failure.
 */
export interface ParsedOutcomes {
  /** Did the check pass overall (exit 0 AND no parsed failures AND not zero-tests). */
  readonly passed: boolean;
  /** Failing test identifiers parsed from the output (bounded, deduped). */
  readonly failingTests: readonly string[];
  /**
   * True when the failure is a COLLECTION / TOOL crash (import error, syntax the tool
   * cannot parse, internal error) rather than a test assertion failing. Drives the
   * `tool_limitation` diagnosis.
   */
  readonly collectionError: boolean;
  /** One-line human summary (always non-empty). */
  readonly summary: string;
  /** Detected test framework, when known (e.g. "pytest"). */
  readonly framework?: string;
}

/** One anti-cheat sub-check's verdict (see `fix-anti-cheat.ts`). */
export interface AntiCheatCheckResult {
  readonly name: string;
  readonly passed: boolean;
  readonly evidence: string;
}

/**
 * THE FIX RECEIPT — the full diagnostic trail of one fix run. Every stage is recorded
 * even when skipped (a skipped stage carries an honest "(skipped: …)" sentinel rather
 * than being absent), so the receipt is a complete, uniform audit object.
 */
export interface FixReceipt {
  readonly started: { readonly timestamp: string; readonly repo: string; readonly check: string; readonly head: string };
  readonly failureReproduced: { readonly exitCode: number; readonly outcomes: ParsedOutcomes; readonly rawOutput: string };
  readonly diagnosis: { readonly category: DiagnosisCategory; readonly confidence: number; readonly evidence: string; readonly affectedFiles: readonly string[] };
  readonly plan: { readonly files: readonly string[]; readonly change: string; readonly why: string };
  readonly patchApplied: { readonly diff: string; readonly filesModified: readonly string[] };
  readonly targetedCheck: { readonly passed: boolean; readonly output: string };
  readonly fullCheck: { readonly passed: boolean; readonly regressionCount: number };
  readonly antiCheat: { readonly passed: boolean; readonly checks: readonly AntiCheatCheckResult[] };
  /**
   * How many patch+verify attempts the fix-retry loop made (Gap M6). 0 means no repair was
   * attempted (a refusal/terminal diagnosis); 1 means the first patch settled it; >1 means the
   * model was fed the verification failure and retried. Optional for back-compat with receipts
   * authored before the field existed — the builder always populates it.
   */
  readonly attempts?: number;
  /**
   * The patch model used on each attempt, in order (dual-model escalation, Gap M6). Index `i` is
   * the model id of attempt `i+1`. Empty when no repair was attempted. Optional for back-compat with
   * receipts authored before the field existed — the builder always populates it.
   */
  readonly attemptModels?: readonly string[];
  readonly result: FixResult;
  /** Whether the fix was promoted. ALWAYS false in this slice — promote requires explicit approval. */
  readonly promoted: boolean;
}

/** A bounded slice of raw output kept in the receipt (the head is the most useful part). */
const MAX_RAW_OUTPUT = 8_000;

/** Bound a string to `MAX_RAW_OUTPUT` bytes with an honest truncation marker. */
function boundRaw(s: string): string {
  if (s.length <= MAX_RAW_OUTPUT) return s;
  return `${s.slice(0, MAX_RAW_OUTPUT)}\n…[truncated ${s.length - MAX_RAW_OUTPUT} chars]`;
}

/**
 * Incremental builder for a FixReceipt. The pipeline records each stage as it runs and
 * calls `finalize(result)` to produce the immutable receipt. Stages not reached keep their
 * honest skipped defaults — the receipt is always complete and uniform.
 */
export class FixReceiptBuilder {
  private readonly started: FixReceipt["started"];
  private failureReproduced: FixReceipt["failureReproduced"] = {
    exitCode: -1,
    outcomes: { passed: false, failingTests: [], collectionError: false, summary: "(not reproduced)" },
    rawOutput: "",
  };
  private diagnosis: FixReceipt["diagnosis"] = { category: "unresolved", confidence: 0, evidence: "(not diagnosed)", affectedFiles: [] };
  private plan: FixReceipt["plan"] = { files: [], change: "(no plan)", why: "(no plan)" };
  private patchApplied: FixReceipt["patchApplied"] = { diff: "", filesModified: [] };
  private targetedCheck: FixReceipt["targetedCheck"] = { passed: false, output: "(skipped: no edit attempted)" };
  private fullCheck: FixReceipt["fullCheck"] = { passed: false, regressionCount: 0 };
  private antiCheat: FixReceipt["antiCheat"] = { passed: true, checks: [] };
  private attempts = 0;
  private readonly attemptModels: string[] = [];

  constructor(started: { timestamp: string; repo: string; check: string; head: string }) {
    this.started = { ...started };
  }

  recordReproduce(exitCode: number, outcomes: ParsedOutcomes, rawOutput: string): void {
    this.failureReproduced = { exitCode, outcomes, rawOutput: boundRaw(rawOutput) };
  }

  recordDiagnosis(d: FixReceipt["diagnosis"]): void {
    this.diagnosis = { ...d, affectedFiles: [...d.affectedFiles] };
  }

  recordPlan(p: FixReceipt["plan"]): void {
    this.plan = { files: [...p.files], change: p.change, why: p.why };
  }

  recordPatch(diff: string, filesModified: readonly string[]): void {
    this.patchApplied = { diff: boundRaw(diff), filesModified: [...filesModified] };
  }

  recordTargetedCheck(passed: boolean, output: string): void {
    this.targetedCheck = { passed, output: boundRaw(output) };
  }

  recordFullCheck(passed: boolean, regressionCount: number): void {
    this.fullCheck = { passed, regressionCount };
  }

  recordAntiCheat(passed: boolean, checks: readonly AntiCheatCheckResult[]): void {
    this.antiCheat = { passed, checks: [...checks] };
  }

  /** Record how many patch+verify attempts the fix-retry loop made (Gap M6). */
  recordAttempts(n: number): void {
    this.attempts = n;
  }

  /** Record the patch model used on one attempt, in order (dual-model escalation, Gap M6). */
  recordAttemptModel(model: string): void {
    this.attemptModels.push(model);
  }

  /** Produce the immutable receipt. `promoted` is hardcoded false (no promote without approval). */
  finalize(result: FixResult): FixReceipt {
    return {
      started: this.started,
      failureReproduced: this.failureReproduced,
      diagnosis: this.diagnosis,
      plan: this.plan,
      patchApplied: this.patchApplied,
      targetedCheck: this.targetedCheck,
      fullCheck: this.fullCheck,
      antiCheat: this.antiCheat,
      attempts: this.attempts,
      attemptModels: [...this.attemptModels],
      result,
      promoted: false,
    };
  }
}
