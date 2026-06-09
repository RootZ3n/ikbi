# Claude Fable 5 — ikbi Context Document

**Generated:** June 9, 2026 (launch day)
**For:** ikbi provider layer, capability profiles, and model routing
**Model:** Anthropic Claude Fable 5 (`claude-fable-5`)

---

## Model Overview

Claude Fable 5 is Anthropic's most capable **widely released** model, announced June 9, 2026. It is the public counterpart to Claude Mythos 5 (invitation-only, Project Glasswing). Both represent Anthropic's next generation of intelligence for "the hardest knowledge work and coding problems."

Fable 5 is the direct successor to the Claude Opus tier — it sits ABOVE Opus 4.8 in the capability hierarchy.

---

## Technical Specifications

| Property | Value |
|----------|-------|
| **API Model ID** | `claude-fable-5` |
| **Context Window** | **1,000,000 tokens** (1M) |
| **Tool/Function Calling** | Yes (native) |
| **Vision/Multimodal** | Yes (text + image input) |
| **Extended Thinking** | No |
| **Adaptive Thinking** | **Yes (always on)** |
| **Streaming** | Yes |
| **Prompt Caching** | Yes |
| **Output Modalities** | Text only |

---

## Capability Profile (for ikbi's `capabilities.ts`)

```typescript
"claude-fable-5": {
  context_window: 1_000_000,  // 1M tokens — THE defining characteristic
  supports_tools: true,        // Full native tool-calling
  reasoning_level: "high",     // Top-tier reasoning
  speed_class: "slow",         // Larger model = higher latency (relative to Haiku/Sonnet)
}
```

**IMPORTANT:** The existing `/claude/i` family pattern match in `capabilities.ts` assigns 200,000 context_window. This is INCORRECT for Fable 5 and must be overridden with an exact entry in `KNOWN_CAPABILITIES`. Using the 200k default would waste 80% of the available context window.

---

## Context Manager Impact

The 1M token context window changes the economics of the cheap-model architecture:

1. **Compression threshold** — Current code uses `compressThreshold()` based on context_window. At 1M tokens, the threshold computes to 0.7 × 1M = 700K. This means compression won't trigger until the conversation reaches ~700K tokens. For most builds, compression may NEVER trigger with Fable 5 — the entire build fits in context.

2. **Completion budget** — `adaptMaxTokens()` uses `context_window * 0.5` as ceiling. With 1M, the builder can request up to 500K completion tokens. The current `BUILDER_MAX_TOKENS` cap should remain (it's a soft cap below the ceiling), but Fable 5 removes the ceiling constraint entirely.

3. **Progressive disclosure** — With a 1M context, the need for progressive disclosure (scout brief → scout_detail) is reduced. Fable 5 CAN handle the full scout output in one shot. Consider adding an optional `full_scout` mode for 1M-context models.

4. **Cost consideration** — Fable 5 is expensive. The cost engine will report significantly higher per-invocation costs than MiMo. Budget-conscious labs should use Fable 5 as the CRITIC/DRIVER model (where correctness matters most), not the BUILDER.

---

## Adaptive Thinking

Fable 5 has **adaptive thinking always on**. This means:

- The model will internally reason before producing tool calls
- ikbi's `stop_reason` handling must handle `"end_turn"` (adaptive thinking completed normally)
- The model may produce longer first-token latency as it thinks
- **Timeout settings must accommodate this** — Fable 5 can take 5-30 seconds of "thinking" before emitting tokens
- The circuit breaker should account for thinking time separately from generation time

**Current ikbi state:** The provider layer handles `stop_reason` generically (OpenAI-compatible). No specific adaptive-thinking awareness. This should work out of the box, but timeouts may need tuning.

---

## Provider Configuration

Fable 5 is available through:

| Channel | Provider Config | Base URL |
|---------|----------------|----------|
| **Anthropic API** | `provider: anthropic`, native SDK required | `https://api.anthropic.com/v1/messages` |
| **Anthropic API (OpenAI-compat)** | `provider: openai-compatible`, base_url set | Available if Anthropic offers OpenAI-compatible endpoint |
| **OpenRouter** | `provider: openrouter` | `https://openrouter.ai/api/v1` |
| **AWS Bedrock** | `provider: bedrock` | Region-specific |
| **Vertex AI** | `provider: vertex` | Region-specific |

**ikbi's current provider layer** uses OpenAI-compatible HTTP (`POST /chat/completions`). This works for OpenRouter and MiMo directly, but Anthropic's native API uses a DIFFERENT protocol (`POST /v1/messages`). To use Fable 5 directly via Anthropic API:

- Either add an Anthropic-native provider (separate from `openai-compatible.ts`)
- Or route through OpenRouter (which translates between protocols)
- **RECOMMENDATION:** Route through OpenRouter for immediate compatibility. Add native Anthropic provider as a follow-up.

---

## Pricing (Anthropic API — to be confirmed)

Pricing for Fable 5 was not available at the time of this document. Expected to be above Opus 4.8 tier ($5/$25 input/output per MTok). For cost tracking:

```typescript
// Placeholder — update when pricing is confirmed
"claude-fable-5": {
  cost: { promptPerMTok: 10.0, completionPerMTok: 50.0 }
}
```

---

## ikbi Integration Checklist

- [ ] Add `claude-fable-5` to `KNOWN_CAPABILITIES` in `src/core/provider/capabilities.ts`
- [ ] Verify `/claude/i` family pattern doesn't override Fable 5's specific entry
- [ ] Add `claude-fable-5` to the roster file (`state/providers.json`) with correct cost rates
- [ ] Test with OpenRouter as the initial provider
- [ ] Tune timeout settings for adaptive thinking latency
- [ ] Consider `full_scout` mode for 1M-context models
- [ ] Add native Anthropic provider for direct API access (follow-up)
- [ ] Update `ROLE_MODELS` to allow `claude-fable-5` as DRIVER or CRITIC
- [ ] Verify circuit breaker behavior with Fable 5's thinking latency
- [ ] Test with a real build — the 1M context should dramatically change compression behavior

---

## Fable 5 vs Current ikbi Models

| Model | Context | Tools | Reasoning | Speed | Best Role |
|-------|---------|-------|-----------|-------|-----------|
| **claude-fable-5** | 1,000,000 | ✅ | High | Slow | Driver, Critic |
| claude-opus-4-8 | 200,000 | ✅ | High | Medium | Builder, Critic |
| mimo-v2.5-pro | 65,536 | ✅ | High | Medium | Critic |
| mimo-v2.5 | 32,768 | ✅ | Medium | Fast | Builder |
| deepseek-chat | 65,536 | ✅ | Medium | Medium | Builder |

---

## Key Architectural Implications

1. **Context is no longer the bottleneck.** With 1M tokens, the entire scout output + full file contents + conversation history fits comfortably. The retrieval budget becomes the limiting factor, not the context window.

2. **Compression may be unnecessary for 95% of builds.** The context manager should be aware that 1M models can skip compression for most tasks. Add a `skip_compression` hint based on context_window size.

3. **Cost becomes the NEW bottleneck.** Fable 5 is expensive. The cost engine will report dramatically higher per-build costs than MiMo. This makes the competitive-build feature MORE valuable (race cheap models, promote only the winner, verify with Fable 5).

4. **Scout → Builder handoff changes.** With enough context for the FULL scout output (all findings, all files), the progressive-disclosure pattern is no longer needed. The scout can dump everything; the builder reads it all.

5. **Verification-ladder with Fable 5 as critic.** The most impactful use: run builds on MiMo (cheap), verify with the ladder, then have Fable 5 review the result as critic. Best of both worlds — cheap builds, world-class verification.

---

*Document prepared for ikbi provider-layer integration. Update as Anthropic releases more details.*
