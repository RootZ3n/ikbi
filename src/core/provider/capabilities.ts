/**
 * ikbi provider — MODEL CAPABILITY PROFILES.
 *
 * A model's *capabilities* (how big its context is, whether it does tool-calling,
 * how much it can reason, how fast it is) are operational facts the engine adapts
 * to — NOT part of the frozen request/response contract. This module is a pure,
 * side-effect-free leaf: it declares the capability shape, a table of known-model
 * defaults, family-pattern fallbacks, and `getCapabilities(modelId)`.
 *
 * WHY a separate leaf (not the roster): the builder and the context-manager need
 * capabilities from a bare model-id string WITHOUT importing the provider registry
 * (which constructs providers and resolves the egress guard at import). Keeping
 * this dependency-free lets those hot paths read capabilities cheaply. The roster
 * (registry.ts) layers an OPTIONAL per-model OVERRIDE on top via `ModelSpec.capabilities`
 * — resolved by `resolveCapabilities` in the provider barrel.
 *
 * The cheap-model architecture leans on this: a small-context model gets a smaller
 * completion budget (so the prompt fits), a non-tool model gets simplified tool
 * schemas, and a slow/low-reasoning model can be driven with tighter steps.
 */

/** How much a model can reason in one shot. */
export type ReasoningLevel = "low" | "medium" | "high";
/** Rough latency class — drives step sizing / parallelism decisions. */
export type SpeedClass = "fast" | "medium" | "slow";

/** The capability profile of a single model. */
export interface ModelCapabilities {
  /** Total context window in tokens (prompt + completion). */
  readonly context_window: number;
  /** Whether the model supports native tool/function calling. */
  readonly supports_tools: boolean;
  /** How much reasoning the model can do in one response. */
  readonly reasoning_level: ReasoningLevel;
  /** Rough latency class. */
  readonly speed_class: SpeedClass;
  /**
   * ADDITIVE: whether the model supports Anthropic-style EXTENDED THINKING (a reasoning budget with
   * signed thinking blocks). Optional; absent ⇒ treat as false. Gates whether the chat loop offers the
   * opt-in thinking budget, so an unsupported model gracefully never receives a `thinking` request.
   */
  readonly supports_thinking?: boolean;
}

/**
 * The conservative fallback when a model is wholly unknown. A small-ish context,
 * tools assumed present (the builder only DEGRADES on an explicit `false`), medium
 * reasoning, medium speed. Deliberately modest so an unknown cheap model is driven
 * within safe bounds rather than over-fed.
 */
export const FALLBACK_CAPABILITIES: ModelCapabilities = Object.freeze({
  context_window: 8_192,
  // Conservative: unknown models default to text-tool emulation (no native tool calling).
  // Known models override this in KNOWN_CAPABILITIES or FAMILY_PATTERNS.
  // Roster entries can also override via ModelSpec.capabilities.supports_tools.
  supports_tools: false,
  reasoning_level: "medium",
  speed_class: "medium",
});

/** Exact-id capability table for models ikbi ships knowledge of. */
const KNOWN_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = Object.freeze({
  "mimo-v2.5": { context_window: 32_768, supports_tools: true, reasoning_level: "medium", speed_class: "fast" },
  "mimo-v2.5-pro": { context_window: 65_536, supports_tools: true, reasoning_level: "high", speed_class: "medium" },
  "deepseek-chat": { context_window: 65_536, supports_tools: true, reasoning_level: "medium", speed_class: "medium" },
  "deepseek-reasoner": { context_window: 65_536, supports_tools: false, reasoning_level: "high", speed_class: "slow" },
  "MiniMax-M1": { context_window: 131_072, supports_tools: true, reasoning_level: "high", speed_class: "medium" },
});

/** Family-pattern fallbacks (id substring → profile) for models not in the exact table. */
const FAMILY_PATTERNS: ReadonlyArray<{ readonly match: RegExp; readonly caps: ModelCapabilities }> = [
  { match: /mimo.*pro/i, caps: { context_window: 65_536, supports_tools: true, reasoning_level: "high", speed_class: "medium" } },
  { match: /mimo/i, caps: { context_window: 32_768, supports_tools: true, reasoning_level: "medium", speed_class: "fast" } },
  { match: /deepseek.*(reason|r1)/i, caps: { context_window: 65_536, supports_tools: false, reasoning_level: "high", speed_class: "slow" } },
  { match: /deepseek/i, caps: { context_window: 65_536, supports_tools: true, reasoning_level: "medium", speed_class: "medium" } },
  { match: /gpt-4o|gpt-4\.1|o[134]/i, caps: { context_window: 128_000, supports_tools: true, reasoning_level: "high", speed_class: "medium" } },
  // Frontier LOGICAL ids used in the roster (opus-4.8, sonnet-4.6) don't contain the word "claude",
  // so they must be classified by family here — otherwise they'd fall through to FALLBACK
  // (supports_tools:false, ctx 8192), forcing text-tool emulation and an 8k window on a 200k model.
  { match: /(^|[^a-z])(opus|sonnet)[-.]?4/i, caps: { context_window: 200_000, supports_tools: true, reasoning_level: "high", speed_class: "medium", supports_thinking: true } },
  { match: /haiku/i, caps: { context_window: 200_000, supports_tools: true, reasoning_level: "medium", speed_class: "fast" } },
  { match: /(claude-)?(opus|sonnet)/i, caps: { context_window: 200_000, supports_tools: true, reasoning_level: "high", speed_class: "medium", supports_thinking: true } },
  { match: /claude/i, caps: { context_window: 200_000, supports_tools: true, reasoning_level: "high", speed_class: "medium" } },
  { match: /gpt-5/i, caps: { context_window: 200_000, supports_tools: true, reasoning_level: "high", speed_class: "medium" } },
  { match: /glm-\d/i, caps: { context_window: 128_000, supports_tools: true, reasoning_level: "medium", speed_class: "medium" } },
  { match: /minimax/i, caps: { context_window: 131_072, supports_tools: true, reasoning_level: "high", speed_class: "medium" } },
  { match: /qwen/i, caps: { context_window: 32_768, supports_tools: false, reasoning_level: "medium", speed_class: "fast" } },
  { match: /(llama|gemma|phi|mistral|mixtral)/i, caps: { context_window: 8_192, supports_tools: false, reasoning_level: "low", speed_class: "fast" } },
];

/** True iff `o` is a (possibly partial) capabilities override with at least one valid field. */
function hasOverride(o: Partial<ModelCapabilities> | undefined): o is Partial<ModelCapabilities> {
  return o !== undefined && (
    typeof o.context_window === "number" ||
    typeof o.supports_tools === "boolean" ||
    o.reasoning_level !== undefined ||
    o.speed_class !== undefined ||
    typeof o.supports_thinking === "boolean"
  );
}

/**
 * Resolve a model's capabilities. Resolution order:
 *   1. the exact-id table,
 *   2. the first matching family pattern,
 *   3. the conservative fallback,
 * then any provided `override` (e.g. a roster `ModelSpec.capabilities`) is layered
 * on top, field-by-field. Always returns a complete profile.
 */
export function getCapabilities(modelId: string, override?: Partial<ModelCapabilities>): ModelCapabilities {
  let base: ModelCapabilities = FALLBACK_CAPABILITIES;
  const exact = KNOWN_CAPABILITIES[modelId];
  if (exact !== undefined) {
    base = exact;
  } else {
    const fam = FAMILY_PATTERNS.find((p) => p.match.test(modelId));
    if (fam !== undefined) base = fam.caps;
  }
  if (!hasOverride(override)) return base;
  return {
    context_window: typeof override.context_window === "number" && override.context_window > 0 ? override.context_window : base.context_window,
    supports_tools: typeof override.supports_tools === "boolean" ? override.supports_tools : base.supports_tools,
    reasoning_level: override.reasoning_level ?? base.reasoning_level,
    speed_class: override.speed_class ?? base.speed_class,
    ...((typeof override.supports_thinking === "boolean" ? override.supports_thinking : base.supports_thinking) ? { supports_thinking: true } : {}),
  };
}

/**
 * Adapt a desired completion-token budget to a model's context window: never ask
 * for more than `fraction` of the window (leaving room for the prompt), and never
 * below a small floor. Used by the builder so a small-context cheap model isn't
 * told to emit 12k tokens it has no room for.
 */
export function adaptMaxTokens(desired: number, caps: ModelCapabilities, fraction = 0.5, floor = 512): number {
  const ceiling = Math.max(floor, Math.floor(caps.context_window * fraction));
  return Math.max(floor, Math.min(desired, ceiling));
}
