/**
 * ikbi v2 — THE CANONICAL MODEL INVOCATION AUTHORITY.
 *
 * SELECTION AND INVOCATION ARE DIFFERENT AUTHORITIES.
 *
 *   `resolveModelRoute` answers  "which route is authorized?"
 *   `invokeAuthorized`  answers  "did we invoke exactly that route, and what actually
 *                                 served the request?"
 *
 * This component receives a COMPLETE decision and does not get to reconsider it. It has
 * no access to the inventory, the policy, the profile, the environment or the resolver;
 * it cannot walk a fallback chain, cannot escalate, and cannot try a second route. It
 * sends `decision.providerId` / `decision.providerModelId`, once — or it fails.
 *
 * THE CHAIN IT EXISTS TO KEEP HONEST:
 *
 *   requested preference → authorized decision → what was SENT on the wire
 *     → what the provider says actually SERVED it → the receipt
 *
 * Each link is recorded separately, because they are separate facts. In particular the
 * SERVED identity is only ever read from the provider's own response: when a provider
 * does not report one, the record says `not_reported` rather than echoing back what we
 * sent and calling that attribution.
 *
 * NO APPLICATION RETRY. One authorized route, one outbound attempt. A transient failure
 * becomes a structured failure and the run ends; retry, fallback and escalation belong
 * to a recovery controller that does not exist yet, and inventing one here would put a
 * second selection authority inside the invocation path.
 */

import { contentDigest, type V2DecisionDigest, type V2InvocationId, type V2PromptDigest, type V2RunId, type V2TaskId } from "./identity.js";
import { runFailure, type RunFailure } from "./failure.js";
import type { ContextPackage } from "./context.js";
import type { BuilderToolCall, BuilderToolDefinition } from "./tools.js";
import type { ModelResolutionDecision } from "./resolver.js";
import type { V2ModelRole } from "./config.js";
import { type RenderedModelInput } from "./prompt.js";

// ---------------------------------------------------------------------------
// Served identity
// ---------------------------------------------------------------------------

/**
 * How the provider-reported identity relates to what we sent.
 *
 *   match         the provider reported exactly the id we sent.
 *   aliased_match the provider reported a DIFFERENT id that a DECLARED alias relation
 *                 says is the same model. Declared, never inferred.
 *   not_reported  the provider reported nothing. An absence of evidence — recorded as
 *                 such, never filled in from the request.
 *   mismatch      the provider reported something else. An identity failure.
 */
export type ServedIdentityStatus = "match" | "aliased_match" | "not_reported" | "mismatch";

/**
 * A DECLARED alias relation: sending `sent` may legitimately be answered by `served`.
 *
 * Declarative on purpose. There is no pattern matching, no prefix rule and no
 * "looks close enough" — a dated-snapshot id that nobody has declared is a MISMATCH
 * until someone observes the relation and writes it down here, with the provider it was
 * observed on. That is the only way this stays evidence rather than optimism.
 */
export interface ServedModelAlias {
  readonly providerId: string;
  readonly sent: string;
  readonly served: string;
  /** Where the relation was observed. Recorded so it can be re-checked, not trusted forever. */
  readonly note: string;
}

/**
 * THE declarative served-model alias catalog (V2-016). ONE owner, provider-specific, exact.
 *
 * Each entry says: for this provider, sending `authorizedProviderModelId` may legitimately be
 * answered by any id in `allowedServedModelIds` — and NOTHING else. There is no regex, no prefix
 * rule, no version-stripping, no cross-provider matching. An undeclared difference is a MISMATCH.
 */
export interface ServedModelAliasCatalog {
  readonly provider: string;
  readonly authorizedProviderModelId: string;
  readonly allowedServedModelIds: readonly string[];
}

/**
 * The shipped alias catalog. Entries are the providers' OWN documented dated-snapshot ids for a
 * floating alias — the relation a real provider response shows (`gpt-4o` served as its current
 * dated snapshot). Exact and provider-scoped: `gpt-4o` is NOT `gpt-4o-mini`, and an OpenAI alias
 * never authorizes an Anthropic served id. Add an entry only when the provider documents/serves it.
 */
export const V2_SERVED_ALIAS_TABLE: readonly ServedModelAliasCatalog[] = Object.freeze([
  {
    provider: "openai",
    authorizedProviderModelId: "gpt-4o",
    // OpenAI's floating `gpt-4o` resolves to a dated snapshot; these are the published ones.
    allowedServedModelIds: ["gpt-4o-2024-08-06", "gpt-4o-2024-11-20", "gpt-4o-2024-05-13"],
  },
  {
    provider: "anthropic",
    authorizedProviderModelId: "claude-sonnet-4-5",
    allowedServedModelIds: ["claude-sonnet-4-5-20250929"],
  },
]);

/** Expand the catalog into the flat, per-relation table `classifyServedIdentity` consumes. */
export function expandAliasCatalog(catalog: readonly ServedModelAliasCatalog[]): readonly ServedModelAlias[] {
  const out: ServedModelAlias[] = [];
  for (const entry of catalog) {
    for (const served of entry.allowedServedModelIds) {
      out.push({ providerId: entry.provider, sent: entry.authorizedProviderModelId, served, note: `declared provider snapshot alias for ${entry.provider}/${entry.authorizedProviderModelId}` });
    }
  }
  return Object.freeze(out);
}

/** The production alias table, expanded from the shipped catalog and frozen for the process. */
export const V2_SERVED_MODEL_ALIASES: readonly ServedModelAlias[] = expandAliasCatalog(V2_SERVED_ALIAS_TABLE);

/**
 * Content address of an alias catalog — so a BuildSession can FREEZE it alongside the runtime
 * policy and pricing catalog and prove a later attempt saw the same alias set.
 */
export function servedAliasCatalogId(catalog: readonly ServedModelAliasCatalog[]): string {
  return contentDigest("served_alias_catalog", {
    entries: [...catalog]
      .map((e) => ({ provider: e.provider, authorizedProviderModelId: e.authorizedProviderModelId, allowedServedModelIds: [...e.allowedServedModelIds].sort() }))
      .sort((a, b) => `${a.provider} ${a.authorizedProviderModelId}`.localeCompare(`${b.provider} ${b.authorizedProviderModelId}`)),
  }) as string;
}

/** Classify the provider's reported identity against what was sent. */
export function classifyServedIdentity(
  sentProviderId: string,
  sentProviderModelId: string,
  servedModelId: string | undefined,
  aliases: readonly ServedModelAlias[],
): ServedIdentityStatus {
  if (servedModelId === undefined || servedModelId.length === 0) return "not_reported";
  if (servedModelId === sentProviderModelId) return "match";
  const declared = aliases.some(
    (a) => a.providerId === sentProviderId && a.sent === sentProviderModelId && a.served === servedModelId,
  );
  return declared ? "aliased_match" : "mismatch";
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** The parameters this slice authorizes. Deliberately tiny — no parameter framework yet. */
export interface V2InvocationParameters {
  /** Hard cap on completion tokens. Bounded by the resolved model's reserved budget. */
  readonly maxOutputTokens: number;
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs: number;
}

/**
 * One immutable invocation request. It binds every identity the record will have to
 * account for, and carries no credential — the transport looks its own up.
 */
export interface V2InvocationRequest {
  readonly invocationId: V2InvocationId;
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly role: V2ModelRole;
  readonly resolutionDecisionId: V2DecisionDigest;
  /** The authorized input id — a context package (builder) or review package (critic). */
  readonly contextPackageId: string;
  /** The LOGICAL model the policy preferred and the resolver authorized. */
  readonly authorizedModelId: string;
  readonly authorizedProviderId: string;
  readonly authorizedProviderModelId: string;
  /** Exactly what goes on the wire. Equal to the authorized values, or this is a defect. */
  readonly sentProviderId: string;
  readonly sentProviderModelId: string;
  readonly promptId: V2PromptDigest;
  readonly parameters: V2InvocationParameters;
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/** Token facts a provider reported. Only fields actually observed are present. */
export interface ObservedUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly cachedPromptTokens?: number;
  readonly reasoningTokens?: number;
}

/** What a transport gives back. Deliberately close to the wire — no interpretation. */
export interface TransportResponse {
  readonly content: string;
  readonly finishReason: string;
  /**
   * Tool calls the model emitted, verbatim and provider-NATIVE.
   *
   * v2 does not parse tool intent out of prose. If a model cannot emit structured calls,
   * that is a capability fact about the route, not a reason to invent a second, weaker
   * protocol out of markdown — which is exactly how a "tool call" the model never made
   * gets executed.
   */
  readonly toolCalls?: readonly BuilderToolCall[];
  /** Verbatim from the response body, or absent when the provider reported none. */
  readonly servedModelId?: string;
  /**
   * What an ATTESTING provider proved, as distinct from what it claimed. Absent for every
   * provider that cannot attest — which is every remote API.
   */
  readonly attestedIdentity?: AttestedLocalIdentity;
  /** Present when the result may not be acted on unattended. See `SupervisionMark`. */
  readonly supervision?: SupervisionMark;
  readonly usage?: ObservedUsage;
  /** How many outbound HTTP attempts the transport actually made. Must be 1 in this slice. */
  readonly attempts: number;
}

/**
 * What an ATTESTING provider proved about the artifact that served a request.
 *
 * `servedModelId` is a NAME the runtime chose to report; this is a claim that can be checked
 * against a catalog. The two are recorded side by side, never merged, because a disagreement
 * between them is the single most informative thing a receipt can preserve about a local run.
 *
 * Structural and provider-agnostic on purpose: `core/` describes what evidence looks like and
 * never learns which deployment produced it.
 */
export interface AttestedLocalIdentity {
  readonly modelId: string;
  readonly artifactDigest: string;
  /** False means the deployment could not confirm what it was serving. Never defaulted to true. */
  readonly attested: boolean;
  /** Verbatim. `UNKNOWN` when the deployment said nothing — never a friendlier guess. */
  readonly qualificationStatus: string;
  readonly qualificationAuthority: string;
  readonly quantization?: string;
  readonly servedContextTokens?: number;
  readonly runtimeBuild?: string;
  readonly backendInstanceId?: string;
  readonly attestationMethod?: string;
  readonly requestId?: string;
}

/**
 * The mark a result carries when it came from a worker nobody has vouched for.
 *
 * Such a result is USEFUL — an operator can read it and judge it. What it is not is trustworthy
 * enough to act on unattended, and recording that as DATA on the record is what keeps the
 * distinction from depending on somebody downstream remembering it.
 */
export interface SupervisionMark {
  readonly executionClass: "local";
  readonly qualified: boolean;
  readonly humanReviewRequired: boolean;
  readonly autonomousPromotionAllowed: boolean;
  readonly reason: string;
}

/** A transport failure, already classified by the donor provider layer. */
export interface TransportFailure {
  readonly code: string;
  readonly message: string;
  readonly providerId: string;
  readonly status?: number;
  readonly attempts: number;
}

export type TransportOutcome =
  | { readonly ok: true; readonly response: TransportResponse }
  | { readonly ok: false; readonly failure: TransportFailure };

/**
 * The narrow transport seam. It is handed one provider id and one wire model id and it
 * calls that endpoint. It is given no registry, no route list and no way to choose.
 */
export interface InvocationTransport {
  send(input: {
    readonly providerId: string;
    readonly providerModelId: string;
    readonly messages: RenderedModelInput["messages"];
    readonly parameters: V2InvocationParameters;
    /** Tools the model may call this turn. Absent when the caller offers none. */
    readonly tools?: readonly BuilderToolDefinition[];
  }): Promise<TransportOutcome>;
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

/** The four identities, kept apart because they are four different facts. */
export interface InvocationIdentityRecord {
  /** The role whose preference started this. */
  readonly requestedRole: V2ModelRole;
  /** The logical model the policy preferred. */
  readonly requestedModelId: string;
  readonly authorizedModelId: string;
  readonly authorizedProviderId: string;
  readonly authorizedProviderModelId: string;
  readonly sentProviderId: string;
  readonly sentProviderModelId: string;
  /** Verbatim provider report, or absent. NEVER synthesized. */
  readonly servedModelId?: string;
  /** What an attesting provider PROVED, kept apart from what it claimed above. */
  readonly attestedIdentity?: AttestedLocalIdentity;
  /** Present when this answer may not be acted on unattended. */
  readonly supervision?: SupervisionMark;
  readonly identityStatus: ServedIdentityStatus;
}

/** The durable account of one actual invocation. */
export interface V2InvocationRecord {
  readonly invocationId: V2InvocationId;
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly resolutionDecisionId: V2DecisionDigest;
  /** The authorized input id — a context package (builder) or review package (critic). */
  readonly contextPackageId: string;
  readonly promptId: V2PromptDigest;
  readonly identity: InvocationIdentityRecord;
  readonly parameters: V2InvocationParameters;
  /** Outbound HTTP attempts actually made. One, in this slice. */
  readonly attempts: number;
  readonly finishReason: string;
  readonly responseCharacters: number;
  /** Only fields the provider actually reported. Never estimated and labelled observed. */
  readonly usage?: ObservedUsage;
  /**
   * What ikbi ESTIMATED this request's input at, before sending it.
   *
   * Recorded beside the observed usage so the two can be compared — which is the only
   * way an estimator ever gets calibrated. It is evidence, not a control input: nothing
   * reads it back during the run, and the estimator is frozen for the session.
   */
  readonly estimatedInputTokens?: number;
  readonly startedAt: number;
  readonly endedAt: number;
}

export type InvocationResult =
  | {
      readonly ok: true;
      readonly record: V2InvocationRecord;
      readonly content: string;
      /** Provider-native tool calls, verbatim. Empty when the model called nothing. */
      readonly toolCalls: readonly BuilderToolCall[];
    }
  | { readonly ok: false; readonly failure: RunFailure; readonly attempted: boolean };

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export const V2_INVOCATION_FAILURE_CODES = {
  bindingMismatch: "invocation.binding_mismatch",
  providerNotAvailable: "invocation.provider_not_available",
  credentialMissing: "invocation.credential_missing",
  transportTimeout: "invocation.transport_timeout",
  transportFailure: "invocation.transport_failure",
  providerRejected: "invocation.provider_rejected_request",
  rateLimited: "invocation.provider_rate_limited",
  malformedResponse: "invocation.malformed_provider_response",
  servedIdentityMismatch: "invocation.served_identity_mismatch",
  unsupportedProtocol: "invocation.unsupported_provider_protocol",
  unexpectedRetry: "invocation.unexpected_transport_retry",
  internal: "invocation.internal_error",
} as const;

function invocationFailure(code: string, message: string, detail?: Readonly<Record<string, string | number | boolean>>): RunFailure {
  return runFailure({
    category: "provider",
    code,
    message,
    stage: "candidate_generation",
    retryable: false,
    ...(detail !== undefined ? { detail } : {}),
  });
}

// ---------------------------------------------------------------------------
// The authority
// ---------------------------------------------------------------------------

/**
 * The four facts the invocation authority binds against, for a caller that has an
 * authorized immutable input which is NOT a context package (the critic's review package).
 * It carries exactly what the authority checks — nothing it could use to compose input.
 */
export interface AuthorizedInputBinding {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly resolutionDecisionId: V2DecisionDigest;
  /** The id of the authorized input (e.g. the review package id). Stored on the record. */
  readonly inputId: string;
}

export interface InvocationAuthorityInput {
  readonly runId: V2RunId;
  readonly taskId: V2TaskId;
  readonly invocationId: V2InvocationId;
  readonly decision: ModelResolutionDecision;
  /**
   * The AUTHORIZED input this call was built from — the builder's context package, or any
   * other content-addressed immutable input (the critic's review package). Exactly one of
   * `contextPackage` / `binding` is supplied; both carry the same four facts the authority
   * binds against, and the record stores the input's id either way.
   */
  readonly contextPackage?: ContextPackage;
  readonly binding?: AuthorizedInputBinding;
  /**
   * EXACTLY what goes on the wire, rendered by the caller.
   *
   * The authority does not build this. It checks that the caller assembled a coherent run
   * and then sends what it was handed — which is why a builder can take many turns
   * without this file learning anything about builders.
   */
  readonly rendered: RenderedModelInput;
  /** Tools the model may call this turn. */
  readonly tools?: readonly BuilderToolDefinition[];
  readonly parameters: V2InvocationParameters;
  readonly transport: InvocationTransport;
  readonly aliases?: readonly ServedModelAlias[];
  readonly now?: () => number;
  /**
   * The caller's pre-send estimate of this request's input tokens, when it has one.
   * Carried onto the record for estimate-vs-observed calibration evidence.
   */
  readonly estimatedInputTokens?: number;
}

/**
 * INVOKE EXACTLY THE AUTHORIZED ROUTE.
 *
 * Binding is checked BEFORE anything leaves the process: a context package built for a
 * different run, or sized by a different decision, is refused rather than repaired.
 * Repair would mean re-assembling context inside the invocation path — a second context
 * authority, and the thing V2-004 exists to prevent.
 */
export async function invokeAuthorized(input: InvocationAuthorityInput): Promise<InvocationResult> {
  const now = input.now ?? Date.now;
  const { decision } = input;

  // The one authorized input this call binds against — a context package OR a raw binding.
  // Exactly one must be supplied.
  const bound =
    input.contextPackage !== undefined
      ? { runId: input.contextPackage.runId, taskId: input.contextPackage.taskId, resolutionDecisionId: input.contextPackage.resolutionDecisionId, inputId: input.contextPackage.packageId as string }
      : input.binding;
  if (bound === undefined) {
    return {
      ok: false,
      attempted: false,
      failure: invocationFailure(V2_INVOCATION_FAILURE_CODES.bindingMismatch, "refusing to invoke: no authorized input (context package or binding) was supplied", {
        decisionId: decision.decisionId,
      }),
    };
  }

  // 1. BINDING. Every mismatch here means the caller assembled an inconsistent run.
  const bindingProblem =
    bound.runId !== input.runId
      ? `the authorized input belongs to run ${bound.runId}, not ${input.runId}`
      : bound.taskId !== input.taskId
        ? `the authorized input belongs to task ${bound.taskId}, not ${input.taskId}`
        : decision.runId !== input.runId
          ? `the resolution decision belongs to run ${decision.runId}, not ${input.runId}`
          : bound.resolutionDecisionId !== decision.decisionId
            ? `the authorized input was sized by decision ${bound.resolutionDecisionId}, not by the authorized ${decision.decisionId}`
            : undefined;
  if (bindingProblem !== undefined) {
    return {
      ok: false,
      attempted: false,
      failure: invocationFailure(V2_INVOCATION_FAILURE_CODES.bindingMismatch, `refusing to invoke: ${bindingProblem}`, {
        contextPackageId: bound.inputId,
        decisionId: decision.decisionId,
      }),
    };
  }

  // 2. The caller rendered the input from the authorized package. This authority sends
  // it; it does not compose it, and it has no way to add anything to it.
  const rendered = input.rendered;

  const request: V2InvocationRequest = {
    invocationId: input.invocationId,
    runId: input.runId,
    taskId: input.taskId,
    role: decision.role,
    resolutionDecisionId: decision.decisionId,
    contextPackageId: bound.inputId,
    authorizedModelId: decision.modelId,
    authorizedProviderId: decision.providerId,
    authorizedProviderModelId: decision.providerModelId,
    // SENT is copied from AUTHORIZED and from nowhere else. There is no code path in
    // which these can differ; the record still states both, because a future transport
    // that rewrote an id would otherwise be invisible.
    sentProviderId: decision.providerId,
    sentProviderModelId: decision.providerModelId,
    promptId: rendered.promptId,
    parameters: input.parameters,
  };

  // 3. SEND. Once.
  const startedAt = now();
  const outcome = await input.transport.send({
    providerId: request.sentProviderId,
    providerModelId: request.sentProviderModelId,
    messages: rendered.messages,
    parameters: input.parameters,
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
  });
  const endedAt = now();

  if (!outcome.ok) {
    return {
      ok: false,
      // A transport that reached the wire has attempted an invocation even though it
      // failed; one that could not (no such provider, no credential) has not. The
      // receipt's `providerInvoked` follows this, so intention is never counted as a call.
      attempted: outcome.failure.attempts > 0,
      failure: invocationFailure(outcome.failure.code, outcome.failure.message, {
        provider: outcome.failure.providerId,
        attempts: outcome.failure.attempts,
        ...(outcome.failure.status !== undefined ? { status: outcome.failure.status } : {}),
      }),
    };
  }

  const response = outcome.response;

  // 4. NO HIDDEN RETRY. If a donor transport ever grows an internal retry, this turns it
  // into a loud failure rather than a silently multiplied call.
  if (response.attempts !== 1) {
    return {
      ok: false,
      attempted: true,
      failure: invocationFailure(
        V2_INVOCATION_FAILURE_CODES.unexpectedRetry,
        `the transport made ${response.attempts} outbound attempts; this slice authorizes exactly one`,
        { attempts: response.attempts },
      ),
    };
  }

  // 5. SERVED IDENTITY.
  const identityStatus = classifyServedIdentity(
    request.sentProviderId,
    request.sentProviderModelId,
    response.servedModelId,
    input.aliases ?? V2_SERVED_MODEL_ALIASES,
  );
  const identity: InvocationIdentityRecord = {
    requestedRole: decision.role,
    requestedModelId: decision.modelId,
    authorizedModelId: request.authorizedModelId,
    authorizedProviderId: request.authorizedProviderId,
    authorizedProviderModelId: request.authorizedProviderModelId,
    sentProviderId: request.sentProviderId,
    sentProviderModelId: request.sentProviderModelId,
    ...(response.servedModelId !== undefined ? { servedModelId: response.servedModelId } : {}),
    ...(response.attestedIdentity !== undefined ? { attestedIdentity: response.attestedIdentity } : {}),
    ...(response.supervision !== undefined ? { supervision: response.supervision } : {}),
    identityStatus,
  };

  if (identityStatus === "mismatch") {
    // An identity failure, not a parsing problem. The detail preserves all three facts
    // so the operator can see precisely what disagreed with what.
    return {
      ok: false,
      attempted: true,
      failure: invocationFailure(
        V2_INVOCATION_FAILURE_CODES.servedIdentityMismatch,
        `provider "${request.sentProviderId}" reports serving "${String(response.servedModelId)}" but was sent "${request.sentProviderModelId}" (authorized model "${request.authorizedModelId}")`,
        {
          authorizedModelId: request.authorizedModelId,
          sentProviderModelId: request.sentProviderModelId,
          servedModelId: String(response.servedModelId),
        },
      ),
    };
  }

  return {
    ok: true,
    content: response.content,
    toolCalls: response.toolCalls ?? [],
    record: Object.freeze({
      invocationId: input.invocationId,
      runId: input.runId,
      taskId: input.taskId,
      resolutionDecisionId: decision.decisionId,
      contextPackageId: bound.inputId,
      promptId: rendered.promptId,
      identity: Object.freeze(identity),
      parameters: Object.freeze(input.parameters),
      attempts: response.attempts,
      finishReason: response.finishReason,
      responseCharacters: response.content.length,
      ...(response.usage !== undefined ? { usage: Object.freeze(response.usage) } : {}),
      ...(input.estimatedInputTokens !== undefined ? { estimatedInputTokens: input.estimatedInputTokens } : {}),
      startedAt,
      endedAt,
    }),
  };
}

/**
 * Content address of an invocation's SEMANTIC inputs — what was authorized, what was
 * sent, and exactly what prompt. Timings, ids minted per attempt and the response are
 * excluded: two runs that sent the same thing to the same route have the same request
 * identity even though they are different invocations.
 */
export function invocationRequestDigest(request: V2InvocationRequest): string {
  return contentDigest("invocation", {
    resolutionDecisionId: request.resolutionDecisionId,
    contextPackageId: request.contextPackageId,
    promptId: request.promptId,
    role: request.role,
    authorizedModelId: request.authorizedModelId,
    sentProviderId: request.sentProviderId,
    sentProviderModelId: request.sentProviderModelId,
    parameters: request.parameters,
  });
}
