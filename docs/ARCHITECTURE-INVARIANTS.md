# Ikbi Architecture Invariants

This document states the invariants Ikbi should preserve while reducing module
sprawl. They are written as audit rules: each one should be provable from live
entrypoints, not just comments or isolated unit tests.

## Runtime Invariants

1. One activation seam: production CLI and server startup load `src/modules/index.ts`
   before exposing commands or routes.
2. One config seam: runtime configuration flows through `src/core/config.ts` or a
   module config object; direct `process.env` reads are allowed only for explicitly
   documented per-request secrets or test seams.
3. One model registry: model switching and role routing validate against the same
   provider registry and configured route availability.
4. One egress boundary: outbound model/web traffic must resolve through the egress
   guard or clearly document an exception.
5. One command execution boundary: shell/test/package execution must use governed
   execution or require explicit operator approval with a clear rollback limitation.

## Workspace And Recovery Invariants

1. The build spine edits managed workspaces, never the target repo directly.
2. Promotion is explicit, governed, and receipt-backed.
3. Failed useful work is retained or explicitly discarded; it is not silently lost.
4. Workspace list, diff, discard, clean, and undo must operate on the same durable
   workspace records.
5. Interactive editing must either use the same workspace lifecycle or disclose that
   it is live-direct/scratch and provide durable rollback for the covered mutations.
6. Rollback must be honest about its coverage. If terminal/delegate/package actions
   are not captured, the operator and model must be told.

## Verification Invariants

1. A build can report success only after objective verification evidence is present.
2. Verification scope must be surfaced: full, impact, legacy, fallback, skipped, or
   degraded.
3. Large-repo retrieval/index fallback must be visible and should fail closed when
   the degraded context would mislead the operator.
4. Model prose is never verification evidence by itself.
5. Builder checks and verifier checks should resolve from the same check policy.

## Interface Invariants

1. `doctor` is the readiness source of truth. It must not say ready when the default
   production path cannot build, verify, reach models, or enforce configured safety.
2. `/status`, `/capabilities`, and REPL `/status` must disclose weaker semantics:
   ephemeral sessions, scratch workdirs, live-direct edits, legacy verification,
   index fallback, disabled build path, or missing auth.
3. HTTP and TUI capabilities must not imply persistence or lifecycle guarantees that
   are absent at runtime.
4. CLI bare-goal routing must not silently perform a stronger action than the
   operator requested.
5. Read-only commands should remain frictionless; mutating commands default to no
   unless the operator explicitly opted into automation.

## Test Invariants

1. Unit tests may prove helpers, but product guarantees require at least one test
   through the live adapter or production-shaped construction.
2. A test using fake collaborators must state which production guarantee it does
   not prove.
3. Import-surface tests prove absence of dependencies only; they do not prove
   runtime behavior.
4. Capability/tool parity tests prove inventory, not semantic parity.
5. Historical audit docs and comments are not evidence of current behavior.

## Anti-Honeycomb Invariants

1. There should be one preferred coding lifecycle. Other paths are adapters over it
   or explicitly marked experimental.
2. There should be one durable session/workspace state model per product promise.
3. There should be one recovery vocabulary: diff, apply/promote, discard, rollback,
   undo, retain.
4. There should be one status vocabulary: ready, degraded, fallback, ephemeral,
   managed, live-direct, scratch, retained, promoted, discarded.
5. New modules must declare which product-spine step they strengthen before they are
   added to the activation barrel.

