# ikbi Runtime-Reachability Self-Coverage Report

Ground-truth signal: V8 code coverage per surface, minus a construction floor
(the CLI loaded doing nothing). What executes ABOVE the floor is genuine operation,
not import-time singleton construction. Grep/static import scans are NOT used — they
gave false confidence three times in the audit that motivated this report.

Surfaces exercised: doctor, capabilities, models, providers, receipts, cost, summary, detect, recover, kill-status, workspace-ls, audit, classify, build, fix, cognition, batch, trust-status, spec-create, spec-list, job-cards, memory, agents, repos, monitor, health, doctor-selfrepair, heal, evaluate, build-competitive, consult, server

## Summary

Runtime-reached (coverage-proven this run):
- **LIVE-BUILD**: 23
- **LIVE-COGNITION**: 6
- **LIVE-COMMAND**: 8
- **DIAGNOSTIC-ONLY**: 1

Not reached this run — sub-classified by static evidence:
- **CONDITIONAL**: 2
- **DORMANT-LABELED**: 7
- **TRUE-ORPHAN**: 0

- total module dirs: 47

## Where each module operates (surfaces / evidence)

| module | class | surfaces (op-fn count) / note |
| --- | --- | --- |
| batch-planner | LIVE-BUILD | batch:15 |
| cache | LIVE-BUILD | classify:7, build:7, fix:7, batch:7, evaluate:7, build-competitive:7, consult:7 |
| check-triage | LIVE-BUILD | build:9, fix:10, batch:9, build-competitive:9 |
| cognition-layer | LIVE-BUILD | build:8, cognition:1, build-competitive:8 |
| dependency-install | LIVE-BUILD | build:6, batch:6, build-competitive:6 |
| deterministic-judge | LIVE-BUILD | build-competitive:12 |
| drift-prevention | LIVE-BUILD | build:3, build-competitive:3 |
| egress | LIVE-BUILD | classify:9, build:9, fix:9, cognition:9, batch:9, evaluate:9, build-competitive:9, consult:9 |
| escalation | LIVE-BUILD | build:9, batch:9, build-competitive:1 |
| execution-policy | LIVE-BUILD | build:6, fix:4, cognition:4, batch:6, build-competitive:6 |
| gate-wall | LIVE-BUILD | build:4, fix:4, cognition:4, batch:4, build-competitive:4 |
| governed-exec | LIVE-BUILD | doctor:2, build:19, fix:18, cognition:11, batch:21, doctor-selfrepair:2, build-competitive:19 |
| hooks | LIVE-BUILD | build:2, batch:2, build-competitive:2 |
| kill-switch | LIVE-BUILD | kill-status:4, build:1, batch:1, build-competitive:1 |
| lab-context-memory | LIVE-BUILD | build:5, build-competitive:5 |
| mcp-model-loop | LIVE-BUILD | build:3, cognition:4, batch:3, build-competitive:3 |
| memory-governor | LIVE-BUILD | build:1, memory:1, build-competitive:1 |
| project-index | LIVE-BUILD | build:42, batch:42, build-competitive:42, consult:47 |
| project-retrieval | LIVE-BUILD | build:3, batch:3, build-competitive:3, consult:7 |
| runtime-truth-shadow | LIVE-BUILD | build:1, build-competitive:1 |
| step-planner | LIVE-BUILD | build:10, spec-create:3, build-competitive:10 |
| verification-ladder | LIVE-BUILD | build:10, batch:10, build-competitive:10 |
| worker-model | LIVE-BUILD | doctor:3, capabilities:1, build:156, fix:60, cognition:15, batch:155, repos:1, doctor-selfrepair:10, evaluate:28, build-competitive:138, server:1 |
| agent-tools | LIVE-COGNITION | cognition:2 |
| chat | LIVE-COGNITION | cognition:88, doctor-selfrepair:28, server:3 |
| consult | LIVE-COGNITION | consult:15 |
| model-evaluation | LIVE-COGNITION | consult:4 |
| model-router | LIVE-COGNITION | consult:8 |
| project-detection | LIVE-COGNITION | doctor:11, detect:10, cognition:12, doctor-selfrepair:9 |
| agent-router | LIVE-COMMAND | classify:14, agents:4 |
| capability-client | LIVE-COMMAND | classify:7 |
| job-cards | LIVE-COMMAND | job-cards:2, server:5 |
| repo-doctor | LIVE-COMMAND | health:19, server:21 |
| self-monitor | LIVE-COMMAND | monitor:2, heal:1 |
| self-repair | LIVE-COMMAND | doctor-selfrepair:29 |
| spec-artifact | LIVE-COMMAND | spec-create:9, spec-list:3 |
| trust | LIVE-COMMAND | trust-status:4 |
| capability-recovery | DIAGNOSTIC-ONLY | recover:8 |
| correction-library | CONDITIONAL | imported by /src/modules/index.ts — trigger not exercised |
| lsp | CONDITIONAL | imported by /src/modules/agent-tools/lsp-tools.ts — trigger not exercised |
| capability-registry | DORMANT-LABELED | @status dormant |
| context-packets | DORMANT-LABELED | @status dormant |
| labmem-recall | DORMANT-LABELED | @status dormant |
| recovery | DORMANT-LABELED | @status library-only |
| self-heal | DORMANT-LABELED | @status library-only |
| self-observation | DORMANT-LABELED | @status dormant |
| subagent-spawning | DORMANT-LABELED | @status dormant |

## TRUE-ORPHAN detail — declared modules wired NOWHERE (no runtime path, no importer, no @status label)

_none_ — every module is reached, conditionally reachable, or honestly labeled dormant.

## CONDITIONAL detail — reachable via a live importer, but the trigger was not exercised this run

- `correction-library` — imported by /src/modules/index.ts — trigger not exercised
- `lsp` — imported by /src/modules/agent-tools/lsp-tools.ts — trigger not exercised
