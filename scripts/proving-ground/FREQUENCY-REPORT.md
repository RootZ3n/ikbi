# ikbi Runtime FREQUENCY Report

The second dimension of runtime truth (after reachability): not just *was* a module executed,
but in HOW MANY of the exercised surfaces, and how INTENSELY. Aggregated from the per-surface
operational matrix (V8 coverage minus a construction floor) — no grep, no static guesses.

Surfaces aggregated (32): doctor, capabilities, models, providers, receipts, cost, summary, detect, recover, kill-status, workspace-ls, audit, classify, build, fix, cognition, batch, trust-status, spec-create, spec-list, job-cards, memory, agents, repos, monitor, health, doctor-selfrepair, heal, evaluate, build-competitive, consult, server

## Bands

- **ubiquitous** — operates in EVERY exercised surface (core infrastructure)
- **common** — operates in ≥ half the surfaces
- **narrow** — operates in several surfaces but < half
- **single** — operates in exactly ONE surface (a candidate for influence/ablation scrutiny)
- **unused** — loaded this run but operated in no surface (0 op-fns above the floor)

- ubiquitous: 0
- common: 0
- narrow: 28
- single: 10
- unused: 6

## Per-module frequency + intensity

| module | band | surfaces | freq | maxOp | avgOp | where |
| --- | --- | --- | --- | --- | --- | --- |
| worker-model | narrow | 11/32 | 34% | 156 | 51.6 | doctor, capabilities, build, fix, cognition, batch, repos, doctor-selfrepair, evaluate, build-competitive, server |
| egress | narrow | 8/32 | 25% | 9 | 9 | classify, build, fix, cognition, batch, evaluate, build-competitive, consult |
| governed-exec | narrow | 7/32 | 22% | 21 | 13.1 | doctor, build, fix, cognition, batch, doctor-selfrepair, build-competitive |
| cache | narrow | 7/32 | 22% | 7 | 7 | classify, build, fix, batch, evaluate, build-competitive, consult |
| execution-policy | narrow | 5/32 | 16% | 6 | 5.2 | build, fix, cognition, batch, build-competitive |
| gate-wall | narrow | 5/32 | 16% | 4 | 4 | build, fix, cognition, batch, build-competitive |
| project-index | narrow | 4/32 | 13% | 47 | 43.3 | build, batch, build-competitive, consult |
| project-detection | narrow | 4/32 | 13% | 12 | 10.5 | doctor, detect, cognition, doctor-selfrepair |
| check-triage | narrow | 4/32 | 13% | 10 | 9.3 | build, fix, batch, build-competitive |
| project-retrieval | narrow | 4/32 | 13% | 7 | 4 | build, batch, build-competitive, consult |
| kill-switch | narrow | 4/32 | 13% | 4 | 1.8 | kill-status, build, batch, build-competitive |
| mcp-model-loop | narrow | 4/32 | 13% | 4 | 3.3 | build, cognition, batch, build-competitive |
| chat | narrow | 3/32 | 9% | 88 | 39.7 | cognition, doctor-selfrepair, server |
| step-planner | narrow | 3/32 | 9% | 10 | 7.7 | build, spec-create, build-competitive |
| verification-ladder | narrow | 3/32 | 9% | 10 | 10 | build, batch, build-competitive |
| escalation | narrow | 3/32 | 9% | 9 | 6.3 | build, batch, build-competitive |
| cognition-layer | narrow | 3/32 | 9% | 8 | 5.7 | build, cognition, build-competitive |
| dependency-install | narrow | 3/32 | 9% | 6 | 6 | build, batch, build-competitive |
| hooks | narrow | 3/32 | 9% | 2 | 2 | build, batch, build-competitive |
| memory-governor | narrow | 3/32 | 9% | 1 | 1 | build, memory, build-competitive |
| repo-doctor | narrow | 2/32 | 6% | 21 | 20 | health, server |
| agent-router | narrow | 2/32 | 6% | 14 | 9 | classify, agents |
| spec-artifact | narrow | 2/32 | 6% | 9 | 6 | spec-create, spec-list |
| job-cards | narrow | 2/32 | 6% | 5 | 3.5 | job-cards, server |
| lab-context-memory | narrow | 2/32 | 6% | 5 | 5 | build, build-competitive |
| drift-prevention | narrow | 2/32 | 6% | 3 | 3 | build, build-competitive |
| self-monitor | narrow | 2/32 | 6% | 2 | 1.5 | monitor, heal |
| runtime-truth-shadow | narrow | 2/32 | 6% | 1 | 1 | build, build-competitive |
| self-repair | single | 1/32 | 3% | 29 | 29 | doctor-selfrepair |
| batch-planner | single | 1/32 | 3% | 15 | 15 | batch |
| consult | single | 1/32 | 3% | 15 | 15 | consult |
| deterministic-judge | single | 1/32 | 3% | 12 | 12 | build-competitive |
| capability-recovery | single | 1/32 | 3% | 8 | 8 | recover |
| model-router | single | 1/32 | 3% | 8 | 8 | consult |
| capability-client | single | 1/32 | 3% | 7 | 7 | classify |
| model-evaluation | single | 1/32 | 3% | 4 | 4 | consult |
| trust | single | 1/32 | 3% | 4 | 4 | trust-status |
| agent-tools | single | 1/32 | 3% | 2 | 2 | cognition |
| context-packets | unused | 0/32 | 0% | 0 | 0 | — |
| correction-library | unused | 0/32 | 0% | 0 | 0 | — |
| lsp | unused | 0/32 | 0% | 0 | 0 | — |
| recovery | unused | 0/32 | 0% | 0 | 0 | — |
| self-observation | unused | 0/32 | 0% | 0 | 0 | — |
| subagent-spawning | unused | 0/32 | 0% | 0 | 0 | — |
