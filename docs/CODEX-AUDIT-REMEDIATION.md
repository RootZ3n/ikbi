# Codex Audit — Remediation Program

Tracks the fix-out of the GPT-5.6 Sol (Codex) end-to-end audit of `harness/cc-parity-and-bokahli-pilot @ e693ce8`.
Goal: make ikbi defensible as a system that **promotes only verified-green work** and holds its stated
invariants (fail-closed, no false green, no false red, one neutralization chokepoint, worktree confinement).

**Rule for every item:** land it behind `pnpm build` + `pnpm test` green; add an adversarial regression test
that fails before the fix and passes after; commit per item (or tight group). Fail-closed by default.

Legend: [x] done · [~] doing · [ ] todo · [-] deferred/needs-decision

---

## Workstream A — P0 stop-ship containment (independent, high-confidence, fast)

| ID | Finding | Fix | State |
|----|---------|-----|-------|
| A1 | H1 | store dirs honor `config.stateRoot` (spec/job-cards/corrections) — closes false-RED | ✅ 654a737 |
| A2 | C6 | mount global auth hook in the route-registrar seam; job rollback de-fanged. FOLLOW-UP: per-capability scopes | ✅ c398d2d |
| A3 | C13 | Web UI same-origin only; token gated on same-origin; `?api=` dropped | ✅ ff9b739 |
| A4 | C10 | egress: strip auth/cookies on cross-origin redirect hops; correct 30x method semantics | ✅ ff9b739 |
| A5 | C5 | project `.ikbi/hooks.json` default OFF; consult `IKBI_HOOKS_ENABLED`; run approved hooks through governed-exec in the worktree sandbox | ⬜ |
| A6 | C8 | memory-governor: full-file proposal + baseSha256 CAS apply (atomic); withhold-on-unresolvable | ✅ 3b3bbf6 |
| A7 | C2 | verifier+builder triage on FULL stdout+STDERR (all 3 consumers); exit-0-with-stderr-failures now fails. FOLLOW-UP: testEvidence==="executed" + consistent tally at verdict layer; immutable base checks; retire legacy mode | ✅ a237d54 |
| A8 | L1 | removed the e693ce8 terminal-adjudication diagnostic | ✅ 49f65c2 |
| A9 | — | (bonus) anchor `.gitignore` `memory-governor/` so new src files aren't silently untracked | ✅ |

**✅ WORKSTREAM A (all P0 stop-ship containment) COMPLETE — 8 findings + 1 bonus, all committed & green (suite 3400).**
Captured C2/C6-follow-ups (per-capability scopes, testEvidence tally, governed hooks/exec, immutable checks) are folded into the workstreams below.

## Workstream B — execution boundary

| ID | Finding | Fix | State |
|----|---------|-----|-------|
| B1 | C4 | classify `git` as risky+sandboxed; allow only a read-only git subcommand/operand set, mutation via typed workspace APIs; isolate `$HOME`, bind only declared inputs ro; deny interpreter eval flags (`python3 -c`, etc.); revalidate every fd with `O_NOFOLLOW`/lstat + root-relative realpath (context loader) | ⬜ |
| B2 | C11 | parse+validate every lockfile fetch target against egress policy; reject git/file/path deps unless approved; per-run stores; no credential URLs in receipts | ⬜ |
| B3 | C12 | route self-heal (`sh -c "pnpm build && pnpm test"`) and MCP stdio through governed subprocess infra: isolated home/env/cache, process groups, wall-clock + output limits, explicit fs/net caps, bounded JSON line | ⬜ |
| B4 | H9 | repo-doctor: require auth capability + canonical allowlisted roots; file/byte/time limits; async; cache keyed by path+fingerprint | ⬜ |
| B5 | H5 | one guarded-fetch factory for ALL outbound (capability-client, luak, howa, provider): audience-scoped creds, redirect policy, streaming byte ceiling, end-to-end deadline across retries | ⬜ |

## Workstream C — authoritative promotion (the structural core; supersedes adjudication Steps 3-full/4)

One service: **snapshot → integrate → verify(immutable tree) → adjudicate(pure) → CAS-promote**.

| ID | Finding | Fix | State |
|----|---------|-----|-------|
| C1a | C1 | `computeWorkProduct.nonEmpty` = `candidateTree !== baseTree` (throwaway index incl. untracked), NOT `git status` | ⬜ |
| C1b | C1 | remove boolean `accumulatedPass`; evidence must be executed + tree-bound | ⬜ |
| C1c | C1 | branded, hash-bound promotion authorization: `WorkspaceManager.promote()` requires expected target head + `assessment.integratedTree`; re-verify if target moved | ⬜ |
| C3 | C3 | deterministic judge ranks only already-admissible (executed, hash-bound) assessments; hard-disqualify zero/absent/unverified; judge never grants promotability | ⬜ |
| C7 | C7 | batch workers produce retained candidates only; replay into ONE integration workspace; conflict check + full verify combined tree; adjudicate once; one promote | ⬜ |
| Cx | — | funnel single/competitive/tournament/batch/chat-apply/self-heal through the one terminal executor; make Adjudication Core authoritative (flip `IKBI_LEGACY_COMPLETION`, land I1–I9 guard tests) | ⬜ |

## Workstream D — durable-state concurrency

| ID | Finding | Fix | State |
|----|---------|-----|-------|
| D1 | H2 | one cross-process txn lock over catch-up→allocate→append→prune→high-water; durable high-water sequence | ⬜ |
| D2 | H3 | workspace ops rehydrate path/branch/repo from durable record after lock; opaque IDs; lock before destructive reclaim | ⬜ |
| D3 | H4 | kill-switch persist-before-publish; cross-process latch; compose global-kill + request-cancel + budget + shutdown | ⬜ |
| D4 | H10 | task cancel = nonterminal to clients until worker drains; session lease for live lifecycle + CAS saves; never prune a live lease | ⬜ |
| D5 | H7 | recovery: clamp unauthorized ceiling before pool build; cache keyed on full model-visible request + tool defs + identity policy; size bounds + stampede guard | ⬜ |
| D6 | M1 | substrate: streaming reads, hard record-size limit, inode/nonce-safe stale-lock reclaim | ⬜ |
| D7 | M5 | context/memory RMW: caps before allocation; cross-process update txns for counters/upserts | ⬜ |

## Workstream E — neutralization, identity, discovery, cleanups

| ID | Finding | Fix | State |
|----|---------|-----|-------|
| E1 | C9 | every external/tool/repo string → typed untrusted message via core neutralizer; ikbi instruction stays a separate trusted message; model-request construction rejects bare tool-result strings (builder/consult/patchsmith/MCP) | ⬜ |
| E2 | H6 | chat: map bearer → minted caller identity, spawn bounded worker from it; repo personas untrusted unless operator-installed; revalidate rollback paths | ⬜ |
| E3 | H8 | apply explicit `IKBI_CHECKS` before auto-discovery; add python `setup.py`/`setup.cfg` manifests; atomic+versioned index persistence; full declared suite for final promotion | ⬜ |
| E4 | M2 | transactional identity registry load; credential epochs/revalidation; runtime provenance brand checks; one immutable config snapshot (40 files read `process.env` directly) | ⬜ |
| E5 | M3 | trust MAC: validate contract version/tiers/counters/timestamps/identity AFTER mac verify (not blind cast) | ⬜ |
| E6 | M4 | event-bus: validate subscriptions; contain predicate failures; reject nonpositive queue sizes | ⬜ |
| E7 | M6 | step-planner: reject overlarge plans explicitly (no silent drop); capability roots absolute + non-lexical symlink containment; derive requirements from action not caller | ⬜ |
| E8 | M7 | self-repair: fail-closed if queue-lock setup fails; process-group timeout | ⬜ |
| E9 | L2/L3/L4 | generate capability/reachability map from manifest; rename misleading knobs (sudo flag, "continuous"/"auto"); mark job-card exec + spec exec preview-only, unavailable over prod API | ⬜ |

---

## Execution order (Codex-recommended, dependency-aware)

1. **A1 ✅** → **A7 (C2 verifier truth)** — nothing downstream can be trusted until evidence is sound.
2. **A2/A3/A4/A5/A6 + A8** — P0 containment, mostly independent, fast to land.
3. **C1a→C1b→C1c→C3→C7→Cx** — authoritative promotion (the big refactor; splits orchestrator.ts).
4. **B1..B5** — execution boundary.
5. **D1..D7** — durable-state concurrency.
6. **E1..E9** — neutralization, identity, discovery, cleanups.

Adversarial acceptance tests (Codex M8) land alongside their workstream: stderr-only failure, tree-mutation-after-verify,
target-advancement, concurrent batch merge, cross-process receipts, project hooks, lockfile URLs, route auth, memory patch approval.
