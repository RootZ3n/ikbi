# ikbi Terminal Productization Sprint

**Source:** GPT
**Date:** 2026-06-23
**Status:** Queued — pending user dispatch

## Philosophy

Not more trust mechanics. Not more architecture unless required. Focus on:

## The List

1. **Smoother onboarding** — first-time user experience, no friction
2. **Better doctor** — `ikbi doctor` should catch and explain real issues
3. **Better first-run setup** — `ikbi init` should be bulletproof
4. **Clearer command help** — contextual help for all commands (15/~30 done, 15 to go)
5. **Better project detection** — auto-detect language, framework, tooling
6. **Cleaner failure messages** — every error should tell the user what to do next
7. **Spec/job cards** — tighten the spec and job-card workflows
8. **Mission Control integration** — wire into the lab's Mission Control surface
9. **Repeatable build templates** — common project scaffolds
10. **"What happened / what next" UX** — after every action, tell the user what just happened and what they should do next

## Context

ikbi has a credible engine (verified by 6 audits: Julian, Bubbles, Codex, MiniMax M3, GLM 5.2, Julian consolidated). The remaining gaps are product surface, not architecture. This sprint is about making ikbi pleasant enough that future-you actually wants to use it every day.

## Prior Art

- REPL as default path — DONE (commit 14dabde)
- `ikbi init` guided setup — DONE (commit 2e3bb5c)
- `ikbi help` focused — DONE (6 commands → 15 commands)
- `ikbi models --recommend` — DONE (4 tiers)
- `ikbi repl --quiet` — DONE (model-output-only)
- Error translation layer — DONE (src/core/errors/)
- Context manager — DONE (src/core/context/)
- Contextual help — PARTIALLY DONE (15/~30 commands)

## Remaining from this sprint

- 15 more help pages
- `ikbi doctor` improvements
- Project detection (auto-detect language/framework)
- Spec/job card workflow tightening
- Mission Control integration
- Repeatable build templates
- "What happened / what next" UX pattern
- Failure message improvements
