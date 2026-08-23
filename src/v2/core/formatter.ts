/**
 * ikbi v2 — THE GOVERNED FORMATTER CAPABILITY.
 *
 * WHY THIS EXISTS, precisely. Two preserved Apela runs withheld publication correctly, and the
 * root cause was not the model. The repository's verification declared a `fmt` check; the check
 * ran `cargo fmt --check` through the verifier and failed; and the builder had NO WAY to satisfy
 * it. `cargo` is absent from the read-only command allowlist, the candidate is bound read-only to
 * builder commands, and a command that changed the tree would be a hard safety failure. The
 * toolchain was installed on the box and structurally unreachable by the model, whose only
 * remaining option was to hand-emit byte-exact rustfmt output. Swapping models cannot repair a
 * missing capability.
 *
 * SO THE CAPABILITY IS ADDED — AS NARROWLY AS IT CAN POSSIBLY BE ADDED.
 *
 * The model may name a formatter IDENTIFIER. That is the whole of its input. It may not supply an
 * executable, argv, a working directory, an environment, shell text, a network policy, a timeout,
 * an output path, or one extra flag. Everything else is owned by the definition below, which is a
 * constant in this file. There is no string from the model anywhere in the command that runs.
 *
 * THE CANDIDATE IS NEVER THE FORMATTER'S SUBJECT. This is the part that matters most. `cargo fmt`
 * rewrites files in place, and giving a subprocess write access to the candidate would hand it
 * exactly the authority the state-bound mutation core exists to deny — every other write in the
 * system is observe → compare-and-swap → atomic write, and one exception would make that invariant
 * a convention. So the formatter runs against an ISOLATED SHADOW COPY. Afterwards the shadow is
 * diffed, the changed paths are checked against the operator's mutation scope, and the accepted
 * bytes are applied to the candidate through the SAME state-bound authority as any other edit.
 *
 * The consequences are worth stating, because they are the point:
 *
 *   - a timeout, a cancellation, a crash or a non-zero exit mutates NOTHING. The candidate is not
 *     touched until the shadow run has completed and been adjudicated, so there is no partial
 *     application to unwind and no window in which the candidate is half-formatted.
 *   - a formatter that changes a path outside the mutation scope is REJECTED WHOLE. Not filtered
 *     down to the in-scope subset: applying part of a formatting pass would leave the candidate in
 *     a state the formatter never produced and nothing verified.
 *   - the evidence survives the failure. A rejected or timed-out invocation still produces a
 *     record naming what ran, what it did, and why it was refused.
 *
 * This file is PURE — definitions, bounds, identity, records and refusal vocabulary. It spawns
 * nothing and reads no filesystem; `runtime/formatter-runner.ts` holds the capability.
 */

import { createHash } from "node:crypto";

import { contentDigest, type V2Digest, type V2RunId, type V2WorkspaceId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { MutationOperationKind, V2MutationScopeId } from "./mutation-scope.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// The closed formatter set
// ---------------------------------------------------------------------------

/**
 * Every formatter the builder may name. A CLOSED set — an identifier outside it is refused, and
 * adding one is a deliberate, reviewable edit to this file rather than a configuration surface
 * that could grow an arbitrary command.
 */
export const FORMATTER_IDS = ["rustfmt_workspace_v1"] as const;
export type FormatterId = (typeof FORMATTER_IDS)[number];

export function isFormatterId(s: string): s is FormatterId {
  return (FORMATTER_IDS as readonly string[]).includes(s);
}

/**
 * Everything about how a formatter runs. The model contributes NOTHING to this — it is reached
 * by identifier lookup, and every field is a constant.
 */
export interface FormatterDefinition {
  readonly formatterId: FormatterId;
  /** A bare program name. Never a path, and never model-supplied. */
  readonly program: string;
  /** The COMPLETE argument vector. Fixed. No flag is appended at any call site. */
  readonly argv: readonly string[];
  /** The fixed argv used to observe the tool's version before formatting. */
  readonly versionArgv: readonly string[];
  /** Repository-root-relative markers that must exist for this formatter to apply. */
  readonly requires: readonly string[];
  /** Exit codes that mean "the formatter did its job". Anything else is a failed invocation. */
  readonly permittedExitCodes: readonly number[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Only `deny` exists. A formatter has no business on the network. */
  readonly network: "deny";
  /** Human sentence for prompts and refusals. */
  readonly description: string;
}

/**
 * rustfmt over a cargo workspace — canonical `cargo fmt --all`.
 *
 * `--all` matches what a workspace's own `fmt` check almost always verifies (`cargo fmt --all
 * --check`); formatting a subset and then failing the workspace check would be the worst of both.
 * The scope gate, not the argv, is what keeps the change small: whatever `--all` rewrites, only
 * paths the operator authorized can ever reach the candidate.
 */
export const RUSTFMT_WORKSPACE_V1: FormatterDefinition = Object.freeze({
  formatterId: "rustfmt_workspace_v1",
  program: "cargo",
  argv: Object.freeze(["fmt", "--all"]),
  versionArgv: Object.freeze(["fmt", "--version"]),
  requires: Object.freeze(["Cargo.toml"]),
  // rustfmt exits 0 on success. A non-zero exit means it could not format — a parse error in the
  // source, a missing component — and is a failed invocation, never a silent no-op.
  permittedExitCodes: Object.freeze([0]),
  timeoutMs: 120_000,
  maxOutputBytes: 32_000,
  network: "deny",
  description: "rustfmt over the whole cargo workspace (cargo fmt --all)",
});

const DEFINITIONS: Readonly<Record<FormatterId, FormatterDefinition>> = Object.freeze({
  rustfmt_workspace_v1: RUSTFMT_WORKSPACE_V1,
});

/** Look up a definition by identifier. The ONLY way to obtain one. */
export function formatterDefinition(id: FormatterId): FormatterDefinition {
  return DEFINITIONS[id];
}

/**
 * Where the formatter's environment comes from — a declaration, not a mechanism.
 *
 * The process environment is built by governed-exec's `scrubbedEnv`, which is an ALLOWLIST
 * (PATH, HOME, LANG, plus whatever the operator explicitly allowlisted) rather than the host
 * environment minus a denylist. That is the sanitization requirement, and it is deliberately NOT
 * reimplemented here.
 *
 * The reason to reuse it rather than build a second one is stronger than avoiding duplication:
 * the VERIFIER runs `cargo fmt --check` through the very same allowlist. A formatter with its own
 * environment could resolve a different toolchain, or a different rustfmt edition, and produce
 * output that the check then rejects — a formatter that disagrees with the check that judges it is
 * worse than no formatter at all. One environment, one answer.
 *
 * governed-exec additionally redirects `CARGO_HOME` into the sandbox's writable base, so cargo has
 * somewhere to work without a writable host HOME.
 */
export const FORMATTER_ENVIRONMENT_SOURCE = "governed_exec_allowlist" as const;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export type V2FormatterInvocationId = V2Digest<"formatter_invocation">;

/**
 * The identity of ONE formatter invocation.
 *
 * Binds the task/run, the candidate workspace, the exact source it started from, the authorized
 * mutation scope, the formatter and its observed version, and the ordinal. The clock and the
 * absolute shadow path are provenance and stay out — two invocations of the same formatter over
 * the same state under the same authority ARE the same invocation.
 */
export function formatterInvocationDigest(input: {
  readonly runId: V2RunId;
  readonly ordinal: number;
  readonly formatterId: FormatterId;
  readonly formatterVersion: string;
  readonly workspaceId: V2WorkspaceId;
  readonly baseCommit: string;
  readonly mutationScopeId: V2MutationScopeId;
  readonly treeBefore: string;
}): V2FormatterInvocationId {
  return contentDigest("formatter_invocation", {
    runId: input.runId,
    ordinal: input.ordinal,
    formatterId: input.formatterId,
    formatterVersion: input.formatterVersion,
    workspaceId: input.workspaceId,
    baseCommit: input.baseCommit,
    mutationScopeId: input.mutationScopeId,
    treeBefore: input.treeBefore,
  });
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** What was learned about the binary that actually ran. */
export interface FormatterExecutableIdentity {
  /** The resolved absolute path, after symlinks. */
  readonly resolvedPath: string;
  /** SHA-256 of the executable's bytes, when it could be read. */
  readonly sha256?: string;
  readonly byteLength?: number;
  /** The tool's self-reported version, from the fixed version argv. */
  readonly version: string;
}

/** One path the formatter changed in the shadow, and how. */
export interface FormatterChange {
  readonly path: string;
  readonly operation: MutationOperationKind;
  readonly beforeSha256: string | null;
  readonly afterSha256: string | null;
  /** True once the bytes were applied to the candidate through the state-bound authority. */
  readonly applied: boolean;
}

/**
 * How a formatter invocation ended. Every one of these produces a record — the evidence is not a
 * reward for succeeding.
 */
export type FormatterOutcomeKind =
  | "applied"
  | "already_clean"
  | "refused_out_of_scope"
  | "refused_unavailable"
  | "failed_exit"
  | "timed_out"
  | "cancelled"
  | "infrastructure_failure";

/**
 * THE immutable account of one formatter invocation.
 *
 * It never carries an absolute candidate or shadow path, a credential, or a full output stream.
 */
export interface FormatterRecord {
  readonly invocationId: V2FormatterInvocationId;
  readonly runId: string;
  readonly ordinal: number;
  readonly formatterId: FormatterId;
  readonly executable: FormatterExecutableIdentity;
  /** The fixed argv, recorded so the receipt proves nothing was appended. */
  readonly argv: readonly string[];
  readonly workspaceId: string;
  /** The commit the candidate was cut from — what the formatting is relative to. */
  readonly baseCommit: string;
  readonly mutationScopeId: string;
  readonly network: "deny";
  readonly timeoutMs: number;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly outcome: FormatterOutcomeKind;
  /** Absent when the process never launched. */
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdoutSha256: string;
  readonly stdoutExcerpt: string;
  readonly stderrSha256: string;
  readonly stderrExcerpt: string;
  readonly outputTruncated: boolean;
  /** The CANDIDATE tree before and after. Equal for every outcome except `applied`. */
  readonly candidateTreeBefore: string;
  readonly candidateTreeAfter: string;
  /** Exactly what the formatter changed in the shadow, in path order. */
  readonly changes: readonly FormatterChange[];
  /** Why the scope permitted or refused this set of changes. */
  readonly scopeDecision: FormatterScopeDecision;
}

/** The scope's verdict over the whole change set. Whole-set, because application is all-or-nothing. */
export interface FormatterScopeDecision {
  readonly permitted: boolean;
  readonly inScope: readonly string[];
  readonly outOfScope: readonly { readonly path: string; readonly operation: MutationOperationKind; readonly detail: string }[];
}

/** Bound one output stream: hash the whole thing, keep a bounded tail. */
export interface BoundedStream {
  readonly excerpt: string;
  readonly sha256: string;
  readonly truncated: boolean;
}

export function boundStream(full: string, maxBytes: number): BoundedStream {
  const digest = sha256(full);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return { excerpt: full, sha256: digest, truncated: false };
  const buf = Buffer.from(full, "utf8");
  return { excerpt: buf.subarray(buf.length - maxBytes).toString("utf8"), sha256: digest, truncated: true };
}

// ---------------------------------------------------------------------------
// The model-facing outcome
// ---------------------------------------------------------------------------

/** What the model is told. Ids and counts and a bounded excerpt — never a path outside its own. */
export interface FormatterToolOutcome {
  readonly kind: "formatted";
  readonly formatterId: string;
  readonly outcome: FormatterOutcomeKind;
  readonly changedPaths: readonly string[];
  readonly refusedPaths: readonly string[];
  readonly exitCode?: number;
  readonly timedOut: boolean;
  /** The tool's own output, bounded. UNTRUSTED — it is tool output, and crosses the fence. */
  readonly untrusted: string;
}

/** A one-line, honest summary of what happened, for the model's next turn. */
export function describeFormatterOutcome(record: FormatterRecord): string {
  switch (record.outcome) {
    case "applied":
      return `${record.formatterId} reformatted ${record.changes.length} file(s); the changes are now in your workspace.`;
    case "already_clean":
      return `${record.formatterId} ran and changed nothing — the workspace was already formatted.`;
    case "refused_out_of_scope":
      return (
        `${record.formatterId} would have changed ${record.scopeDecision.outOfScope.length} file(s) outside this build's ` +
        `mutation scope, so NOTHING was applied. Your workspace is unchanged. ` +
        `Out of scope: ${record.scopeDecision.outOfScope.slice(0, 5).map((o) => o.path).join(", ")}.`
      );
    case "refused_unavailable":
      return `${record.formatterId} is not available for this repository — nothing ran and nothing changed.`;
    case "failed_exit":
      return `${record.formatterId} exited ${record.exitCode ?? "?"} and changed nothing. Read its output below; the source may not parse.`;
    case "timed_out":
      return `${record.formatterId} exceeded ${record.timeoutMs}ms and was killed. Nothing was applied — your workspace is untouched.`;
    case "cancelled":
      return `${record.formatterId} was cancelled. Nothing was applied — your workspace is untouched.`;
    case "infrastructure_failure":
      return `${record.formatterId} could not be run. Nothing was applied — your workspace is untouched.`;
  }
}

/** Build the model-facing outcome from the record. */
export function formatterToolOutcome(record: FormatterRecord): FormatterToolOutcome {
  const combined = [describeFormatterOutcome(record), record.stdoutExcerpt, record.stderrExcerpt]
    .filter((s) => s.length > 0)
    .join("\n");
  return {
    kind: "formatted",
    formatterId: record.formatterId,
    outcome: record.outcome,
    changedPaths: record.changes.filter((c) => c.applied).map((c) => c.path),
    refusedPaths: record.scopeDecision.outOfScope.map((o) => o.path),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    timedOut: record.timedOut,
    untrusted: combined,
  };
}

// ---------------------------------------------------------------------------
// Refusals and failures
// ---------------------------------------------------------------------------

/** Why a formatter REQUEST was refused before anything ran. Closed set. */
export type FormatterRefusalCode =
  | "unknown_formatter"
  | "formatter_unavailable"
  | "budget_exhausted"
  | "capability_unavailable";

export const V2_FORMATTER_FAILURE_CODES = {
  /**
   * The formatter's own changes were applied to the candidate and the resulting tree still
   * carries a path outside the scope. A contradiction between two layers that must agree —
   * never retryable, and the build stops.
   */
  appliedOutOfScope: "build.formatter_applied_out_of_scope",
  /** Applying the accepted bytes failed partway. The candidate may be inconsistent; stop. */
  partialApplication: "build.formatter_partial_application",
} as const;

/** The HARD failure for an application that could not be completed. */
export function formatterPartialApplicationFailure(detail: {
  readonly formatterId: string;
  readonly appliedCount: number;
  readonly totalCount: number;
  readonly path: string;
  readonly reason: string;
}): RunFailure {
  return runFailure({
    category: "build",
    code: V2_FORMATTER_FAILURE_CODES.partialApplication,
    message:
      `"${detail.formatterId}" applied ${detail.appliedCount} of ${detail.totalCount} formatted file(s) and then failed on ` +
      `"${detail.path}" (${detail.reason}). The candidate may be partly formatted, so the build is stopped rather than ` +
      `verified in a state no formatter produced.`,
    stage: "candidate_generation",
    retryable: false,
    detail: { formatterId: detail.formatterId, applied: detail.appliedCount, total: detail.totalCount },
  });
}

// ---------------------------------------------------------------------------
// The capability seam
// ---------------------------------------------------------------------------

/** One formatter request handed to the capability. The model contributes `formatterId` alone. */
export interface FormatterRequest {
  readonly runId: V2RunId;
  readonly ordinal: number;
  readonly formatterId: FormatterId;
  readonly workspaceId: V2WorkspaceId;
  readonly workspacePath: string;
  readonly baseCommit: string;
}

export interface FormatterResult {
  readonly outcome: FormatterToolOutcome;
  /** Present whenever anything was attempted — including every failure. Evidence is not optional. */
  readonly record?: FormatterRecord;
  /** Present ONLY on a hard safety stop (a partial application). The builder MUST abort. */
  readonly safetyFailure?: RunFailure;
}

/**
 * THE formatter capability. Implemented in `runtime/formatter-runner.ts`, which holds the
 * governed executor, the shadow materializer and the state-bound mutation authority. Declared
 * here so the pure builder layer can wire it without importing any I/O.
 */
export interface FormatterCapability {
  run(request: FormatterRequest): Promise<FormatterResult>;
  /** Which formatters actually apply to this repository, so the model is offered no fiction. */
  available(workspacePath: string): Promise<readonly FormatterId[]>;
}

/** A summary of one formatter invocation, receipt-safe. */
export interface RunFormatterSummary {
  readonly invocationId: string;
  readonly formatterId: string;
  readonly version: string;
  readonly executablePath: string;
  readonly executableSha256?: string;
  readonly argv: readonly string[];
  readonly workspaceId: string;
  readonly mutationScopeId: string;
  readonly outcome: FormatterOutcomeKind;
  readonly exitCode?: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly candidateTreeBefore: string;
  readonly candidateTreeAfter: string;
  readonly changedPaths: readonly string[];
  readonly outOfScopePaths: readonly string[];
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
}

export function summarizeFormatter(record: FormatterRecord): RunFormatterSummary {
  return {
    invocationId: record.invocationId,
    formatterId: record.formatterId,
    version: record.executable.version,
    executablePath: record.executable.resolvedPath,
    ...(record.executable.sha256 !== undefined ? { executableSha256: record.executable.sha256 } : {}),
    argv: [...record.argv],
    workspaceId: record.workspaceId,
    mutationScopeId: record.mutationScopeId,
    outcome: record.outcome,
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    timedOut: record.timedOut,
    cancelled: record.cancelled,
    durationMs: Math.max(0, record.completedAt - record.startedAt),
    candidateTreeBefore: record.candidateTreeBefore,
    candidateTreeAfter: record.candidateTreeAfter,
    changedPaths: record.changes.filter((c) => c.applied).map((c) => c.path),
    outOfScopePaths: record.scopeDecision.outOfScope.map((o) => o.path),
    stdoutSha256: record.stdoutSha256,
    stderrSha256: record.stderrSha256,
  };
}
