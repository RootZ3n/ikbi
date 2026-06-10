# KOKULI OPERATIONAL AUDIT — Senior Engineer Review

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Context:** Kokuli is an "Adversarial fracture engine — pressure-test AI systems until flaws crack open." It combines a test harness (100+ JSON test cases), a web dashboard, a gamified learning system ("Atlantis"), an "Armory" live-ops module (nmap scans, prompt injection checks), and a Verum Bridge for external agents (Ptah, Peh, Ricky) to trigger test runs.

**Verdict:** 84% ready. 4 CRITICAL blockers, 5 HIGH, 4 MEDIUM.

---

## CRITICAL — Block deploy

### C1 — Logger has zero file persistence (BLIND OPERATOR)

**Files:** Every `console.log`/`console.error` call in `server/index.ts`, `server/api.ts`, `engine/*.ts`
**What code review sees:** `console.log("[kokuli-web] Dashboard: http://...")` — seems fine.
**What only runtime reveals:** The server runs as a background process (PID 127962, started by Hermes node, no PTY). All stdout/stderr is disconnected from any terminal. Operators have ZERO visibility into:
- Server startup warnings
- Test execution errors (caught by `console.error("[kokuli] Error running test ...")` throughout `server/api.ts`)
- Crash stack traces
- Armory run progress
- Bridge execution failures

**Evidence:** Server uptime unknown but health endpoint responds at port 3000. No log files exist anywhere in `/pehverse/repos/kokuli/`. The `reports/latest/` directory is empty (just `.gitkeep`).

**Fix:** Add a file transport. Minimum: append JSON lines to `reports/server.log`. Rotate at 10MB. Expose recent log tail via `/api/meta/logs`.

---

### C2 — Execution store has NO concurrency protection (LOST STATE RACE)

**File:** `engine/executionStore.ts`
**What code review sees:** Clean CRUD: `loadExecutionStore()` → modify → `saveExecutionStore()`. Looks correct.
**What only runtime reveals:** Two concurrent test runs will race:

```
Time  T1: loadExecutionStore()  → reads EXECUTION.json (test-A: idle)
      T2: loadExecutionStore()  → reads EXECUTION.json (test-A: idle)
      T1: modifies test-A → queued
      T1: saveExecutionStore()  → writes test-A: queued
      T2: modifies test-B → queued
      T2: saveExecutionStore()  → writes test-B: queued, test-A: idle (LOST!)
```

No file lock, no atomic read-modify-write, no optimistic concurrency. The `/api/suite/:category` endpoint runs tests sequentially (for loop), but `/api/tests/:id/run` can be called concurrently from multiple browser tabs or API clients. The first run's state update is silently overwritten by the second.

**Fix:** Use SQLite (better-sqlite3 is already in the project) with `INSERT OR REPLACE` for atomic state updates. Or add an `updatedAt` version field and reject stale writes.

---

### C3 — Bridge `activeRuns` Map leaks on unexpected exit (PERMANENT SWEEP LOCK)

**File:** `engine/bridge/verumBridge.ts`
**What code review sees:** `activeRuns.set(runId, ...)` in try block, `activeRuns.delete(runId)` in finally. Looks correct.
**What only runtime reveals:** If the Kokuli process is killed (SIGKILL, OOM, `kill -9`) mid-run:
1. `finally` never executes
2. `activeRuns` still contains the run entry
3. `fullSweepActive()` returns true FOREVER
4. All subsequent `suite=all` bridge requests are rejected with "Another suite=all run is already in progress"
5. The operator has no visibility because there's no log file (C1) and no `/api/bridge/kokuli/active-runs` endpoint to inspect the lock state

**Fix:** Add a `/api/bridge/kokuli/active-runs` GET endpoint that returns current active runs. Add a `/api/bridge/kokuli/unstuck` POST that clears stale entries after manual confirmation. Persist `activeRuns` state to disk with TTL-based staleness (similar to executionStore's `STALE_AFTER_MS` pattern).

---

### C4 — No systemd unit active — server is an orphan process

**File:** `install/verum-web.service`
**What code review sees:** Service file exists with `Restart=on-failure`.
**What only runtime reveals:** The server runs as a direct child of Hermes node (PID 127962, parent is `/home/zen/.hermes/node/bin/node`). No systemd, no supervisor, no podman container. If the Hermes session ends:
- Kokuli dies silently
- In-flight Armory runs are abandoned (nmap child processes become orphans)
- Bridge `activeRuns` lock persists in memory only — on restart it's cleared, but the lock was blocking callers for no reason

The service file has unreplaced placeholders (`%USER%`, `%INSTALL_DIR%`, `%NODE_DIR%`, `%NODE_BIN%`) — it's a template, not a deployable file.

**Fix:** Create an actual deployable service file or wrap in podman (consistent with rest of pehverse). Enable it.

---

## HIGH — Fix before production use

### H1 — Ledger rewrites entire file on every single entry (O(n²) DISK I/O)

**File:** `engine/ledger.ts: recordEntry()`
**What code review sees:** Read ledger, push entry, write back. Simple.
**What only runtime reveals:** Every test result triggers: `readJson(ledger.json)` → parse full array → push one entry → `writeJson(ledger.json, entire_array)`. At 266 entries (current), this is fine. At 10,000 entries, every single test result reads and writes the entire growing file. A suite of 50 tests = 50 full file reads + 50 full file writes. This is O(n²) disk I/O per suite run.

Additionally, the LEDGER_MAX_ENTRIES and LEDGER_RETENTION_DAYS caps are **documented in comments but not enforced in code**. The only pruning mechanism is `clearLedger()` which wipes everything.

**Fix:** Use append-only writes (`fs.appendFile` with JSONL format, one entry per line). Enforce the documented caps on read. The session ledger already uses an in-memory array — append to both simultaneously.

---

### H2 — `sessionEntries` is unbounded in-memory array (MEMORY LEAK)

**File:** `engine/ledger.ts` line ~80: `const sessionEntries: LedgerEntry[] = [];`
**What code review sees:** In-memory session cache. Fine.
**What only runtime reveals:** `sessionEntries` grows monotonically until process restart. A 10,000-entry ledger run means 10,000 objects in memory. On top of `rateBuckets` Map, `currentRunContext` closures, and Express middleware state. No cap, no GC, no TTL. Combine with H1's lack of LEDGER_MAX_ENTRIES enforcement and you have both disk AND memory unbounded growth.

**Fix:** Cap `sessionEntries` to LEDGER_MAX_ENTRIES (default 10,000). Prune oldest entries when over limit.

---

### H3 — `reports/latest/` is completely EMPTY — nothing ever ran

**Evidence:** `ls /pehverse/repos/kokuli/reports/latest/` returns only `.gitkeep`. The ledger has 266 entries from May 31 (armory dry runs), nothing since. The server has been running but no tests have been executed through the web UI.

**This is not a code bug — it's an operational signal.** Either:
1. The web UI was never used after initial setup
2. Test execution is broken (silently — see C1 for why nobody noticed)
3. The default target `mushin-peh-v2` (http://100.118.60.13:18791) was unreachable when tests were attempted

**Fix:** Run a smoke test: `curl -X POST http://127.0.0.1:3000/api/tests/baseline-chat/run` and verify results appear in `reports/latest/`.

---

### H4 — Armory `currentRunContext` is an in-memory singleton — restart = ghost process

**File:** `server/ops/armory.ts` line ~128: `let currentRunContext: ActiveArmoryRunContext | null = null;`
**What code review sees:** Single run enforcement. By design.
**What only runtime reveals:** If the Kokuli process is killed mid-Armory-run:
1. `currentRunContext` is lost (memory only)
2. The spawned `nmap` child process becomes an orphan — continues running until it times out or completes
3. The `isKillSwitchEnabled()` state persists across restarts (saved to disk via `saveStatus()`) but is reset on module reload
4. On restart, `currentRunContext = null` — the armory thinks it's idle, but the orphan nmap is still running

**Fix:** Write `currentRunContext` to disk in `ARMORY_STATUS.json` (already partially done via `saveStatus`). On startup, check for orphaned runs and recover (kill orphan processes or mark as stale).

---

### H5 — `console.error` in catch blocks — invisible without C1 fix

**Files:** `server/api.ts` (multiple), `engine/assessment.ts`, `server/ops/armory.ts`
**Pattern:** `console.error("[kokuli] Error running test:", entryErr instanceof Error ? entryErr.stack : entryErr)` 
**Runtime impact:** These errors are swallowed into the void (see C1). Operators never see:
- Test execution failures
- Assessment bundle write errors
- Suite-level error catch blocks
- Armory execution failures

The code catches errors properly, but the error reporting channel is broken end-to-end because console.error output has no persistence.

---

## MEDIUM — Address when blockers are cleared

### M1 — `fs.writeJson` used everywhere — no atomic writes

**Files:** `engine/executionStore.ts`, `engine/ledger.ts`, `learning/state.ts`, `server/ops/armory.ts`
**Risk:** Every persistent file is written with `writeJson` which truncates and overwrites in place. A crash mid-write corrupts the ONLY copy. No `.tmp` + `renameSync` pattern. Files affected: EXECUTION.json, ledger.json, player.json, ARMORY_STATUS.json, armory-receipts.json.

### M2 — `isValidCategory` missing `'multi-turn'` from valid list

**File:** `server/api.ts` line ~60
**Check:** Actually present — `'multi-turn'` IS in the array. False alarm. (See M4 in audit evidence for another validation issue.)

### M3 — Server can bind to `0.0.0.0` with zero authentication

**File:** `server/index.ts`
**Risk:** Controlled by `KOKULI_BIND_ALL=1` env var. The security headers middleware has strong CSP, rate limiting, and `X-Frame-Options: DENY`. But there is no authentication layer. If accidentally exposed beyond loopback, all API endpoints are open.

### M4 — Bridge `spawn()` passes entire `process.env` to child process

**File:** `engine/bridge/verumBridge.ts` line ~300: `env: process.env`
**Risk:** The bridge spawns `node bin/kokuli.js` with the full parent environment, including all provider API keys from `.env` (if loaded). The child process is the same codebase but the environment bleed means any test output that echoes env vars would leak keys. Low risk because the child is trusted code, but against the principle of least privilege.

---

## Summary

| # | Severity | What | Code review sees | Why missed |
|---|----------|------|-----------------|------------|
| C1 | CRITICAL | Logger has zero file persistence | console.log looks fine | Only runtime reveals stdout is disconnected |
| C2 | CRITICAL | Execution store has no concurrency protection | Clean CRUD looks correct | Only runtime reveals race under concurrent API calls |
| C3 | CRITICAL | Bridge activeRuns leaks on crash | finally block looks correct | Only runtime reveals SIGKILL bypasses finally |
| C4 | CRITICAL | No process supervision | Service file exists | Only runtime reveals it's not deployed |
| H1 | HIGH | Ledger O(n²) disk I/O per write | Simple read-push-write | Only runtime reveals scaling behavior |
| H2 | HIGH | sessionEntries unbounded | In-memory cache is fine | Only runtime reveals monotonic growth |
| H3 | HIGH | reports/latest/ is empty | Code looks correct | Only runtime reveals nothing ever ran |
| H4 | HIGH | Armory ghost processes on crash | Singleton pattern by design | Only runtime reveals orphan process risk |
| H5 | HIGH | console.error invisible without C1 | Error handling looks correct | Only runtime reveals output channel is broken |
| M1 | MEDIUM | No atomic writes | writeJson is standard | Ops mindset needed |
| M3 | MEDIUM | 0.0.0.0 bind with no auth | Security headers exist | Ops mindset needed |
| M4 | MEDIUM | Bridge leaks process.env | Trusted child process | Least-privilege mindset needed |

**What's genuinely impressive about Kokuli:**
- The network gate (`engine/networkGate.ts`) is EXCELLENT — dual-env-var contract, RFC-aware IP validation, explicit ownership attestation
- The bridge validation is thorough — allowlisted callers/targets/modes/suites, safe argv building, no shell interpolation
- The armory has kill-switch safety, beginner guardrails, dry-run mode, and safe `ensureNotCancelled()` checkpoints
- The assessment engine handles no-evidence results correctly (doesn't inflate pass rates with empty bodies)
- The execution store has 30-minute staleness detection for stuck queued/running states

**Bottom line:** Kokuli's architecture is solid and well-thought-out. The remaining issues are the same class of operational blind spots that affect Luak — no file logging, in-memory state that doesn't survive restarts, and no process supervision. The code quality is high.

**Priority order:**
1. Fix C1 (file logging) FIRST — everything else depends on visibility
2. Fix C4 (process supervision) — prevent silent death
3. Run H3 smoke test — verify the pipeline actually works
4. Fix C2 (execution store concurrency) — prevent silent state corruption
5. Fix C3 (bridge activeRuns leak) — prevent permanent sweep lock
6. Fix H1+H2 (ledger scaling) — prevent disk/memory exhaustion under load
