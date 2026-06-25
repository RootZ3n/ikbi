# Runtime Truth Shadow Bridge — Runbook / Receipt

**Status:** Docs only. Records the shadow-bridge wiring as shipped. No code in this doc.

**Commit:** `6e34d6b90ae502c782330ee4e039f3ca549ab3a8` —
`feat(cognition): shadow-mode RuntimeTruthReader bridge (advisory-only)`.

> ⚠️ **Production reader injection is the NEXT phase, not part of this commit.** The shadow bridge
> is inert in production until an operator injects a reader (see "How to inject a reader later").

## What changed

- New module `src/modules/runtime-truth-shadow/` (`contract.ts`, `config.ts`, `events.ts`,
  `shadow.ts`, `index.ts`, `shadow.test.ts`).
- `src/modules/cognition-layer/cognition.ts` gained two **optional** deps (`runtimeTruth`,
  `runtimeTruthMode`) and, after the normal decision + `cognition.decided` event, an additive
  **shadow run** that logs a comparison event. No frozen-core (`src/core/`) change. No existing test
  modified.

The shadow run computes a Truth Firewall `RuntimeTruthReader` advisory summary ALONGSIDE the
cognition decision and publishes a `cognition.runtime_truth_shadow` event (labels only — no goal,
rationale, or memory text) for offline comparison. It **never changes the decision**.

## Why ikbi imports no Truth Firewall code

ikbi is **standalone** (no shared package, no cross-repo runtime dependency). Hard-importing Truth
Firewall would break that invariant. Instead the bridge depends on Truth Firewall through a **local
port** defined inside ikbi. The real reader is supplied from the edge by injection; ikbi's source
imports nothing from `truth-firewall`. This is enforced by import-surface boundary tests:

- `runtime-truth-shadow` source imports no `truth-firewall`, no `runtime-truth/{graph,drift,health,…}`,
  and no agent repo;
- `runtime-truth-shadow` performs no file/memory writes (no `fs`, no `writeFileSync`/`appendFileSync`);
- `cognition.ts` imports the shadow module via its **public `index.js`** only (not an internal file)
  and imports no `truth-firewall`.

## RuntimeTruthReaderPort boundary

```ts
interface RuntimeTruthReaderPort {
  summarizeForCognition(task: string, recentRefs: readonly string[]): RuntimeTruthSummary | Promise<RuntimeTruthSummary>;
}
```

`RuntimeTruthSummary` is structurally identical to Truth Firewall's `CognitionSummary` (rationale,
confidence, risks, missingInfo, memoryUsed, evidenceNotes, consistency, health, `advisoryOnly: true`)
— so Truth Firewall's `RuntimeTruthReader` satisfies the port by structure, with no import. The
summary is **inputs only** for a `CognitionDecision`; it carries no executable actions.

## Shadow mode behavior

- **No-op** unless `mode === "shadow"` **AND** a reader is injected.
- **Never** changes the cognition decision; the decision and its `cognition.decided` event are
  produced exactly as before.
- **Fail-closed:**
  - a reader that throws is swallowed (shadow must never break deliberation);
  - a summary that is not strictly `advisoryOnly === true` is **rejected** (dropped — never logged as
    a verdict), so a non-advisory payload can never leak into ikbi.
- **Logged/receipted:** on a valid advisory summary it publishes `cognition.runtime_truth_shadow`
  with the consistency verdict, summary confidence, risk count, drift score/severity, overall trust,
  and the cognition decision label — for offline comparison. It carries **no** `recommendedNext`,
  approval, install, or executable action.
- May surface warnings about stale / unsupported / contradicted / superseded / drifted memory (via
  the summary's `risks` + `evidenceNotes`); these are advisory only.

## Ricky default shadow profile

`SHADOW_DEFAULT_AGENTS = { "ricky" }` (in `config.ts`). When `IKBI_RUNTIME_TRUTH` is unset:

- agent **`ricky`** → mode `shadow` (case-insensitive);
- every other agent (incl. Bubbles/Julian) → mode `off`.

Because no reader is wired by default, Ricky's actual decisions are **unchanged** — only the mode flag
is defaulted on, inert until a reader is injected.

## How `IKBI_RUNTIME_TRUTH` behaves

| `IKBI_RUNTIME_TRUTH` | agent | effective mode |
| --- | --- | --- |
| unset | `ricky` | `shadow` (profile default) |
| unset | any other | `off` |
| `shadow` | any | `shadow` (applies to ALL agents) |
| `off` | any (incl. `ricky`) | `off` (explicit operator override wins) |
| anything else | any | `off` (fail-closed parse) |

The env var is read once from the frozen process-env snapshot. `resolveRuntimeTruthMode(agentId, env)`
is the single resolver; tests pass an explicit `env`.

## How to inject a reader later (NEXT PHASE — not in this commit)

Shadow mode is inert until a reader is injected. A future composition-root adapter builds a Truth
Firewall reader from current memory and passes it in:

```ts
// edge/adapter (future) — NOT wired in this commit:
import { createRuntimeTruthReader } from "<truth-firewall>/runtime-truth/reader.js"; // adapter side only
const reader = createRuntimeTruthReader({ records, observations });
const layer = createCognitionLayer({ runtimeTruth: reader /*, runtimeTruthMode resolves per-agent */ });
```

Only the **adapter** imports Truth Firewall; ikbi's cognition module still imports only the local
port. Until that adapter exists, the bridge logs nothing in production.

## Proof that cognition decisions are unchanged

`shadow.test.ts` deliberates the same goal twice — once without a reader and once with a reader in
shadow mode — and asserts the returned `CognitionDecision` objects are **deep-equal**. Additional
tests assert: shadow mode with no reader emits only the normal `cognition.decided` event; a valid
shadow run emits both `cognition.decided` and `cognition.runtime_truth_shadow`; a non-advisory or
throwing reader produces no shadow event and no decision change.

## Test results

| check | result |
| --- | --- |
| `pnpm typecheck` | clean |
| `pnpm build` | clean (typechecks all sources + tests) |
| `pnpm test` | **2783 / 2783 pass** (incl. the new shadow + boundary tests, all cognition tests, wiring-docs) |

## Known limitation

The shadow bridge is **inert until a reader is injected**. With no reader wired (the default,
including for Ricky), the shadow run is a no-op and nothing is logged in production. This is
intentional: it keeps ikbi standalone (no Truth Firewall import) and keeps the bridge fully advisory.

## Explicit warning

**Production reader injection is the next phase and is NOT part of commit `6e34d6b9`.** This commit
ships only the advisory shadow bridge + the Ricky default profile. No automatic memory rewrites, no
approval/install, no enforcement, and no tool execution are introduced.
