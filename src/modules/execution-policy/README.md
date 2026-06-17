# execution-policy — Dependency Boundary Module

## Purpose

This module exists to break the circular dependency between **gate-wall**,
**governed-exec**, and **worker-model**. It holds the shared contracts and
policy functions that all three modules reference, imported only from the
frozen core (never from the three modules themselves, except for type-only
references to worker-model contract types).

## Dependency Direction

```
                    ┌─────────────────────┐
                    │   frozen core       │
                    │ (identity, trust,   │
                    │  workspace, receipt) │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │  execution-policy   │
                    │ (contracts + risk)  │
                    └──┬──────┬───────┬───┘
                       │      │       │
            ┌──────────▼┐  ┌──▼────┐  │
            │ gate-wall  │  │ gov-  │  │
            │ (evaluator)│  │ exec  │  │
            └─────┬──────┘  └──┬────┘  │
                  │            │       │
                  └──────┬─────┘       │
                         │             │
                  ┌──────▼─────────────▼───┐
                  │     worker-model       │
                  │ (orchestrator + roles) │
                  └────────────────────────┘
```

**Allowed imports (arrows mean "may import from"):**
- `execution-policy` → frozen core + `worker-model/contract.ts` (type-only)
- `gate-wall` → `execution-policy` (contracts + risk)
- `governed-exec` → `execution-policy` (GateWall type) + `gate-wall` (runtime singleton)
- `worker-model` → `execution-policy` + `gate-wall` + `governed-exec`

**Forbidden imports (the old cycle):**
- ❌ `gate-wall` → `governed-exec` (was: `commandPolicyDenyReason`)
- ❌ `gate-wall` → `worker-model` (was: `RoleResult`, `WorkerTask` types)
- ❌ `governed-exec` → `gate-wall` for types (singleton import is OK)

## Contents

| File | What it holds |
|------|---------------|
| `contract.ts` | `GateWall`, `GateWallAction`, `GateWallEvaluateInput`, `RoleResult`, `WorkerTask` types |
| `risk.ts` | `commandPolicyDenyReason` — command-effect policy (git push, find -exec, etc.) |
| `boundary.test.ts` | Dependency-boundary tests that verify the cycle stays broken |

## Re-export shims

For backward compatibility, the original modules re-export from this layer:
- `gate-wall/contract.ts` → re-exports all types from `execution-policy/contract.ts`
- `governed-exec/policy.ts` → re-exports `commandPolicyDenyReason` from `execution-policy/risk.ts`

Existing imports (`from "../gate-wall/contract.js"`, `from "../governed-exec/policy.js"`)
continue to work without changes.

## Adding new shared policy

If a new policy function or contract type needs to be shared between
gate-wall, governed-exec, and worker-model, put it here — not in any of
the three modules. This module is the neutral ground.
