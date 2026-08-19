# ikbi V2 — Cutover Readiness Matrix (V2-016)

Evidence artifact (not a runtime dependency). Generated for the V2-016 live-compatibility slice.
Selectability/tools/pricing rows are proven by the hermetic suites cited; the live-smoke column is
`NOT_RUN` because no provider credentials were present in the build environment.

## Roles the operator intends to drive

The shipped tier defaults are `driver/builder = mimo-v2.5`, `critic = mimo-v2.5-pro` (mirrors v1).
**INVENTORY IS FACT, PREFERENCE IS NOT INVENTORY** — a model with no declared route on a given box
is truthfully `resolution.no_selectable_route`, never routed through an invented fallback.

Recommended daily-driver configs (both resolve to **exact real routes**, proven in
`src/v2/runtime/live-routing.test.ts`):

| Box credentialed | `IKBI_MODEL_DRIVER`/`BUILDER` | `IKBI_MODEL_CRITIC` | builder route | critic route |
|---|---|---|---|---|
| DeepSeek | `deepseek-chat` | `deepseek-reasoner` | `deepseek/deepseek-chat` | `deepseek/deepseek-reasoner` |
| MiMo | `mimo-v2.5` (default) | `mimo-v2.5-pro` (default) | `mimo/mimo-v2.5` | `mimo/mimo-v2.5-pro` |

## Model matrix

| logical id | provider(s) | builder-selectable? | critic-selectable? | native tools? | served-identity behavior | price available? | live smoke |
|---|---|---|---|---|---|---|---|
| `deepseek-chat` | deepseek | ✅ | ✅ | ✅ | exact (`match`) | ✅ | NOT_RUN |
| `deepseek-reasoner` | deepseek | ✅ | ✅ | ✅ | exact (`match`) | ✅ | NOT_RUN |
| `deepseek-v4-flash` | deepseek | ✅ | ✅ | ✅ | exact (`match`) | ✅ | NOT_RUN |
| `mimo-v2.5` | mimo, openrouter | ✅ (mimo/openrouter creds) | ✅ | ✅ | exact (`match`) | ✅ | NOT_RUN |
| `mimo-v2.5-pro` | mimo, **deepseek†** | ✅ (mimo creds) | ✅ | ✅ | exact on mimo | ✅ | NOT_RUN |
| `gpt-4o` | openai (auto) | ✅ | ✅ | ✅ | **`aliased_match`** → dated snapshot | ✅ (aliases priced) | NOT_RUN |
| `claude-sonnet-4-5` | anthropic (auto) | ✅ | ✅ | ✅ | **`aliased_match`** → dated snapshot | ✅ (aliases priced) | NOT_RUN |
| `minimax-m3` | minimax (auto) | ✅ | ✅ | ✅ | exact (`match`) | ✅ | NOT_RUN |
| `gemini-2.5-flash` | google (auto) | ❌ (no native tools) | ⚠️ (8k window) | ❌ | exact | ✅ | NOT_RUN |
| `llama-3.3-70b` | groq (auto) | ❌ (no native tools) | ⚠️ | ❌ | exact | ✅ | NOT_RUN |
| `deepseek-v4-pro` | deepseek (roster only‡) | roster-only | roster-only | ✅ | exact | ❌ (declare in roster) | NOT_RUN |
| `opus-4.8` | stub | ❌ (stub route) | ❌ | ✅ | n/a | ❌ (deliberately unpriced) | NOT_RUN |

† **`mimo-v2.5-pro`'s `deepseek` fallback route is a v1-inherited fiction** (v1's `buildDefaultRegistry`
gives the critic default a deepseek fallback that would send the mimo wire id to DeepSeek). It is
pinned to v1 by the catalog-drift guard. On a DeepSeek box, use `deepseek-reasoner` directly (above)
rather than relying on this route; on a MiMo box the primary `mimo` route serves it exactly.

‡ **`deepseek-v4-pro`** is a real, classified DeepSeek model that v1's escalation config references
but neither v1's `buildDefaultRegistry` nor v2's shipped catalog declares a route for. Per
"INVENTORY IS FACT / no invented routes", it is selectable only when the operator declares it in a
`providers.json` roster (`{ "id": "deepseek-v4-pro", "providers": [{ "provider": "deepseek",
"providerModelId": "deepseek-v4-pro" }] }`) with a price. Reported truthfully rather than fabricated.

## Served-model aliases (declared, exact, provider-scoped)

`src/v2/core/invocation.ts :: V2_SERVED_ALIAS_TABLE` — the ONE alias owner. Accepted only when
explicitly declared; the **actual served id remains the pricing truth** (priced at the same rate via
explicit equivalence routes in the pricing catalog):

| provider | authorized | allowed served snapshots |
|---|---|---|
| openai | `gpt-4o` | `gpt-4o-2024-08-06`, `gpt-4o-2024-11-20`, `gpt-4o-2024-05-13` |
| anthropic | `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` |

Undeclared date / different family / cross-provider / case-variant → `mismatch` (hostile tests in
`src/v2/core/invocation.test.ts` + `src/v2/core/cost.test.ts`).

## Live provider smoke (Part J)

**NOT_RUN — no provider credentials were present in the build environment** (`0` `*_API_KEY` set).
Per the slice's rules, code was not weakened to make a vendor pass; the hermetic suites (including
the full provider-native terminal E2E in `src/v2/cli/terminal-e2e.test.ts`, which drives
`run_command → read_file → state-bound replace → finish → verify → critic → promote` to an exact
landed publication) remain the authoritative proof of the spine. To run a real smoke later: set a
DeepSeek key, `IKBI_MODEL_DRIVER=deepseek-chat IKBI_MODEL_CRITIC=deepseek-reasoner`, and
`ikbi v2 build "<tiny task>" --repo <disposable>` against a clean repo with a cheap deterministic
check.
