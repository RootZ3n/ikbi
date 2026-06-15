# Ikbi Daily Driver Polishing Plan

**Goal:** Move Ikbi from READY_FOR_LIMITED_DAILY_USE to READY_FOR_DAILY_USE.
**Baseline:** Codex blockers fixed, 1818/1818 tests green, L1-L5 proven.
**Current recommendation:** READY_FOR_LIMITED_DAILY_USE.

---

## Phase 1 — L6 Limited Daily Driver Gauntlet
**Status:** ⏳ PENDING
**Depends on:** hardening-sprint-codex committed

Prove hardening fixes work outside unit tests using ugly real-world scenarios.

### Scenarios (20)
1. Clean TypeScript repo, small change
2. Dirty repo (must refuse or ask for cleanup)
3. Repo with failing tests before start
4. Wrong package manager / missing package manager
5. Rust repo without allowlisted cargo
6. Go repo without allowlisted go
7. Python repo without pytest/config
8. Large command output
9. Interrupted build
10. Denied gate-wall promotion
11. Missing/failed receipt simulation
12. Stale workspace lock
13. Live workspace lock
14. REPL /apply with approval
15. REPL /apply denied by gate
16. Terminal escape attempts (ls .., find .., grep x ../file, symlink outside workspace)
17. Orphan worktree cleanup
18. Undo after promotion
19. Undo after receipt failure
20. Cost report after build

### Exit Criteria
- No false success claims
- No unreceipted promotion
- No workspace escape
- No wrong-repo verification
- No silent failure
- Undo works
- Receipts are understandable
- Operator can explain what happened after each run

### Output
L6_DAILY_DRIVER_GAUNTLET.md

---

## Phase 2 — Operator Experience Polish
**Status:** ⏳ PENDING
**Depends on:** Phase 1 complete

Make Ikbi comfortable enough to use repeatedly without confusion.

### Work
- CLI status output improvements
- Receipt views (--latest, --task, --workspace, --promotions, --failures, --costs)
- Diff improvements (what/why/verified/staged)
- Failure message improvements
- "Next command" hints

### Exit Criteria
A tired human can use Ikbi after work without inspecting source code.

---

## Phase 3 — Receipt and Audit Trail Polish
**Status:** ⏳ PENDING
**Depends on:** Phase 1 complete

Make receipts the trust backbone of Ikbi.

### Work
- Standardize receipt IDs and task IDs
- Receipt integrity checks (doctor, verify, repair-index)
- Promotion timeline view
- Failed/partial states made loud

### Exit Criteria
If something goes wrong, receipts are enough to reconstruct what happened without guessing.

---

## Phase 4 — Daily Workflow Polish
**Status:** ⏳ PENDING
**Depends on:** Phases 2, 3

Make the common path smooth.

### Workflows
- Read-only audit: `ikbi audit <repo>`
- Small fix: `ikbi fix "..." --repo <path>`
- Chat-to-build flow in REPL
- Failed verification flow
- Undo flow: `ikbi undo --latest`

### Exit Criteria
Core workflows feel boring, predictable, and safe. Boring is good. Boring pays rent.

---

## Phase 5 — External Repo Readiness
**Status:** ⏳ PENDING
**Depends on:** Phase 1 complete

Make Ikbi dependable outside its own repo.

### Test Repos
1. Ikbi itself
2. Small TypeScript repo
3. Node app with npm
4. pnpm monorepo
5. Python repo
6. Go repo
7. Rust repo
8. Docs-only repo
9. Repo with no tests
10. Repo with broken tests before start
11. Repo with dirty working tree
12. Repo with existing worktrees

### Exit Criteria
Ikbi can safely handle normal external repos without being hand-held.

---

## Phase 6 — Interrupt, Timeout, and Long-Run Reliability
**Status:** ⏳ PENDING
**Depends on:** Phase 1 complete

Daily tools must stop when told to stop.

### Tests
- Interrupt during model call / terminal command / verification / promotion
- Timeout during command / provider call
- Provider fallback during build
- Network failure / hung process / long output stream

### Exit Criteria
Interrupt means interrupt. No zombie squirrel processes chewing wires in the walls.

---

## Phase 7 — Provider, Cost, and Model Reliability
**Status:** ⏳ PENDING
**Depends on:** Phase 6

Daily use requires cost visibility and graceful model failure.

### Work
- Cost summary after every task
- Provider failure receipts
- Budget controls (per-task max, per-day warning, hard stop)
- Chat/build cost separation

### Exit Criteria
The operator never wonders, "What did this cost and which model did it use?"

---

## Phase 8 — Pehlichi Delegation Readiness
**Status:** ⏳ PENDING
**Depends on:** Phases 4, 5, 7

Prepare Ikbi to be safely driven by Pehlichi.

### Work
- Structured delegation envelope
- Validation, rejection of incomplete envelopes
- Structured status/receipt returns
- Governance enforcement regardless of caller

### Exit Criteria
Pehlichi can ask Ikbi to work, but Ikbi still enforces its own governance.

---

## Phase 9 — Memory and Project Context Polish
**Status:** ⏳ PENDING
**Depends on:** Phase 4

Make Ikbi useful across repeated daily work without becoming haunted.

### Work
- Project memory loading (CLAUDE.md, AGENTS.md, IKBI.md, .ikbi/*)
- Memory namespaces
- Memory write rules (proposed, diffed, approved, receipted)
- Context display before build

### Exit Criteria
Ikbi remembers useful project rules without swallowing the whole attic.

---

## Phase 10 — Documentation and Onboarding
**Status:** ⏳ PENDING
**Depends on:** Phases 1-9

Docs should match the actual system.

### Docs to Update
- README.md, CLAUDE.md, AGENTS.md
- docs/DAILY_USE.md, docs/RECEIPTS.md, docs/WORKSPACES.md
- docs/UNDO.md, docs/CHECKS.md, docs/PROVIDER_COSTS.md
- docs/PEHLICHI_DELEGATION.md

### Exit Criteria
A new user can use Ikbi safely without asking how the magic bones work.

---

## Phase 11 — UI/TUI Polish
**Status:** ⏳ PENDING
**Depends on:** Phase 2

Make Ikbi pleasant and understandable.

### Work
- Better status display and progress messages
- Clear phase labels (reading, planning, editing, verifying, reviewing, awaiting approval, promoting, complete)
- Better failure panels, receipt/diff browser, undo flow
- Cost footer, provider/model display
- "What changed?" summary, "What do I do next?" guidance

### Rule
UI must not bypass governance. Every UI/TUI action that mutates a repo goes through the same safety path.

### Exit Criteria
The interface makes Ikbi feel trustworthy, not magical.

---

## Phase 12 — Daily Driver Certification
**Status:** ⏳ PENDING
**Depends on:** Phases 1-11

Final proof before declaring Ikbi daily-driver ready.

### Certification Checklist
- 25 real small tasks across lab repos
- 10 read-only audits
- 10 small fixes
- 5 failed-verification recoveries
- 5 undo operations
- 5 interrupted runs
- 5 non-JS repo checks/fail-closed cases
- 5 dirty repo refusals
- 5 gate-denied promotions
- 5 provider fallback/cost reports

### Final Verdict Options
- READY_FOR_DAILY_USE
- READY_FOR_DAILY_USE_WITH_LIMITS
- REMAIN_LIMITED_DAILY_USE
- NOT_READY

### Daily-Driver Bar
Ikbi is daily-driver ready only when:
- It does not falsely claim success
- It does not lose work
- It does not modify repos without clear approval
- It can undo promoted changes
- It explains failures clearly
- It handles dirty/messy repo states safely
- Receipts are complete enough to audit
- External repo checks are trustworthy
- Pehlichi can delegate safely
- The operator wants to use it again tomorrow

---

## Priority Order

### Must do before daily-driver claim
1. L6 Limited Daily Driver Gauntlet
2. Receipt/audit trail polish
3. Operator CLI polish
4. External repo readiness
5. Interrupt/timeout reliability
6. Daily-driver certification

### Can happen during daily use
- Better docs
- TUI polish
- Cost visualizations
- Memory ergonomics
- Pehlichi integration

### Should wait until daily-driver stable
- Marketplace/persona systems
- Multi-agent mode
- Advanced UI animations
- Public release polish
- Plugin ecosystem
