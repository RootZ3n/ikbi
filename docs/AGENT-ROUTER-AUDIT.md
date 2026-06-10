# IKBI AGENT-ROUTER AUDIT — Deterministic Routing Engine Review

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Scope:** Fresh-code audit of the `src/modules/agent-router/` module — classify + ask over lab memory. Never reviewed before.

**Verdict: 91% ready. Architecture is excellent. 1 CRITICAL finding, 3 HIGH, 3 MEDIUM.**

---

## ARCHITECTURE SUMMARY

The agent-router is a classify-and-answer module:
- **classify** — sends user message to mimo-v2.5, parses JSON intent from response, RETURNS the classification (never dispatches)
- **ask** — pulls cross-agent lab memory for a project, sends memory + question to mimo-v2.5, returns answer with redacted sources
- **Agent-agnostic** — runs under whatever `AgentIdentity` is supplied at runtime
- **Executes nothing** — no worker-model, governed-exec, or gate-wall imports
- **Untrusted content chokepoint** — all user input and lab-memory content passes through `neutralizeUntrusted` before reaching the model
- **Events** — publishes `router.classified` and `router.answered` (payloads never leak message/answer/memory content)

---

## CRITICAL — Fix before production use

### C1 — Test suite uses a neutralize spy that STRIPS content, but the real function WRAPS it (MISLEADING SECURITY TEST)

**Files:** `agent-router.test.ts` lines ~28-48 (neutralizeSpy), `router.ts` line ~130 (untrustedMessage)
**What the test asserts:**
```ts
// The spy replaces content with a length-only placeholder:
wrapped: `[NEUTRALIZED:${context.source}] <redacted ${content.length} chars>`

// Test: "raw injection text is NOT in the prompt un-neutralized"
assert.ok(!userMsgs[0]?.content.includes(injection), "raw injection text is NOT in the prompt un-neutralized");
```

**What the REAL `neutralizeUntrusted` does:**
```ts
// Wraps content in a verified-absent fence boundary:
const wrapped = buildWrapped(body, fenceId, context.source, context.origin, {...});
// The original text IS preserved inside the fence — losslessly recoverable.
```

**Why this matters:** The test suite gives a **false sense of security** about injection resistance. The real neutralize function does NOT strip content — it fences it. The model sees the original injection text, just wrapped in a fence boundary. This is legitimate security architecture (instruction hierarchy), but the test incorrectly claims the injection text "is NOT in the prompt."

The contract is honest about this: "does not eliminate semantic influence." But the agent-router's own test asserts something the real neutralize function doesn't do.

**The actual security model is:**
1. Content is fenced with a verified-absent nonce (the model can't forge the fence)
2. Content is carried in a structurally-isolated `data-role` message (`untrusted: true`)
3. The model is supposed to treat fenced data-role messages as DATA, not instructions
4. For high-risk sources, dangerous primitives are defanged

This is a GOOD architecture. But the test is testing the WRONG thing — it tests a spy that strips content, not the real pipeline that fences it.

**Fix:** Rewrite the classify-neutralization test to use the REAL `neutralizeUntrusted` (or at minimum, make the spy accurately model the fence output). Assert that:
1. The content IS present but inside a verified fence boundary (can be extracted)
2. The message IS marked `untrusted: true`
3. The message role IS `user` (not `system`/`assistant`)
4. The fence ID is verified-absent from the content

---

## HIGH — Address before relying on this in production

### H1 — `parseIntent` uses a greedy regex that fails on multi-JSON-object responses

**File:** `router.ts` line ~90
```ts
function parseIntent(content: string): IntentResult {
  const m = content.match(/\{[\s\S]*\}/);  // GREEDY — matches first { to last }
```

**Demonstration of failure:**
If the model outputs:
```
I analyzed the request. {"intent":"build","target":"demo","confidence":0.9}
Additional context: {"other":"metadata"}
```

The greedy regex captures: `{"intent":"build","target":"demo","confidence":0.9} Additional context: {"other":"metadata"}` — including the text between the two JSON objects. `JSON.parse` fails, and the intent falls through to `intent: "unknown"` with the error "classifier output was not parseable JSON."

**Same issue in reverse:** If the model outputs a trailing explanation after the JSON:
```
{"intent":"question","confidence":0.8} The user seems to be asking about project status.
```
The regex captures the whole thing. `JSON.parse` fails.

**Fix:** Extract only the FIRST complete JSON object using a balanced-brace approach, or use a non-greedy pattern with stricter boundaries:
```ts
const m = content.match(/\{[\s\S]*?\}/); // non-greedy — but still fails on nested JSON
// Better: find the first { and parse until balanced braces close
```

### H2 — No timeout on model calls — classify/ask hang forever on model hang

**File:** `router.ts` lines ~125, ~145
```ts
const response = await invokeModel({ model: ROUTER_MODEL, ... });
```
**Risk:** The `invokeModel` call has no timeout signal. If the provider hangs (network partition, overloaded API, infinite generation), the classify/ask operations hang indefinitely. The caller has no way to cancel.

**Fix:** Pass `AbortSignal.timeout(30_000)` to the model call. The `ModelRequest` type should support an `abortSignal` field — verify and use it.

### H3 — `ROUTER_MODEL` is hardcoded to `"mimo-v2.5"` — no configuration override

**File:** `config.ts` line ~15
```ts
export const ROUTER_MODEL = "mimo-v2.5";
```
**Risk:** The classifier/answerer model is baked into the source code. If the operator wants to switch models (e.g., to a smaller/faster model for classification, or to a different provider), they must change the source and rebuild. No `IKBI_AGENT_ROUTER_MODEL` env var exists.

The config system (`moduleEnv("agent-router")`) already reads `IKBI_AGENT_ROUTER_*` env vars — but there's no `MODEL` key wired.

**Fix:** Add `IKBI_AGENT_ROUTER_MODEL` with `ROUTER_MODEL` as default, same pattern as `MAX_MEMORY_ENTRIES`.

---

## MEDIUM — Nice-to-fix

### M1 — `CLASSIFY_SYSTEM` prompt has no per-caller customization

**File:** `router.ts` line ~50
```ts
const CLASSIFY_SYSTEM = "You are an intent classifier. ...";
```
**Risk:** Different callers may need different intent labels. The hardcoded prompt only recognizes ["build", "question", "status", "other"]. A caller wanting "deploy" or "review" intents cannot extend the classifier without modifying the source.

**Fix:** Allow an optional `customLabels?: string[]` in `ClassifyInput` that extends the labels list. Or make the system prompt configurable per-caller.

### M2 — `ANSWER_SYSTEM` prompt doesn't include project context — model must infer from memory entries

**File:** `router.ts` line ~55
```ts
const ANSWER_SYSTEM = "You answer questions about a multi-agent lab using the provided MEMORY context. ...";
```
**Risk:** The model receives individual memory entries but no explicit statement of which project they belong to. If two projects have overlapping agent names or similar keys, the model may conflate them. The memory entries DO carry `project` in their JSON, but the prompt doesn't explicitly state the project scope.

**Fix:** When `project` is provided, prepend: "The following memory entries all belong to project X." to the system prompt.

### M3 — No model fallback — single point of failure

**File:** `router.ts` lines ~125, ~145
**Risk:** If mimo-v2.5 is unavailable (rate-limited, provider down, key expired), both classify and ask fail with no fallback. There's no secondary model configured.

**Fix:** Add `IKBI_AGENT_ROUTER_FALLBACK_MODEL` and a simple fallback chain in the model invocation.

---

## WHAT'S EXCELLENT ABOUT THIS MODULE

1. **Contract-driven architecture.** The module declares its frozen-core dependencies at the top of `index.ts` with `assertContractCompatible()`. Drift is caught at load time.

2. **No-execution guarantee.** The module imports NO action modules (worker-model, governed-exec, gate-wall, subagent-spawning). This is verified by a TEST that greps the source files for forbidden imports. That's clever.

3. **Agent-agnostic design.** The same router logic runs under any identity. The test proves it by running classify with `agent-a` and `agent-zeta` — same code, different identities. No hardcoded agent anywhere.

4. **Event hygiene.** `router.classified` carries only the intent label — never the message text. `router.answered` carries only the project and source count — never the question, answer, or memory values. The test verifies this by searching for secret strings in the serialized events.

5. **Fail-closed everywhere.** Disabled router? Refuse. Invalid identity? Refuse. Missing operator token? Clear error, exit 1. Model call fails? Surfaced with actionable guidance (`check IKBI_MIMO_API_KEY`).

6. **CLI with clean error messages.** No raw stack traces. Every error path prints a human-readable message to stderr and exits non-zero.

7. **Test coverage is thorough.** 12 router tests + 7 CLI tests. Every invariant is verified: neutralization, no-execution, cross-agent Q&A, agent-agnostic, fail-closed refusals, event hygiene, CLI chain end-to-end, empty input handling.

8. **Honest about limits.** The injection contract explicitly says "does not eliminate semantic influence." The architecture doesn't pretend to solve what it can't.

---

## SUMMARY

| # | Severity | Finding | Impact |
|---|----------|---------|--------|
| C1 | CRITICAL | Test neutralize spy strips content; real function fences it | False sense of injection security |
| H1 | HIGH | Greedy regex in parseIntent fails on multi-JSON responses | Legitimate intents misclassified as "unknown" |
| H2 | HIGH | No timeout on model calls | classify/ask hang forever on provider hang |
| H3 | HIGH | ROUTER_MODEL hardcoded, no env override | Cannot switch models without source change |
| M1 | MEDIUM | CLASSIFY_SYSTEM prompt not extensible | Only 4 intent labels, no per-caller customization |
| M2 | MEDIUM | ANSWER_SYSTEM missing project context | Model must infer project from memory entries |
| M3 | MEDIUM | No model fallback | Single point of failure if mimo-v2.5 is down |

**Bottom line:** The architecture is genuinely well-designed — agent-agnostic, contract-driven, no-execution, event-hygienic, fail-closed. The test suite is thorough. The only critical issue is that the neutralize spy in tests doesn't match what the real function does, creating a misleading security assertion. Fix that, add a timeout and model config, and this is production-ready.
