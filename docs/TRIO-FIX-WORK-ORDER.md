# TRIO FIX WORK ORDER — Post-Fable5 Audit

**For:** Claude Code (Fable 5)
**Repos:** `/pehverse/repos/pehlichi`, `/pehverse/repos/loony-luna`, `/pehverse/repos/mad-ptah`
**Context:** Fable 5's audit found 7 blockers + 10 highs. The recent fix commit closed ~60%. This is the remaining 40%.

---

## CRITICAL PATH (fix these first — they block lab use)

### FIX 1 — Luna still has all 34 tools (H1)

**Problem:** `lunaToolNames` is defined in `profiles/luna.ts` but `KernelChatSessionOptions` has no `toolNames` field. Luna serves write_file, terminal, execute_code despite her profile forbidding them.

**Files to change:**
- `tui/src/lib/kernel-session.ts` — add `toolNames?: readonly string[]` to `KernelChatSessionOptions`, pass it to `runAgent({ toolNames: ... })`
- `tui/src/server.ts` (in loony-luna) — pass `toolNames: lunaToolNames` to `new KernelChatSession({ ... })`

**Exact lines:**
- kernel-session.ts ~line 113: add `readonly toolNames?: readonly string[];` to the interface
- kernel-session.ts ~line 172: add `...(this.opts.toolNames !== undefined ? { toolNames: this.opts.toolNames } : {}),` to the runAgent call
- loony-luna `tui/src/server.ts` ~line 95: add `toolNames: lunaToolNames,` to KernelChatSession constructor (import `lunaToolNames` from profile)

### FIX 2 — File tools escape workspace (H2)

**Problem:** `resolvePath()` in `enhanced-file-tools.ts` passes absolute paths and `~` paths through verbatim. `resolveInWorkspace()` exists in `workspace.ts` but is never called. Agents can read/write anywhere on disk.

**Files to change:**
- `src/core/agent-tools/enhanced-file-tools.ts` — replace `resolvePath` calls with `resolveInWorkspace`

**Exact lines:**
- Line 237: the `resolvePath` function — replace its body to call `resolveInWorkspace()` from `../../core/workspace.js` instead of passing paths through
- Apply to all call sites: lines 73, 110, 125, 173

### FIX 3 — search_files returns "No matches" on failure (H4)

**Problem:** Two catch blocks return `{ ok: true, output: "No matches for ..." }` when the search command itself failed. A model that reads "No matches" believes the pattern doesn't exist — when the search never ran.

**Files to change:**
- `src/core/agent-tools/enhanced-file-tools.ts`

**Exact lines:**
- Lines 151, 161, 163: change `ok: true` to `ok: false` and change output to describe the error, not "No matches"

### FIX 4 — Fuzzy patch can corrupt files silently (H3)

**Problem:** When exact match fails, fuzzy mode replaces the first line whose normalized text contains the first 30 chars of old_string. Returns `ok: true`. Wrong line, partial application, no diff emitted.

**Files to change:**
- `src/core/agent-tools/enhanced-file-tools.ts`

**Exact lines:**
- Line 209: change fuzzy match to return `{ ok: false, output: "exact match failed — no changes made", error: "..." }` instead of applying the fuzzy patch

### FIX 5 — Sub-agents bypass approval gate (N5)

**Problem:** `subagent-entry.ts` calls `runAgentInShadow()` with no `approvalCallback`. Loop defaults to approve-everything. A delegated sub-agent has full write access regardless of parent's policy.

**Files to change:**
- `src/core/subagent-entry.ts`
- `src/core/agent-tools/delegate-tools.ts`

**Exact lines:**
- subagent-entry.ts ~line 108: add `approvalCallback: defaultApprovalPolicy()` to `runAgentInShadow()` call
- delegate-tools.ts: pass the parent's approval policy through the job JSON

---

## HIGH PRIORITY (fix these before multi-agent operation)

### FIX 6 — Matrix bridge strips all evidence (B5 residual)

**Problem:** Server now returns `{ content, ok, partial, toolCalls, events }` but `matrix-bridge.ts` line 124 reads only `data['content']`. Tool results, receipts, exit codes — all invisible to operators.

**Files to change:**
- `/pehverse/bridges/shared/matrix-bridge.ts`

**Exact lines:**
- Line 124: change from `data['content']` to include tool call summary. At minimum, append a tool summary line like: `\n\nTools used: file_write (ok), terminal: exit 0, search_files (ok)`. Better: render each tool call with its ok/error status.

### FIX 7 — Coordination tool has no locking (N2)

**Problem:** `agent_sync` writes files with bare `writeFileSync`. Two agents writing simultaneously to the same key race. Concurrent `broadcast` appends interleave.

**Files to change:**
- `src/core/agent-tools/coordination-tools.ts`

**Exact lines:**
- Line 83: replace `writeFileSync(keyFile, ...)` with atomic write pattern: write to temp file, then rename
- Broadcast: use appendFileSync with a newline delimiter, or use a per-entry file pattern

### FIX 8 — Bridge calls have no auth (H8)

**Problem:** `bridge-tools.ts` makes bare HTTP requests with no auth headers, no caller identity, no correlation ID. Any process on localhost can drive any agent.

**Files to change:**
- `src/tools/bridge-tools.ts`

**Exact lines:**
- Line ~93: add `X-Agent-Id` and `X-Correlation-Id` headers to the fetch call
- Server-side: validate these headers exist and log them

### FIX 9 — Checkpoints not wired to production (H6)

**Problem:** `checkpoint.ts` has full save/resume/prune logic but is imported by zero production files. Restart = total amnesia.

**Files to change:**
- `tui/src/lib/kernel-session.ts`

**Exact lines:**
- Add periodic checkpoint save after each `send()` call
- Add checkpoint resume in constructor
- Wire to `src/core/checkpoint.ts` save/load functions

### FIX 10 — No graceful shutdown (H10)

**Problem:** Server has no SIGTERM handler. `systemctl stop` orphans running terminal processes and model calls.

**Files to change:**
- `tui/src/server.ts` (all three agents)

**Exact lines:**
- Add `process.on('SIGTERM', async () => { ... })` handler that closes the HTTP server, signals the session to stop, and waits for in-flight operations

---

## MEDIUM PRIORITY (correctness improvements)

### FIX 11 — Cron shadow workspace cleanup (N4)

**Problem:** `defaultCronExecute` calls `runAgentInShadow()` — verify the shadow workspace temp directory is cleaned up after each execution. If not, cron will slowly fill /tmp.

**Files to check:**
- `src/core/agent-tools/index.ts` — the `defaultCronExecute` function
- `src/core/loop.ts` — `runAgentInShadow` implementation

### FIX 12 — KernelChatSession.reset() incomplete (N7)

**Problem:** `reset()` clears `this.history` but not the token monitor or circuit breaker state.

**Files to change:**
- `tui/src/lib/kernel-session.ts`

**Exact lines:**
- Add `this.tokenMonitor.reset()` and `this.breaker.reset()` (or re-create them) in the `reset()` method

### FIX 13 — Replace 30s bridge timeout with task envelope (B7)

**Problem:** Bridge calls use a 30s synchronous fetch. Real tasks take minutes. Always times out on real work.

**Files to change:**
- `src/tools/bridge-tools.ts` — change from synchronous fetch to POST-return-job-ID + poll pattern
- Agent server — add `/task/<id>/status` endpoint

---

## EXECUTION ORDER

1. Run FIX 1 through FIX 5 (critical path — blocks lab use)
2. Run `pnpm test` after each fix — verify 106 tests still pass on all three agents
3. Run FIX 6 through FIX 10 (high priority)
4. Run FIX 11 through FIX 13 (medium)

**Sync all changes across pehlichi, loony-luna, and mad-ptah.** The core files (enhanced-file-tools.ts, coordination-tools.ts, delegate-tools.ts, subagent-entry.ts, kernel-session.ts) are identical across repos — changes made to one must be copied to the others.

---

*Work order generated by Bubbles, June 10, 2026*
*From: TRIO-HOSTILE-AUDIT-2.md*
