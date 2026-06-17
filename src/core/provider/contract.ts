/**
 * ikbi provider layer — THE FROZEN CONTRACT (#1).
 *
 * Every model call in the entire engine routes through `invokeModel(request)`.
 * The request/response types defined here are versioned and are what every
 * module builds against. Treat them as frozen once verified: add new OPTIONAL
 * fields in a backward-compatible way, but do not change or remove existing
 * ones without bumping CONTRACT_VERSION and coordinating across modules.
 *
 * This file has zero internal imports on purpose — it is pure contract.
 */

/**
 * Semantic version of the request/response contract.
 *
 * 1.2.0 — additive: multimodal (vision) message content. `ModelMessage` gains an
 *         OPTIONAL `parts?: ContentPart[]` (text + image_url parts). `content`
 *         (string) is UNCHANGED and remains the canonical text — `parts`, when
 *         present, is what the provider serializes to the wire (OpenAI multimodal
 *         format), with `content` left as the flattened-text fallback. New OPTIONAL
 *         field → MINOR bump; modules that never set `parts` are unaffected.
 * 1.1.0 — additive: provider fetch-guard seam (registerFetchGuard/resolveFetchGuard,
 *         fail-closed). The network-egress floor (Step F) registers a guarded fetch;
 *         absent a guard, construction fails closed rather than using raw
 *         globalThis.fetch. New OPTIONAL seam → MINOR bump; modules pinning
 *         provider@1.0.x stay compatible.
 * 1.0.0 — frozen-core provider contract.
 */
export const CONTRACT_VERSION = "1.2.0";

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** Role of a message in a model conversation. */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * A single piece of multimodal message content (the OpenAI wire shape). A `text`
 * part carries prose; an `image_url` part carries an image as either a remote
 * https URL or a `data:<mime>;base64,<...>` data-URL. Used in `ModelMessage.parts`
 * to send a vision request; never required for text-only calls.
 */
export type ContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } };

/** A single conversation message. */
export interface ModelMessage {
  readonly role: MessageRole;
  readonly content: string;
  /**
   * ADDITIVE (1.2.0, backward-compatible): MULTIMODAL content. When present and
   * non-empty, the provider serializes THIS array to the wire (OpenAI multimodal
   * `content: [...]` format) INSTEAD of the `content` string; `content` then serves
   * as the flattened-text fallback (for logging, neutralization, and providers that
   * cannot accept images). Text-only callers leave it unset and nothing changes.
   * The injection chokepoint still neutralizes the `content` string — images carried
   * here are not free-text instruction channels.
   */
  readonly parts?: readonly ContentPart[];
  /**
   * For `role: "assistant"`, tool calls the model previously emitted. Carrying
   * them lets the full tool loop round-trip: assistant(tool_calls) -> tool
   * results -> assistant. Serialized back onto the wire by the provider.
   */
  readonly toolCalls?: readonly ToolCall[];
  /** For `role: "tool"`, the id of the tool call this message answers. */
  readonly toolCallId?: string;
  /** Optional name (e.g. the tool name for a tool message). */
  readonly name?: string;
  /**
   * ADDITIVE (Phase 2 coordination, backward-compatible): marks this message as
   * carrying neutralized UNTRUSTED content (the output of the injection
   * chokepoint). It is structural isolation metadata — untrusted content travels
   * as its own data-role message, never merged into a system/instruction
   * message. Optional; does not change wire serialization. Existing Phase 1
   * fields are unchanged. See `src/core/injection`.
   */
  readonly untrusted?: boolean;
}

/** A tool the model may call. Parameters are a JSON Schema object. For later tool-use. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** A tool call emitted by the model. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON argument string exactly as produced by the model. */
  readonly arguments: string;
}

/**
 * Identity of the agent making the request — the multi-tenancy SEAM.
 *
 * Defined now so every request carries it and every module builds against it.
 * It is fully populated and enforced in a later core phase (agent identity /
 * multi-tenancy); for Phase 1 the field simply exists and is logged.
 */
export interface AgentIdentity {
  /** Stable id of the calling agent (e.g. "peh", "builder-3", "operator"). */
  readonly agentId: string;
  /**
   * What the agent DOES — its job in the engine (e.g. "builder", "scout",
   * "critic", "verifier", "integrator", "operator"). Drives routing/behavior.
   * Distinct from how much it is trusted.
   */
  readonly functionalRole?: string;
  /**
   * How much the AGENT is TRUSTED — its governance tier (e.g. "probation",
   * "verified", "trusted", "operator"). Drives permissions/gating. Distinct from
   * what the agent does. This models AGENT trust ONLY — the trust ikbi places in
   * a model/provider is the shadow-workspace module's separate concern and must
   * NOT be overloaded onto this field. Established/validated by the identity layer
   * (Phase 3); the dynamic-trust phase adjusts it via a pluggable seam.
   */
  readonly trustTier?: string;
  /**
   * Canonical multi-turn correlation key: the opaque tenant/session id that ties
   * a sequence of related requests from the same caller together. Use this (not
   * ad-hoc keys) to correlate a conversation/operation across turns.
   */
  readonly sessionId?: string;
  /**
   * ADDITIVE (Phase 3 coordination, backward-compatible): when this identity is a
   * deterministically-spawned subagent, the agentId of the spawning parent. The
   * correlation + trust-inheritance hook for the (later) subagent-spawning module,
   * so spawned agents need not each be pre-registered. Set only through a trusted
   * spawn path, never from client claims. Existing fields are unchanged.
   */
  readonly spawnedFrom?: string;
}

/** The single request type for every model invocation. */
export interface ModelRequest {
  /** Contract version this request was built against. Defaults applied if omitted. */
  readonly contractVersion?: string;
  /** Logical model id from the roster (e.g. "mimo-v2.5"). Resolved via the registry. */
  readonly model: string;
  /** Conversation messages. Provide this or `prompt`. */
  readonly messages?: readonly ModelMessage[];
  /** Convenience single-prompt form; becomes a single user message. */
  readonly prompt?: string;
  /** Optional tools for tool-use (consumed in later phases). */
  readonly tools?: readonly ModelTool[];
  /** Sampling temperature. */
  readonly temperature?: number;
  /** Max completion tokens. */
  readonly maxTokens?: number;
  /** Identity of the calling agent — the multi-tenancy seam (required). */
  readonly identity: AgentIdentity;
  /** Per-request timeout override (ms). Falls back to config. */
  readonly timeoutMs?: number;
  /** Free-form correlation/tracing metadata. Never sent to the model. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

/** Token counts for an invocation. */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /**
   * Portion of `promptTokens` served from the provider's prompt cache (a subset
   * of prompt tokens, not additive). Charged at the cached rate. The cost-saving
   * pillar depends on this being accurate on cache hits.
   */
  readonly cachedTokens?: number;
}

/** The per-1M-token rates used to price an invocation (kept for receipts/audit). */
export interface CostRate {
  readonly promptPerMTok: number;
  readonly completionPerMTok: number;
  /** Rate for cached prompt tokens (typically cheaper). Falls back to promptPerMTok if absent. */
  readonly cachedPromptPerMTok?: number;
}

/** Computed cost of an invocation, in USD, with an auditable breakdown. */
export interface Cost {
  readonly usd: number;
  /** Cost of the non-cached prompt tokens. */
  readonly promptUsd: number;
  /** Cost of the cached prompt tokens (0 when no cache hit). */
  readonly cachedUsd: number;
  readonly completionUsd: number;
  readonly rate: CostRate;
}

/** Why the model stopped generating. */
export type FinishReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "content_filter"
  | "error"
  | "unknown";

/**
 * Outcome of a single provider attempt within the fallback chain.
 * - "error": a retriable failure (counts toward circuit health).
 * - "permanent_error": a non-retriable failure (auth/config/bad-response) — does
 *   NOT count toward circuit health; the provider is healthy, the request isn't.
 */
export type AttemptOutcome =
  | "success"
  | "error"
  | "permanent_error"
  | "timeout"
  | "skipped_open_circuit";

/** Record of one provider attempt — fallback is never silent; every attempt is here. */
export interface ProviderAttempt {
  readonly provider: string;
  readonly providerModelId: string;
  readonly outcome: AttemptOutcome;
  readonly latencyMs: number;
  /** Present when outcome is "error", "permanent_error", or "timeout". */
  readonly error?: string;
  /** Token usage, if the provider reported it (present even on some failures if charged). */
  readonly usage?: TokenUsage;
  /** Cost charged for this attempt, if the provider billed it (e.g. charged then failed). */
  readonly costUsd?: number;
}

/** The single response type for every model invocation. */
export interface ModelResponse {
  readonly contractVersion: string;
  /** Logical model id that was requested. */
  readonly model: string;
  /** Provider id that actually served the response (after any fallback). */
  readonly provider: string;
  /** Provider-specific model id that served the response. */
  readonly providerModelId: string;
  /** Assistant text content. */
  readonly content: string;
  /**
   * Separate chain-of-thought / reasoning text, when the model emits it
   * distinctly from `content` (e.g. MiMo's `reasoning_content`). Not all
   * providers/models populate this.
   */
  readonly reasoning?: string;
  /** Tool calls emitted by the model, if any. */
  readonly toolCalls?: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  readonly cost: Cost;
  /** Wall-clock latency of the served call (ms). */
  readonly latencyMs: number;
  /** Whether the served response came from a non-primary provider. */
  readonly fellBack: boolean;
  /** Every provider attempt, in order, with outcome — auditable. */
  readonly attempts: readonly ProviderAttempt[];
}

// ---------------------------------------------------------------------------
// Provider interface (what a concrete provider implements)
// ---------------------------------------------------------------------------

/** A normalized invocation handed to a concrete provider. */
export interface ProviderInvocation {
  /** Provider-specific model id to send (resolved from the roster route). */
  readonly providerModelId: string;
  /** The originating request. */
  readonly request: ModelRequest;
  /** Effective timeout for this attempt (ms). */
  readonly timeoutMs: number;
  /** Abort signal; providers should pass it to fetch and abort promptly. */
  readonly signal: AbortSignal;
}

/** Raw result returned by a provider; the orchestrator computes cost and assembles the response. */
export interface ProviderResult {
  readonly content: string;
  /** Separate reasoning text, when the model emits it distinctly from content. */
  readonly reasoning?: string;
  readonly toolCalls?: readonly ToolCall[];
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
}

// NOTE — parked seams (documented, intentionally NOT built in Phase 1):
//  * Streaming: `invokeModel` is request/response only. A streaming variant
//    (e.g. `invokeModelStream` yielding deltas) will be added later; the
//    contract above is the non-streaming shape it will share.
//  * Stop sequences: a `stop?: readonly string[]` request field can be added
//    backward-compatibly when needed.

/**
 * The provider abstraction. mimo direct and OpenRouter both implement this so
 * they are interchangeable behind the fallback chain.
 */
export interface ModelProvider {
  /** Stable provider id, e.g. "mimo", "openrouter". */
  readonly id: string;
  /** Perform a single invocation. MUST throw `ProviderError` on failure. */
  invoke(invocation: ProviderInvocation): Promise<ProviderResult>;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Classification of a provider failure — drives retriability and logging. */
export type ProviderErrorKind =
  | "timeout"
  | "http"
  | "network"
  | "auth"
  | "rate_limit"
  | "bad_response"
  | "config"
  | "unknown";

/** A typed failure from a single provider. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  readonly retriable: boolean;
  readonly status?: number;
  /** Token usage the provider reported, if it charged before/while failing. */
  readonly usage?: TokenUsage;
  /**
   * Server-requested backoff in milliseconds, parsed from a `Retry-After` header
   * (seconds or HTTP-date form). When present, the invoker waits AT LEAST this long
   * before retrying this route instead of its computed exponential backoff.
   */
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: {
      kind: ProviderErrorKind;
      provider: string;
      retriable?: boolean;
      status?: number;
      usage?: TokenUsage;
      retryAfterMs?: number;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "ProviderError";
    this.kind = opts.kind;
    this.provider = opts.provider;
    this.retriable = opts.retriable ?? true;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.usage !== undefined) this.usage = opts.usage;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Thrown by `invokeModel` when the entire fallback chain is exhausted. */
export class AllProvidersFailedError extends Error {
  readonly model: string;
  readonly attempts: readonly ProviderAttempt[];

  constructor(model: string, attempts: readonly ProviderAttempt[]) {
    super(
      `All providers failed for model "${model}": ` +
        attempts.map((a) => `${a.provider}=${a.outcome}`).join(", "),
    );
    this.name = "AllProvidersFailedError";
    this.model = model;
    this.attempts = attempts;
  }
}

/** Thrown when a requested logical model id is not in the roster. */
export class ModelNotFoundError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(`Model "${model}" is not in the roster (add it via the provider config).`);
    this.name = "ModelNotFoundError";
    this.model = model;
  }
}
