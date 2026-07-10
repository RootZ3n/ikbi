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
| B1a | C4 | git read-only ALLOWLIST for model commands (clone/fetch/reset/clean/archive denied) | ✅ 20b5527 |
| B1b | C4 | deny interpreter inline-eval (`python3 -c`, ruby/perl/php) — `-m` module stays allowed | ✅ 144ee8e |
| B1c | C4 | REMAINING: isolate `$HOME` in bwrap (bind only declared toolchain inputs ro); context-loader fd revalidation (`O_NOFOLLOW`/lstat + root-relative realpath) — deeper, own pass | ⬜ |
| B2 | C11 | lockfile fetch-target validation vs registry allowlist; VCS deps denied unless opted in. FOLLOW-UP: per-run stores, content-address verify, no cred URLs in receipts | ✅ 7ddc93d |
| B3 | C12 | self-heal + MCP stdio: secret-scrubbed env, process-group teardown, wall-clock + output bounds, bounded JSON line. FOLLOW-UP: full governed-exec routing | ✅ 901fbae |
| B4 | H9 | repo-doctor: canonical allowlisted-root confinement (403 outside) + per-path cache; auth via C6 mount. FOLLOW-UP: file/byte/time limits + async | ✅ 128c692 |
| B5 | H5 | capability/luak/howa route through the egress guard (fail-closed). FOLLOW-UP: streaming byte ceiling + end-to-end deadline across retries | ✅ fc2cad1 |

## Workstream C — authoritative promotion (the structural core; supersedes adjudication Steps 3-full/4)

One service: **snapshot → integrate → verify(immutable tree) → adjudicate(pure) → CAS-promote**.

| ID | Finding | Fix | State |
|----|---------|-----|-------|
| C1a | C1 | `computeWorkProduct.nonEmpty` = `candidateTree !== baseTree` (throwaway index incl. untracked), NOT `git status` | ✅ 7ee6861 |
| C1b | C1 | remove boolean `accumulatedPass`; evidence must be executed + tree-bound | ✅ 7ee6861 |
| C1c | C1 | branded, hash-bound promotion authorization: `WorkspaceManager.promote()` accepts `verifiedAgainst {targetHead, integratedTree}`, refuses on moved-target / tree-mismatch (fail-closed, optional). FOLLOW-UP: thread it into the call sites + re-verify loop = Cx | ✅ f1ac6d3 |
| C3 | C3 | deterministic judge disqualifies zero/absent/unverified evidence (LAYER-1 override, not down-rank); ranks only admissible; aligned with the single-run integrator "executed"-required gate; judge grants no promotability | ✅ 2ba6cbf |
| C7 | C7 | batch workers produce retained candidates only; replay into ONE integration workspace; conflict check + full verify combined tree; adjudicate once; one promote | ⬜ |
| Cx | — | funnel single/competitive/tournament/batch/chat-apply/self-heal through the one terminal executor; make Adjudication Core authoritative (flip `IKBI_LEGACY_COMPLETION`, land I1–I9 guard tests); thread C1c `verifiedAgainst` into every promote + re-verify on moved target | ⬜ |

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
| E5 | M3 | trust MAC: post-MAC schema validation (version/tiers/counters/timestamps/arrays) — fail closed | ✅ b2203cd |
| E6 | M4 | event-bus: contain throwing predicates (fail-closed no-match); clamp maxQueue ≥ 1 | ✅ 3e306d4 |
| E7 | M6 | step-planner: report droppedSteps (no silent truncation). FOLLOW-UP: capability-registry absolute roots + non-lexical symlink containment | ✅ 8e2a430 (partial) |
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
