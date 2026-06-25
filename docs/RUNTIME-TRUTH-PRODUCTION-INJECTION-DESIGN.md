# Production RuntimeTruthReader Injection — Design Receipt

**Status:** DESIGN ONLY. No code, no adapter implementation, no Truth Firewall change, no agent-repo
change. Records the accepted design for injecting a concrete `RuntimeTruthReader` into ikbi for Ricky
shadow mode. Follows the shadow bridge (commit `6e34d6b90ae502c782330ee4e039f3ca549ab3a8`,
see `docs/RUNTIME-TRUTH-SHADOW-BRIDGE.md`).

## Design summary

The smallest safe shape is three pieces, with the ONLY Truth Firewall touch-point isolated to a
dynamically-loaded, operator-provided adapter:

1. **Per-deliberation provider (ikbi):** the cognition layer gets an optional
   `runtimeTruthProvider?: (project?, agentId?) => Promise<RuntimeTruthReaderPort | null>`, called in
   shadow mode to build a FRESH reader each deliberation (the staleness fix). Replaces/augments the
   current static `runtimeTruth` dep.
2. **Mapper + fail-closed loader (ikbi):** a pure `MemoryEntry[] → MemoryRecord[]` mapper, plus a
   loader that — in shadow mode only — dynamically `import()`s an operator-configured module
   (`IKBI_RUNTIME_TRUTH_READER_MODULE`). Unset/failed import ⇒ fail-closed (inert, normal ikbi).
3. **Operator adapter (outside ikbi's standalone build):** the sole module that imports
   `truth-firewall`, exporting `createReaderProvider` which calls TF's
   `createRuntimeTruthReader({ records, observations })`.

Ricky gets shadow by default via the existing `resolveRuntimeTruthMode`; Bubbles/Julian stay off;
cognition decisions never change; everything fails closed; two independent kill-switches.

## Recommended boundary: operator-provided adapter via dynamic import

ikbi ships the port + mapper + loader; the real reader is resolved at RUNTIME from a configured
module path. ikbi still builds and tests standalone (no static `truth-firewall` import anywhere in
ikbi source).

| Boundary | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **Operator adapter + dynamic import** | preserves standalone; single isolated TF touch-point; fail-closed; smallest | runtime-resolved (errors at runtime, mitigated by fail-closed + a `doctor` check); operator configures path + installs TF | ✅ recommended |
| Static dep `@lab/truth-firewall` | type-safe; simplest | **violates ikbi standalone** | ❌ reject |
| Separate bridge package/process | clean separation | heavier than shadow warrants | ⚠️ overkill |
| CLI/subprocess (spawn TF CLI) | strong isolation | per-deliberation latency + serialization; larger failure surface | ⚠️ fallback only |
| Pure file boundary (precomputed summary) | fully decoupled | can't pass task/recentRefs; precomputed ⇒ stale | ❌ for the summary (ok only for optional ledger input) |

## Why a static Truth Firewall import is rejected

ikbi is **standalone**: no shared package, no cross-repo runtime dependency, must `pnpm install &&
pnpm build` on its own. A static `import` of `truth-firewall` in ikbi source would make TF a
build/runtime dependency and break that invariant. The dynamic-import boundary keeps ikbi buildable
and testable without TF present, and confines the only TF coupling to an optional operator module
that is loaded (or absent) at runtime. Import-surface boundary tests continue to assert ikbi source
contains no `truth-firewall` import.

## Data flow (shadow deliberation, Ricky)

```
CLI (src/cli/index.ts:102 createCognitionRouter)         ← composition root
  └─ createCognitionLayer(deps incl. runtimeTruthProvider?)
       └─ deliberate(input):
            1. compute decision                          (UNCHANGED path)
            2. publish cognition.decided
            3. if resolveRuntimeTruthMode(agentId)==='shadow' AND provider present:
                 a. provider(project, agentId):
                      - labMemory.byProject(project) → MemoryEntry[]   (existing read-only surface)
                      - map → MemoryRecord[]                            (ikbi mapper, pure)
                      - (optional) read TF ledger.ndjson read-only → observations[]
                      - dynamic TF createRuntimeTruthReader({records, observations}) → reader
                 b. reader.summarizeForCognition(goal, decision.memoryUsed) → summary
                 c. validate advisoryOnly===true (else drop)
                 d. publish cognition.runtime_truth_shadow (+ optional receipt)
            4. return decision                           (UNCHANGED, regardless of step 3)
```

Every step in (3) is wrapped fail-closed; any throw ⇒ skip shadow, return the normal decision.

### Record conversion + fidelity limit

`MemoryEntry {id, project, agent, kind, key, value, createdAt, updatedAt}` →
`MemoryRecord {id, source:'lab_context', namespace: kind, agent, status:'current', subject: key, text: stringify(value)}`.

ikbi's `MemoryEntry` carries **no evidence, supersession, or verdict** fields, so a graph built from
live ikbi memory supports **contradiction / orphan / related_to** signals but NOT
stale/unsupported/supersession/evidence-based drift. This is honest and acceptable for an advisory
shadow log, and must be documented so the log is not over-read. Richer (evidence/verdict) records
would require Truth Firewall memory-governance review data — explicitly OUT OF SCOPE for the smallest
self-contained adapter.

### Ledger observations

v1: **none** (empty), keeping the adapter self-contained. Optional later via
`IKBI_RUNTIME_TRUTH_LEDGER=<path>` (read-only `runtime-truth/ledger.ndjson`) to enable
`ledger_recurrence` drift; off by default; a read failure is non-fatal.

## Config / env plan

- `IKBI_RUNTIME_TRUTH` = `off | shadow` (existing; Ricky default shadow, others off). **Primary rollback switch.**
- `IKBI_RUNTIME_TRUTH_READER_MODULE` = module path exporting `createReaderProvider` (default **unset → inert**). The only thing that makes shadow non-inert.
- `IKBI_RUNTIME_TRUTH_LEDGER` = optional read-only ledger path (default unset → no observations).
- `IKBI_RUNTIME_TRUTH_RECEIPT` = `on | off` (default off) — also write a durable shadow receipt.

Keeps the `IKBI_RUNTIME_TRUTH_*` prefix; the loader reads these explicitly as a cross-cutting feature
flag (same justification as today's `IKBI_RUNTIME_TRUTH`).

## Ricky default shadow behavior / Bubbles & Julian off

`resolveRuntimeTruthMode(agentId, env)` (existing): env wins for all agents; otherwise
`SHADOW_DEFAULT_AGENTS = { "ricky" }` ⇒ **Ricky defaults to shadow, Bubbles/Julian and all others
default to off**. Even for Ricky, the shadow run is inert unless a provider is loaded; and it is
advisory-only, so Ricky's decisions are unchanged.

## What gets logged / receipted

- **Always (existing event):** `cognition.runtime_truth_shadow` — labels only: consistency verdict,
  summary confidence, risk count, drift score/severity, overall trust, cognition decision+confidence,
  `advisoryOnly:true`. No goal/rationale/memory text.
- **Optional receipt (gated):** durable shadow receipt adding `timestamp`, a `divergence` flag (e.g.
  shadow `INCONSISTENT`/high-drift vs a confident `answer`), and the warning strings. Never any
  action/approval/install field.

## Failure modes (all fail-closed → normal ikbi continues)

| Failure | Behavior |
| --- | --- |
| `IKBI_RUNTIME_TRUTH_READER_MODULE` unset | inert; no shadow; no log |
| adapter module import fails | caught → no provider → inert; one debug warning |
| memory load (`byProject`) throws | provider returns null → no shadow run |
| reader construction throws | caught → null → no shadow run |
| `summarizeForCognition` throws | swallowed (existing runner) → no event |
| summary not `advisoryOnly===true` | rejected/dropped (existing) → no event |
| reader/snapshot stale | built per-deliberation → fresh; if cached, TTL/version guard; stale data is advisory-only and cannot affect decisions |
| ledger read fails | empty observations; continue |
| event/receipt publish throws | caught; deliberation unaffected |

Invariant: no failure path can alter or block the cognition decision.

## Rollback switches (two independent, both fail-closed)

1. `IKBI_RUNTIME_TRUTH=off` — disables shadow mode for all agents (overrides the Ricky default).
2. Unset/remove `IKBI_RUNTIME_TRUTH_READER_MODULE` (or delete the adapter) — no reader loads → inert.

Either alone returns ikbi to pure normal behavior with zero Runtime Truth involvement.

## Staleness strategy

Build the reader **per deliberation** from current `byProject(project)` (default). If profiling shows
cost, allow a short **TTL/version snapshot cache** keyed by `(project, memory-version)` with a bounded
entry count. Because shadow output never touches decisions, a stale snapshot is at worst a slightly
outdated advisory log, never a wrong action.

## Test plan (ikbi-side, STUB adapter — no real TF in ikbi tests)

- mapper: `MemoryEntry → MemoryRecord` correctness (namespace/subject/text/agent).
- loader: unset module → no provider; import failure → fail-closed; valid stub module → provider returned.
- provider: builds reader from stub records; memory-load throw → null; construction throw → null.
- decisions **unchanged**: deep-equal decision with/without provider, and with a throwing provider.
- Ricky → provider consulted; Bubbles/Julian → mode off → provider never consulted.
- rollback: `IKBI_RUNTIME_TRUTH=off` with provider present → no shadow run.
- logging: valid run → both `cognition.decided` + `cognition.runtime_truth_shadow`; optional receipt
  fields incl. `divergence`; no action/approval/install fields.
- boundary: ikbi source imports no `truth-firewall` (dynamic specifier string, not a static import);
  no writes except event/optional receipt.

## Proof plan (scratchpad)

1. ikbi unit/integration with a **stub** adapter module (no TF): shadow event reflects stub memory;
   decisions unchanged; rollback works.
2. Scratchpad E2E with a **real** adapter importing TF: feed a small lab-context-memory set incl. a
   contradiction; show `cognition.runtime_truth_shadow` reports `INCONSISTENT`/contradiction drift
   while the cognition decision is byte-identical to the no-reader run; flip `IKBI_RUNTIME_TRUTH=off`
   → no shadow.
3. Confirm only the event/optional receipt are written; no memory/proposal mutation; full `pnpm test`
   green.

## Recommended commit breakdown (each gated)

1. **cognition: per-deliberation provider** — add optional `runtimeTruthProvider`; call it in shadow
   mode (replacing/augmenting the static `runtimeTruth`). Tests. *(ikbi, no TF)*
2. **mapper + loader** — `MemoryEntry→MemoryRecord` mapper + the fail-closed dynamic-import loader
   reading `IKBI_RUNTIME_TRUTH_READER_MODULE`. Tests with a stub module. *(ikbi, no static TF)*
3. **composition-root wiring** — `src/cli/index.ts` builds the provider for shadow agents (Ricky) and
   passes it through `createCognitionRouter`; env config + optional receipt. Tests. *(ikbi)*
4. **operator adapter (separate, outside ikbi standalone)** — the tiny module importing TF's
   `createRuntimeTruthReader` and exporting `createReaderProvider`. *(lab bridge / operator file — the
   only TF importer)*
5. **docs/runbook + scratchpad E2E proof.**

## Explicit do-NOT-build list

- ❌ No static `import` of Truth Firewall anywhere in ikbi source (dynamic, configured specifier only).
- ❌ No path where Runtime Truth changes or blocks a cognition decision (advisory-only, always).
- ❌ No memory/proposal writes, no approvals, no installs, no enforcement, no execution of `recommendedNext`.
- ❌ No auto-enable for Bubbles/Julian (Ricky-only default; others require explicit env).
- ❌ No unbounded/synchronous heavy memory scan blocking deliberation (build off the already-fetched `byProject` slice).
- ❌ No cache without a TTL/version guard (staleness must be bounded).
- ❌ No reading/writing the TF store beyond the optional **read-only** ledger path.
- ❌ No making the adapter a required ikbi build/runtime dependency (must stay optional + fail-closed).

## Confirmation

This is **design only**. No code was written, no adapter implemented, no Truth Firewall or agent-repo
change made. Production reader injection (commits 1–4 above) is future, gated work — not part of this
receipt.
