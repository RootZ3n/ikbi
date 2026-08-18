/**
 * ikbi v2 — THE CANONICAL CONTEXT AUTHORITY.
 *
 * Exactly one component decides what a future builder will see: `assembleContext`.
 * Many sources may CONTRIBUTE candidates; none may deliver anything downstream. The
 * assembler admits, orders, bounds and records — and what comes out is a single
 * immutable, content-addressed `ContextPackage` that answers, for any run:
 *
 *   what did the builder see, where did it come from, how much fit,
 *   what was omitted, and which exact repository state did it represent?
 *
 * WHY THIS FILE IS PURE: it reads no file and imports no v1 code. Sources are injected
 * (`ContextSource`), exactly as configuration is. That keeps the admission POLICY —
 * priority, budget, trimming, identity — in one testable place, and keeps every source
 * incapable of promoting its own contribution.
 *
 * THREE RULES THE ASSEMBLER ENFORCES:
 *
 *   1. NO SILENT OVERFLOW. Every artifact that does not fit is recorded as an explicit
 *      omission with a reason. Nothing is dropped invisibly, and nothing is admitted
 *      past the budget.
 *   2. NO GUESSED CAPABILITY. The budget is derived only from capability facts the
 *      inventory could state truthfully. A model with no known window produces a
 *      structured failure, never an invented budget.
 *   3. STATE-BOUND CONTENT. Every artifact carries the SHA-256 of the exact bytes that
 *      were observed. The package therefore names a precise repository state, so a
 *      later mutation authority can refuse an edit built on context it never saw.
 *
 * TOKEN COUNTS ARE ESTIMATES. v1 counts tokens as `ceil(chars / 4)` everywhere
 * (`core/context/budget.ts:23`, `worker-model/context-preflight.ts:18`). v2 adopts that
 * heuristic and LABELS it: every token number here is `estimated`, the divisor is
 * recorded in the budget, and nothing in this file claims a package "fits" as a measured
 * fact.
 */

import { createHash } from "node:crypto";

import { contentDigest, type V2ArtifactDigest, type V2ContextDigest, type V2DecisionDigest, type V2RunId, type V2TaskId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { ModelCapabilityFacts } from "./config.js";

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/**
 * PRIORITY BANDS, highest first. Admission walks these in order, so the policy is one
 * ordered list rather than each source asserting its own importance.
 *
 *   task                     the operator's intent. Never trimmed — a run that cannot
 *                            afford its own goal is a failure, not a smaller run.
 *   repository_instructions  the repo's stated conventions (CLAUDE.md / AGENTS.md /
 *                            .ikbi). Guidance for the builder — never authority over
 *                            safety, routing, mutation or promotion.
 *   target_file              files the goal explicitly names: the most direct evidence
 *                            of what the task is actually about.
 */
export const CONTEXT_CATEGORIES = ["task", "repository_instructions", "target_file"] as const;
export type ContextCategory = (typeof CONTEXT_CATEGORIES)[number];

/** Priority index of a category (lower = admitted earlier). */
export function categoryPriority(category: ContextCategory): number {
  return CONTEXT_CATEGORIES.indexOf(category);
}

/** A candidate produced by a source, before the assembler decides anything. */
export interface ContextCandidate {
  readonly category: ContextCategory;
  /** Which source produced this. Recorded so provenance survives into the package. */
  readonly sourceId: string;
  /** Repository-relative path, when the candidate came from a file. */
  readonly path?: string;
  /** Whether the bytes are operator-authored intent or repository content. */
  readonly origin: "operator" | "repository";
  /** The text itself, already byte-bounded by its source if the source caps size. */
  readonly content: string;
  /** Byte length BEFORE any source-level truncation. Equals content length when whole. */
  readonly originalBytes: number;
  /** True when the SOURCE truncated the content to a byte cap. */
  readonly truncated: boolean;
  /** SHA-256 of the exact observed source bytes — the state binding. */
  readonly observedSha256: string;
  /** Short, closed-vocabulary explanation of why this was offered. */
  readonly reason: string;
}

/** An admitted candidate, with its identity and accounting fixed. */
export interface ContextArtifact {
  readonly artifactId: V2ArtifactDigest;
  readonly category: ContextCategory;
  readonly sourceId: string;
  readonly path?: string;
  readonly origin: "operator" | "repository";
  readonly bytes: number;
  readonly originalBytes: number;
  readonly truncated: boolean;
  /** SHA-256 of the exact bytes observed at the source. */
  readonly observedSha256: string;
  readonly estimatedTokens: number;
  readonly reason: string;
  /** The text the builder would receive. Stripped from published manifests. */
  readonly content: string;
}

/** Why a candidate did not make it in. Closed set — no invisible dropping. */
export type ContextOmissionReason =
  | "budget_exceeded"
  | "not_found"
  | "unreadable"
  | "outside_repository"
  | "not_a_regular_file"
  | "empty";

/** One recorded omission. Every candidate that did not become an artifact leaves one. */
export interface ContextOmission {
  readonly category: ContextCategory;
  readonly sourceId: string;
  readonly path?: string;
  readonly reason: ContextOmissionReason;
  readonly detail: string;
  /** What it would have cost, when that is known (a budget omission always knows). */
  readonly estimatedTokens?: number;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** What a source is told. Deliberately minimal — a source decides nothing about fit. */
export interface ContextSourceRequest {
  readonly goal: string;
  readonly repoPath: string;
}

/**
 * A contributor of candidates. A source may READ; it may not mutate, may not invoke a
 * model, and may not deliver anything downstream. It reports what it could not read as
 * an omission rather than staying silent about it.
 */
export interface ContextSource {
  readonly id: string;
  collect(request: ContextSourceRequest): Promise<ContextSourceResult>;
}

/** What a source found, and what it could not. */
export interface ContextSourceResult {
  readonly candidates: readonly ContextCandidate[];
  readonly omissions: readonly ContextOmission[];
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** v1's chars→token heuristic, adopted verbatim and always labelled as an estimate. */
export const CHARS_PER_TOKEN = 4;

/** Estimate tokens from text. An ESTIMATE — see the file header. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Reservation policy. These are POLICY CHOICES, not measurements, and they are named so
 * they can be argued with: leave room for the model to answer, and for the system prompt
 * and tool schemas the invocation layer will add.
 */
export const COMPLETION_RESERVE_FRACTION = 0.25;
export const MIN_COMPLETION_RESERVE_TOKENS = 512;
export const MAX_COMPLETION_RESERVE_TOKENS = 8_192;
/** System prompt + tool schemas the builder surface adds on top of the context package. */
export const OVERHEAD_RESERVE_TOKENS = 1_500;

/**
 * The context budget, bound to the resolved model.
 *
 * `accounting` and `estimated` exist so no consumer can mistake this for a measurement.
 * `contextWindowTokens` comes only from capability facts that were roster-DECLARED or
 * table-KNOWN — an unclassified model yields a failure instead of a budget.
 */
export interface ContextBudget {
  readonly accounting: "estimated_chars_per_token";
  readonly charsPerToken: number;
  readonly estimated: true;
  readonly contextWindowTokens: number;
  readonly capabilityProvenance: ModelCapabilityFacts["provenance"];
  readonly reservedCompletionTokens: number;
  readonly reservedOverheadTokens: number;
  /** What context input may actually occupy. */
  readonly availableInputTokens: number;
}

/** Derive the budget, or explain why it cannot be derived. */
export function deriveBudget(capabilities: ModelCapabilityFacts | undefined): { ok: true; budget: ContextBudget } | { ok: false; failure: RunFailure } {
  if (capabilities === undefined) {
    return {
      ok: false,
      failure: contextFailure(
        V2_CONTEXT_FAILURE_CODES.modelCapabilityUnknown,
        "the resolved model has no known context window (unclassified, and the roster declares none) — a context budget cannot be derived without guessing",
      ),
    };
  }
  const window = capabilities.contextWindow;
  const reservedCompletionTokens = Math.min(
    MAX_COMPLETION_RESERVE_TOKENS,
    Math.max(MIN_COMPLETION_RESERVE_TOKENS, Math.floor(window * COMPLETION_RESERVE_FRACTION)),
  );
  const availableInputTokens = window - reservedCompletionTokens - OVERHEAD_RESERVE_TOKENS;
  if (availableInputTokens <= 0) {
    return {
      ok: false,
      failure: contextFailure(
        V2_CONTEXT_FAILURE_CODES.budgetUnusable,
        `the resolved model's ${window}-token window leaves no input budget after reserving ${reservedCompletionTokens} for completion and ${OVERHEAD_RESERVE_TOKENS} for prompt overhead`,
        { contextWindow: window },
      ),
    };
  }
  return {
    ok: true,
    budget: {
      accounting: "estimated_chars_per_token",
      charsPerToken: CHARS_PER_TOKEN,
      estimated: true,
      contextWindowTokens: window,
      capabilityProvenance: capabilities.provenance,
      reservedCompletionTokens,
      reservedOverheadTokens: OVERHEAD_RESERVE_TOKENS,
      availableInputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Package
// ---------------------------------------------------------------------------

/** THE authorized context. Immutable, content-addressed, bound to its run and decision. */
export interface ContextPackage {
  readonly packageId: V2ContextDigest;
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  /** The model-resolution decision whose capabilities bounded this package. */
  readonly resolutionDecisionId: V2DecisionDigest;
  readonly budget: ContextBudget;
  /** Admitted artifacts, in delivery order (priority band, then source order). */
  readonly artifacts: readonly ContextArtifact[];
  /** Everything that did not make it, and why. */
  readonly omissions: readonly ContextOmission[];
  readonly estimatedInputTokens: number;
  /** Sources consulted, in the order they were consulted. */
  readonly sourcesConsulted: readonly string[];
}

/** The published view: everything except artifact CONTENT. */
export interface ContextManifest extends Omit<ContextPackage, "artifacts"> {
  readonly artifacts: readonly Omit<ContextArtifact, "content">[];
}

/**
 * Strip artifact bodies for publication.
 *
 * Receipts and `--json` describe the package; they do not reproduce the repository into
 * a terminal or a log. Identity is unaffected — every artifact keeps the digest of the
 * exact bytes it carried, so the manifest still proves what was assembled.
 */
export function manifestOf(pkg: ContextPackage): ContextManifest {
  return {
    ...pkg,
    artifacts: pkg.artifacts.map(({ content: _content, ...rest }) => rest),
  };
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_CONTEXT_FAILURE_CODES = {
  modelCapabilityUnknown: "context.model_capability_unknown",
  budgetUnusable: "context.budget_unusable",
  budgetExceeded: "context.budget_exceeded",
  sourceFailed: "context.source_failed",
  decisionMismatch: "context.resolution_decision_mismatch",
} as const;

function contextFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "context",
    code,
    message,
    stage: "context",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** What the assembler is asked for. Names the decision it must be bound to. */
export interface ContextAssemblyRequest {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly goal: string;
  readonly repoPath: string;
  readonly resolutionDecisionId: V2DecisionDigest;
  readonly capabilities: ModelCapabilityFacts | undefined;
}

export type ContextAssemblyResult =
  | { readonly ok: true; readonly package: ContextPackage }
  | { readonly ok: false; readonly failure: RunFailure };

/** The operator's goal, as the always-first, never-trimmed artifact. */
function goalCandidate(goal: string): ContextCandidate {
  return {
    category: "task",
    sourceId: "task",
    origin: "operator",
    content: goal,
    originalBytes: Buffer.byteLength(goal, "utf8"),
    truncated: false,
    observedSha256: sha256Text(goal),
    reason: "the operator's stated goal",
  };
}

/**
 * SHA-256 of exactly these bytes — not of a JSON wrapper.
 *
 * Deliberately the same computation the state-bound mutation core performs on file
 * content (`core/workspace/file-state.ts`), so an artifact's `observedSha256` is
 * directly comparable with an observation a future mutation authority makes. That is
 * what lets a later slice refuse an edit built on context it never saw.
 */
export function sha256Text(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/**
 * THE canonical assembly. One package per run, or one structured failure.
 *
 * ADMISSION is first-fit in priority order: walk the bands highest-first, and within a
 * band the order the sources offered, admitting each candidate that still fits. A
 * candidate that does not fit is SKIPPED and recorded — the walk continues, so a small
 * late artifact is not punished for a large early one. Deterministic either way, and
 * every decision is written down.
 */
export async function assembleContext(
  request: ContextAssemblyRequest,
  sources: readonly ContextSource[],
): Promise<ContextAssemblyResult> {
  const derived = deriveBudget(request.capabilities);
  if (!derived.ok) return { ok: false, failure: derived.failure };
  const budget = derived.budget;

  const candidates: ContextCandidate[] = [goalCandidate(request.goal)];
  const omissions: ContextOmission[] = [];
  const sourcesConsulted: string[] = ["task"];

  for (const source of sources) {
    sourcesConsulted.push(source.id);
    let collected: ContextSourceResult;
    try {
      collected = await source.collect({ goal: request.goal, repoPath: request.repoPath });
    } catch (err) {
      // A source that throws is a defect in that source, not a reason to silently
      // deliver a smaller context: the run fails and says which source broke.
      return {
        ok: false,
        failure: contextFailure(
          V2_CONTEXT_FAILURE_CODES.sourceFailed,
          `context source "${source.id}" failed: ${err instanceof Error ? err.message : String(err)}`,
          { source: source.id },
        ),
      };
    }
    candidates.push(...collected.candidates);
    omissions.push(...collected.omissions);
  }

  // Stable ordering: priority band first, then the order candidates were offered.
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => categoryPriority(a.candidate.category) - categoryPriority(b.candidate.category) || a.index - b.index)
    .map((entry) => entry.candidate);

  const artifacts: ContextArtifact[] = [];
  let spent = 0;
  for (const candidate of ordered) {
    const estimated = estimateTokens(candidate.content);
    if (spent + estimated > budget.availableInputTokens) {
      if (candidate.category === "task") {
        // The goal itself does not fit. A run that cannot afford its own intent is a
        // failure, not a quieter run that omits what it was asked to do.
        return {
          ok: false,
          failure: contextFailure(
            V2_CONTEXT_FAILURE_CODES.budgetExceeded,
            `the task goal alone needs an estimated ${estimated} tokens but only ${budget.availableInputTokens} are available in a ${budget.contextWindowTokens}-token window`,
            { estimatedTokens: estimated, availableInputTokens: budget.availableInputTokens },
          ),
        };
      }
      omissions.push({
        category: candidate.category,
        sourceId: candidate.sourceId,
        ...(candidate.path !== undefined ? { path: candidate.path } : {}),
        reason: "budget_exceeded",
        detail: `needs an estimated ${estimated} tokens; ${budget.availableInputTokens - spent} remain`,
        estimatedTokens: estimated,
      });
      continue;
    }
    spent += estimated;
    artifacts.push({
      artifactId: contentDigest("artifact", {
        category: candidate.category,
        sourceId: candidate.sourceId,
        path: candidate.path,
        observedSha256: candidate.observedSha256,
        truncated: candidate.truncated,
      }),
      category: candidate.category,
      sourceId: candidate.sourceId,
      ...(candidate.path !== undefined ? { path: candidate.path } : {}),
      origin: candidate.origin,
      bytes: Buffer.byteLength(candidate.content, "utf8"),
      originalBytes: candidate.originalBytes,
      truncated: candidate.truncated,
      observedSha256: candidate.observedSha256,
      estimatedTokens: estimated,
      reason: candidate.reason,
      content: candidate.content,
    });
  }

  // IDENTITY binds the semantic inputs: which decision bounded it, what the budget was,
  // and exactly which observed content was admitted and omitted, in order. Absolute
  // repository paths and timestamps are excluded — relocating a checkout does not change
  // what the builder would see.
  const packageId = contentDigest("context", {
    resolutionDecisionId: request.resolutionDecisionId,
    goalSha256: sha256Text(request.goal),
    budget: {
      contextWindowTokens: budget.contextWindowTokens,
      reservedCompletionTokens: budget.reservedCompletionTokens,
      reservedOverheadTokens: budget.reservedOverheadTokens,
      availableInputTokens: budget.availableInputTokens,
      charsPerToken: budget.charsPerToken,
    },
    artifacts: artifacts.map((a) => ({
      category: a.category,
      sourceId: a.sourceId,
      path: a.path,
      observedSha256: a.observedSha256,
      bytes: a.bytes,
      originalBytes: a.originalBytes,
      truncated: a.truncated,
    })),
    omissions: omissions.map((o) => ({ category: o.category, sourceId: o.sourceId, path: o.path, reason: o.reason })),
  });

  return {
    ok: true,
    package: deepFreezePackage({
      packageId,
      runId: request.runId,
      taskId: request.taskId,
      resolutionDecisionId: request.resolutionDecisionId,
      budget,
      artifacts,
      omissions,
      estimatedInputTokens: spent,
      sourcesConsulted,
    }),
  };
}

/** Freeze the package through and through — it outlives the call that built it. */
function deepFreezePackage(pkg: ContextPackage): ContextPackage {
  for (const artifact of pkg.artifacts) Object.freeze(artifact);
  for (const omission of pkg.omissions) Object.freeze(omission);
  Object.freeze(pkg.artifacts);
  Object.freeze(pkg.omissions);
  Object.freeze(pkg.sourcesConsulted);
  Object.freeze(pkg.budget);
  return Object.freeze(pkg);
}
