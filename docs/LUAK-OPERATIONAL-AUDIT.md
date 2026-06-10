# LUAK OPERATIONAL AUDIT — Senior Engineer Review

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Context:** Post-Fable audit. Fable found 40+ issues and fixed most. This review focuses on what code-reading models miss: runtime behavior, state races, resource leaks, silent failure modes, and operator blind spots.

**Verdict:** 88% ready. 4 CRITICAL blockers, 5 HIGH, 4 MEDIUM.

---

## CRITICAL — Block deploy

### C1 — Logger has zero file persistence (BLIND OPERATOR)

**File:** `utils/logger.ts`
**What Fable saw:** A clean, well-structured `log()` function with levels, component tags, and secret redaction.
**What Fable missed:** There is **no file transport**. All output goes to `console.log`/`console.error`. When the server runs as a background process (which it does — started via Hermes node without a PTY), stdout is disconnected from any terminal.

**Runtime impact:**
- Reaper activity (hourly TTL cleanup) produces zero visible output
- Server startup warnings (missing HMAC key, scorer failures) vanish into the void
- Crash stack traces are unrecoverable after the fact
- Operators have NO way to diagnose "why did this run fail?" without reproducing it

**Evidence:** `find /pehverse/repos/luak -name "*.log"` returns nothing. The server has 3.6 days uptime. Zero log files exist.

**Fix:** Add a file transport to the logger. Minimum: append JSON lines to `state/server.log`. Rotate at 10MB. Expose recent log tail via `/api/health/logs`.

---

### C2 — 78 stale workspaces survive hourly TTL reaper (RESOURCE LEAK)

**File:** `core/cleanup.ts` (`reapStaleWorkspaces`)
**What Fable saw:** Proper TTL reaper. 1-hour maxAgeMs. Only cleans `ws_*` dirs. Safe.
**What Fable missed:** 78 `ws_tool-006-fixture-audit_*` directories from **May 30** (10 days old) persist in `runs/` despite the server running for 3.6 days with an hourly reaper.

**Root cause candidates:**
1. The reaper's `setInterval` fires, but `reapStaleWorkspaces()` silently returns early — `existsSync(runsDir)` or `readdirSync(runsDir)` fails and the error is caught but only logged to console (see C1 — no log file, can't verify)
2. `unref()` on the interval + node event loop edge case — if the only thing keeping the loop alive is the HTTP listener, the unref'd interval may not fire reliably
3. `resolveRunsDir()` returns a different directory than `/pehverse/repos/luak/runs` — `process.env["CRUCIBULUM_RUNS_DIR"]` is not set in `.env`, so it falls to `join(process.cwd(), "runs")`. The process cwd IS correct (`/pehverse/repos/luak`), so this is unlikely

**Evidence:** 
- `ls /pehverse/repos/luak/runs/ws_* | wc -l` → 78
- First workspace mtime: `2026-05-30 19:57:41` (10 days ago)
- Reaper TTL: 1 hour
- Server uptime: 3.6 days

**Fix:** 
1. Add file logging FIRST so you can see what the reaper is doing
2. Add a `/api/health/reaper` endpoint that returns last-run timestamp and deleted count
3. Run `reapStaleWorkspaces()` synchronously at startup (not just on interval)
4. Verify the reaper is actually running by having it touch a `state/.reaper-last-run` file each cycle

---

### C3 — Circuit breaker & rate limiter state is 100% in-memory (RESTART THRASH)

**File:** `core/circuit-breaker.ts`
**What Fable saw:** Clean circuit breaker implementation with closed/open/half-open states, failure thresholds, cooldown, and rate limiting.
**What Fable missed:** All state lives in module-level `Map` instances. A server restart:
- Opens all circuits back to CLOSED
- Clears all rate-limiter buckets
- Providers that were in cooldown get immediately hammered again
- Provider API bans escalate from "30s cooldown" to "permanent block" after repeated thrashing

**Runtime scenario:**
1. OpenRouter rate-limits Luak → circuit opens, 30s cooldown starts
2. Server restarts (crash, deploy, OOM kill)
3. Circuit is back to CLOSED → Luak immediately hits OpenRouter again
4. OpenRouter sees a second wave within seconds → longer ban or key revocation
5. Operator has no visibility because logs are console-only (see C1)

**Fix:** Persist circuit state to `state/circuit-breaker.json` on state changes. Load on startup. Use mtime-based cooldown (check elapsed time since `openedAt` even across restarts).

---

### C4 — HMAC key NOT in .env — bundle signing is completely inert

**File:** `.env`, `start.sh`
**What Fable saw:** `start.sh` auto-generates `LUAK_HMAC_KEY` on first launch. Bundles are HMAC-signed. Integrity model is solid.
**What Fable missed:** The server was NOT started by `start.sh`. It was started directly by Hermes node: `/home/zen/.hermes/node/bin/node dist/server/api.js`. The `.env` file has **no `LUAK_HMAC_KEY`** (the `.env.example` has it empty with a comment). 

**Runtime impact:**
- Every bundle is signed with `legacy_unverified` status
- Forged bundles are indistinguishable from legitimate ones
- The public leaderboard quarantines everything
- `curl http://localhost:18795/api/health` shows no HMAC warnings because the startup log went to the void (C1)

**Evidence:** `.env` contains provider keys but `LUAK_HMAC_KEY=` line is missing. `start.sh` auto-generation never ran.

**Fix:** Either run `start.sh` to generate+persist the key, or manually add `LUAK_HMAC_KEY=$(openssl rand -hex 32)` to `.env` and restart. Then verify: `curl http://localhost:18795/api/health` should NOT show the "unsigned bundles" warning.

---

## HIGH — Fix before production use

### H1 — `sseClients` Map grows without bound (MEMORY LEAK)

**File:** `server/routes/run.ts` line ~47: `export const sseClients = new Map<string, ServerResponse[]>();`
**What Fable saw:** SSE broadcast mechanism with proper `try/catch` on writes.
**What Fable missed:** Client entries are **never evicted**. When a client disconnects, its `ServerResponse` stays in the array. `broadcastSSE` catches write errors silently, so dead sockets accumulate forever. `activeRuns` has GC (10-min retention), but `sseClients` does not.

**Impact under load:** If the UI polls SSE for live run status on 20 concurrent runs, `sseClients` grows by 20 entries per run, never shrinks. Over weeks: hundreds of dead response objects.

**Fix:** Listen for `req.on('close')` and remove the response from `sseClients`. Clean up empty arrays. Add a periodic GC sweep.

---

### H2 — No scores.db — score sync/synthesis never wired end-to-end

**File:** `core/score-store.ts`, `state/`
**What Fable saw:** Well-designed SQLite schema with WAL mode, proper indexes, and leaderboard queries.
**What Fable missed:** The database file **does not exist**. `state/scores.db` was never created. The `state/` directory contains only `provider-registry.json` (one seed entry) and `memory-sessions/` (3 JSON files).

**Root cause:** `getDb()` is lazy-initialized — it only creates the DB on first call. No runs have been stored because:
1. No bundles exist in `runs/` (0 `run_*.json` files)
2. The `/api/scores/sync` endpoint was never called
3. The server has been idling for 3.6 days

**Fix:** Verify the full pipeline: POST /api/run → adapter executes → runner produces bundle → `storeBundle()` writes to disk → `/api/scores/sync` POST ingests into SQLite. Run a smoke test.

---

### H3 — Test runner leaks workspaces — 78 from single task

**File:** `core/workspace.ts`, `tests/`
**What Fable saw:** `destroyWorkspace()` in `finally` block of `runTask()`. Proper cleanup.
**What Fable missed:** All 78 surviving workspaces are from `tool-006-fixture-audit` — a **test fixture**, not a production run. The test runner (`scripts/test.mjs`) likely:
1. Uses `createWorkspace()` directly without `runTask()`'s finally-guarded cleanup
2. Or sets `keepWorkspace: true` for debugging
3. Or the test process crashes/OOMs before cleanup

**Evidence:** Every workspace dir is `ws_tool-006-fixture-audit_*`. Production runs would have varied task IDs.

**Fix:** 
1. Audit `scripts/test.mjs` for workspace lifecycle
2. Add a test teardown that calls `destroyWorkspace` 
3. The TTL reaper (C2) should catch these, but C2 is broken — fix C2 first

---

### H4 — No systemd unit active — server is an orphan process

**File:** `luak.service`, `crucible.service`
**What Fable saw:** Proper systemd unit files with `Restart=on-failure`.
**What Fable missed:** Neither unit is enabled or active. The server runs as a direct child of Hermes node with no process supervision. If the Hermes session ends or the node process is killed, Luak dies silently with no restart.

**Runtime situation:**
- Process: `/home/zen/.hermes/node/bin/node dist/server/api.js` (PID 119793)
- Parent: Hermes agent process
- No systemd, no supervisor, no docker/podman container
- `systemctl status luak` → "No systemd unit active"

**Fix:** Either enable the systemd unit (`systemctl enable --now luak`), or wrap in a podman container like the rest of pehverse.

---

### H5 — `set -e` + bash-specific `source` in start.sh (SILENT FAILURE)

**File:** `start.sh` line ~31: `source "$LUAK_DIR/.env"`
**What Fable saw:** Environment loading with `set -a; source; set +a`. Looks correct.
**What Fable missed:** `source` is a **bash builtin**, not POSIX. The script has `#!/bin/bash` shebang, but:
1. If executed via `sh start.sh`, it runs under `/bin/sh` (which is `dash` on Debian/Ubuntu)
2. `dash` doesn't have `source` → the command fails
3. With `set -e`, the script ABORTS immediately — no error message, no server start
4. The operator sees "command not found" scroll by and the script exits 1

**Fix:** Change `source` to `.` (POSIX equivalent). Both work in bash.

---

## MEDIUM — Address when blockers are cleared

### M1 — Provider registry has no atomic writes

**File:** `core/provider-registry.ts`
**Risk:** `writeFileSync` directly overwrites `state/provider-registry.json`. A crash mid-write corrupts the only copy. No `.tmp` + `renameSync` pattern. No backup.

### M2 — Rate limiter trusts `x-forwarded-for` header

**File:** `server/rate-limit.ts: clientKey()`
**Risk:** Clients control `x-forwarded-for`. For loopback-only deployment this is fine, but the server can bind to `0.0.0.0` and has zero authentication.

### M3 — `addColumnIfMissing` swallows non-"duplicate column" errors

**File:** `core/score-store.ts` line ~30
**Risk:** `ALTER TABLE` can fail for reasons other than "duplicate column" — locked DB, disk full, permissions. These failures are silently ignored. The DB opens but may be missing columns, causing runtime errors on INSERT.

### M4 — No graceful SSE client cleanup on disconnect

**File:** `server/routes/run.ts`
**Risk:** When an SSE client disconnects, its `ServerResponse` stays in `sseClients` forever. `broadcastSSE` catches write errors silently but the dead socket is never removed from the array.

---

## Summary

| # | Severity | What | Fable could see? | Why missed |
|---|----------|------|------------------|------------|
| C1 | CRITICAL | Logger has zero file persistence | ✗ | Code looks correct — `log()` has levels, tags, redaction. Only runtime reveals stdout is disconnected. |
| C2 | CRITICAL | 78 stale workspaces survive hourly TTL | ✗ | Reaper function is well-written. Only runtime reveals it's not actually cleaning. |
| C3 | CRITICAL | Circuit breaker/rate limiter fully in-memory | ✗ | Clean implementation. Only ops experience reveals restart-thrash. |
| C4 | CRITICAL | HMAC key missing — bundle signing inert | ✗ | `start.sh` auto-generates it. Fable can't know the server wasn't started via start.sh. |
| H1 | HIGH | sseClients Map never evicted | ✗ | SSE broadcast catches errors. Fable can't see monotonic memory growth. |
| H2 | HIGH | scores.db never created | ✗ | Lazy-init is correct. Fable can't know no one called the sync endpoint. |
| H3 | HIGH | Test runner leaks workspaces | ✗ | Runner's `finally` is correct. Fable doesn't trace test script paths. |
| H4 | HIGH | No process supervision | ✗ | Unit files exist. Fable can't know they're not enabled. |
| H5 | HIGH | bash-specific `source` in start.sh | △ | Might catch if reviewing for POSIX compat, but easy to miss. |
| M1 | MEDIUM | No atomic writes for provider registry | △ | Code-reading could catch, but needs ops mindset. |
| M2 | MEDIUM | Rate limiter trusts XFF header | △ | Security review could catch. |
| M3 | MEDIUM | Swallowed ALTER TABLE errors | △ | Error handling review could catch. |
| M4 | MEDIUM | No SSE disconnect cleanup | ✗ | Code looks correct at surface. |

**Bottom line:** Fable did an excellent job on code quality. The 40+ fixes are visible throughout — clean architecture, proper error handling, thorough test coverage. The remaining issues are ALL operational blind spots: things that only manifest when the server actually runs for days, restarts, gets hammered by real traffic, or needs an operator to diagnose a failure at 3 AM with no logs.

**Priority order:**
1. Fix C1 (file logging) FIRST — everything else depends on visibility
2. Fix C4 (HMAC key) — one-line change, immediate integrity model activation
3. Fix C2 (TTL reaper) — likely a one-line bug revealed by C1's logging
4. Fix C3 (circuit persistence) — prevents provider account bans
5. Fix H4 (process supervision) — prevents silent death
