# ikbi Runtime INFLUENCE Report

The third dimension of runtime truth (after reachability + frequency): not just *whether* or
*how often* a module ran, but whether its output actually **changed a decision** — flipped a
gate, blocked a promote, refused a command, moved a trust tier. Presence ≠ power. Read from the
decision-bearing receipt stream (the outcome reachability discards), not coverage.

Receipts analyzed: 2353 (2129 decision-bearing)  ·  source: state/receipts/receipts.ndjson

## Bands

- **pivotal** — flipped ≥1 decision and steers sharply (≥25% of its decisions, or an event gate)
- **active** — flipped ≥1 decision, but only occasionally (<25%)
- **passive** — held decision authority but flipped NOTHING here (rubber-stamped the happy path)
- **latent** — a decision module that emitted no decision receipts this corpus

- pivotal: 5
- active: 0
- passive: 1
- latent: 1

## Per-module influence

| module | band | decisions | interventions | rate | decision ops (intervened/total) |
| --- | --- | --- | --- | --- | --- |
| modules/governed-exec | pivotal | 1079 | 401 | 37% | govexec.run 401/1079 |
| modules/dependency-install | pivotal | 244 | 216 | 89% | depinstall.run 216/244 |
| core/trust | pivotal | 43 | 43 | 100% | trust.transition 43/43 |
| modules/worker-model | pivotal | 36 | 22 | 61% | worker.role.verifier 11/25; worker.trust.signal_suppressed 11/11 |
| core/workspace | pivotal | 8 | 8 | 100% | workspace.promote 8/8 |
| modules/gate-wall | passive | 719 | 0 | 0% | gate.evaluate 0/719 |
| modules/drift-prevention | latent | 0 | 0 | 0% | — |

> **passive / latent** authority is the entry point for dimension 4 (value/ablation): a gate
> that never bit in this corpus is where you ask "would the outcome change if it didn't exist?"
