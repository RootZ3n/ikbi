# L6 Daily Driver Gauntlet Report

**Date:** 2026-06-15
**Branch:** hardening-sprint-codex (commit cdbdc86)
**Tests:** 1818/1818 green
**Builder model:** deepseek-v4-flash
**Trust state:** Reset before each scenario

---

## Results Summary

| # | Scenario | Expected | Actual | Pass | Cost |
|---|----------|----------|--------|------|------|
| 1 | Clean TS repo, small change | success + promote | success + promoted | ✅ PASS | $0.007 |
| 2 | Dirty repo | refuse / no promotion | failure, not promoted | ✅ PASS | $0.008 |
| 3 | Failing tests before start | success + promote | failure, builder stuck on tsc | ❌ FAIL | $0.006 |
| 4 | Missing package manager | success + promote | failure, builder stuck on tsc | ❌ FAIL | $0.009 |
| 5 | Rust repo without cargo allowlist | fail-closed | failure, not promoted | ✅ PASS | $0.006 |
| 6 | Go repo without go allowlist | fail-closed | failure, not promoted | ✅ PASS | $0.011 |
| 7 | Python repo with pytest | success + promote | pytest passed but builder failure | ❌ FAIL | $0.009 |

**Pass rate: 4/7 (57%)**
**Total cost: $0.056**

---

## Scenario Details

### S1: Clean TypeScript Repo ✅ PASS
- **Repo:** `/tmp/ikbi-gauntlet/clean-ts` (JS with package.json, deliberate `add()` bug)
- **Goal:** "Fix add() in math.js. It subtracts instead of adding."
- **Result:** All 5 roles succeeded. Fix correct (`return a - b` → `return a + b`). Tests pass. Promoted. Working tree clean.
- **Notes:** `tsc --noEmit` help text appeared in output (cosmetic — the builder runs tsc through terminal tool on JS-only repos). Despite this, the builder completed and promoted successfully.

### S2: Dirty Repo ✅ PASS
- **Repo:** `/tmp/ikbi-gauntlet/dirty-repo` (uncommitted changes to index.js + unstaged file)
- **Goal:** "Add a goodbye function to index.js and test it."
- **Result:** Builder wrote files in workspace but outcome was "failure". Original repo untouched — dirty state preserved. Workspace retained.
- **Notes:** This is CORRECT behavior — ikbi did not blindly promote changes to a dirty repo. However, the refusal is implicit (builder failure) rather than an explicit "refusing to work on dirty repo" message. Operator experience gap: the user gets a generic "failure" without understanding WHY.

### S3: Failing Tests Before Start ❌ FAIL
- **Repo:** `/tmp/ikbi-gauntlet/failing-tests` (JS with deliberate wrong test assertion)
- **Goal:** "Fix the failing test in test.js. The modulo(7,2) assertion is wrong."
- **Result:** Builder wrote 1 file (correct fix) but outcome was "failure". Not promoted.
- **Root cause:** The verification ladder runs `pnpm tsc --noEmit` on a JS-only repo (no tsconfig.json). The `tsc` check fails/prints help. The builder's `run_checks` tool reports the typecheck as failing. The builder cannot call `done` because `run_checks` didn't pass. The builder hits max_iterations/no_progress trying to fix TypeScript (which doesn't need fixing) instead of the actual test.
- **Fix needed:** `detectChecksForProject` should skip typecheck when no tsconfig.json exists in the project root. For JS-only repos, only run `test` check.

### S4: Missing Package Manager ❌ FAIL
- **Repo:** `/tmp/ikbi-gauntlet/wrong-pm` (JS with package.json, no lockfile)
- **Goal:** "Add a farewell function to index.js and test it."
- **Result:** Same as S3 — builder gets stuck on `tsc --noEmit`.
- **Root cause:** Same as S3. The JS detection returns VERIFIER_CHECKS (pnpm tsc + pnpm test) regardless of whether TypeScript is configured.
- **Fix needed:** Same as S3 — detect tsconfig.json presence before including typecheck.

### S5: Rust Repo Without Cargo ✅ PASS (correct fail-closed)
- **Repo:** `/tmp/ikbi-gauntlet/rust-repo` (Cargo.toml + src/main.rs)
- **Goal:** "Add a divide function to src/main.rs with tests."
- **Result:** Builder wrote 1 file but checks failed. Not promoted.
- **Notes:** Correct fail-closed behavior. `cargo` is not in the governed-exec allowlist. The check returns a clear error. Builder wrote code correctly but can't verify because cargo isn't allowlisted.
- **Operator guidance:** To use ikbi with Rust repos, add `cargo` to the governed-exec allowlist.

### S6: Go Repo Without Go ✅ PASS (correct fail-closed)
- **Repo:** `/tmp/ikbi-gauntlet/go-repo` (go.mod + main.go)
- **Goal:** "Add a Subtract function to main.go with tests."
- **Result:** Builder wrote 2 files but checks failed. Not promoted.
- **Notes:** Correct fail-closed behavior. `go` is not in the governed-exec allowlist. Same pattern as S5.

### S7: Python Repo With Pytest ❌ FAIL
- **Repo:** `/tmp/ikbi-gauntlet/python-with-pytest` (pyproject.toml + src/ + tests/)
- **Goal:** "Add a multiply function to calculator.py with tests."
- **Result:** pytest ran and PASSED (3/3 tests). But builder reported failure, not promoted.
- **Root cause:** The workspace copy may not have included pyproject.toml (manifest file). Without a project manifest in the workspace root, `resolveChecks` fails with "no recognizable project manifest." The builder's `run_checks` fails, blocking `done`. Alternatively, the builder ran pytest directly (through terminal tool) and it passed, but the structured `run_checks` path failed.
- **Fix needed:** Ensure workspace copy includes project manifest files. Or: if the builder runs checks directly and they pass, accept that as sufficient.

---

## Critical Findings

### FINDING 1: JS-only repos get stuck on tsc (HIGH — FIXED)
**Impact:** S3, S4 fail. Any JS repo without tsconfig.json will fail.
**Root cause:** `detectChecksForProject()` returned VERIFIER_CHECKS (pnpm tsc --noEmit + pnpm test) for ALL repos with package.json, regardless of TypeScript configuration.
**Fix applied:** Added tsconfig.json detection. JS-only repos now get test-only checks.
**File:** `src/modules/worker-model/checks.ts` — `detectChecksForProject()`
**Status:** FIXED. All 1818 tests pass. Rebuild complete.

### FINDING 2: Shell-out mutation guard blocks test file fixes (HIGH — NEW)
**Impact:** S3 STILL fails even after Finding 1 fix. Any fix to a file referenced by a package.json script is blocked.
**Root cause:** The verifier's `detectShellOutMutation()` (verifier.ts:499-523) extracts file paths from package.json scripts. When the builder modifies a referenced file (e.g., test.js when the test script is `"node --test test.js"`), the verifier returns "untrusted" and refuses to verify.
**Why this is wrong:** The builder's JOB is to fix files. If the goal is "fix the failing test in test.js," the builder MUST modify test.js. The shell-out guard should not flag the file that the builder was explicitly asked to fix.
**Fix needed:** The shell-out guard should exclude files that are the GOAL's target. Or: only flag shell-out files when the SCRIPT ITSELF was not the goal target. Or: trust the builder when the modified file is a test file (heuristic).
**File:** `src/modules/worker-model/verifier.ts` — `detectShellOutMutation()`

### FINDING 3: Workspace may not copy project manifests (MEDIUM)
**Impact:** S7 fails. Python/Go/Rust repos may lose their manifest in the workspace copy.
**Root cause:** The workspace manager creates a git worktree, which should include all tracked files. But if the manifest is in .gitignore or the worktree creation has a bug, it may be missing.
**Fix needed:** Verify worktree includes all tracked files. Add assertion in workspace creation.

### FINDING 4: Dirty repo refusal is implicit, not explicit (LOW)
**Impact:** S2 works correctly but the operator gets a confusing "failure" message.
**Root cause:** The builder fails on the dirty workspace, but there's no explicit "dirty repo detected, refusing" message.
**Fix needed:** Add dirty-state detection before workspace creation. Return a clear refusal message.

### FINDING 5: tsc help text pollutes output (LOW)
**Impact:** Cosmetic. All JS scenarios show tsc help text in the output.
**Root cause:** The builder runs `tsc --noEmit` through the terminal tool. On repos without TypeScript, tsc prints help and exits 0.
**Status:** Partially mitigated by Finding 1 fix (typecheck no longer runs on JS-only repos). But the builder model may still try to run tsc directly through its terminal tool.

### FINDING 6: Builder runs terminal commands instead of using run_checks (MEDIUM)
**Impact:** The builder sometimes runs checks through the terminal tool directly instead of using the structured `run_checks` tool. This bypasses the false-green hardening.
**Root cause:** The builder model (DeepSeek V4 Flash) sometimes chooses to run commands directly.
**Fix needed:** Add guidance in the builder system prompt to prefer `run_checks` over direct terminal commands.

---

## Remaining Scenarios (Not Yet Run)

The following scenarios from the Phase 1 plan have not been run yet:

8. Large command output
9. Interrupted build
10. Denied gate-wall promotion
11. Missing/failed receipt simulation
12. Stale workspace lock
13. Live workspace lock
14. REPL /apply with approval
15. REPL /apply denied by gate
16. Terminal escape attempts (unit tested — see terminal-confine.test.ts)
17. Orphan worktree cleanup
18. Undo after promotion (unit tested — see promote-receipt-durability.test.ts)
19. Undo after receipt failure (unit tested — see promote-receipt-durability.test.ts)
20. Cost report after build

**Unit-tested scenarios (12, 13, 14, 15, 16, 18, 19):** These have dedicated test files that passed as part of the 1818/1818 test suite. They verify the behavior at the code level. E2E verification is additional confidence but not blocking.

---

## Recommendation

**Current status: NOT YET READY FOR DAILY USE**

The gauntlet revealed two HIGH-severity findings:

1. **FIXED:** JS-only repos without tsconfig.json got stuck on tsc → now returns test-only checks
2. **NEW BLOCKER:** Shell-out mutation guard blocks test file fixes → verifier returns "untrusted" when the builder modifies a file referenced by a package.json script

Before claiming daily-driver readiness:

1. **MUST FIX:** `detectShellOutMutation()` should not flag files that are the builder's explicit goal target
2. **SHOULD FIX:** Workspace copy must include project manifest files (S7 Python issue)
3. **NICE TO HAVE:** Explicit dirty-repo detection and refusal message
4. **NICE TO HAVE:** Builder prompt should prefer `run_checks` over direct terminal commands

After fixing Finding 2, re-run the full gauntlet to verify S3, S4, S7 pass.
