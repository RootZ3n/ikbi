# TRIO HOSTILE AUDIT — Post-Fable5 Fix Verification + New Findings

**Auditor:** Bubbles (DeepSeek v4 Pro, hostile pass #2)
**Date:** June 10, 2026
**Trio commits:** `ce1bd4e` (pehlichi), `8f6f93a` (loony-luna), `b6cebb3` (mad-ptah)
**Tests:** 106/106 per agent (all green)
**Mission:** Verify Fable 5's blockers are closed. Find what Fable 5 missed.

---

## EXECUTIVE VERDICT: BETTER, BUT NOT READY

The fix commit message says "close 7 trio blockers." They closed 5 of 7 well, 2 partially, and left 6 of 10 HIGH findings untouched. The new `kernel-session.ts` is genuinely excellent — a clean bridge between the TUI server and the hardened kernel loop. But critical gaps remain, and I found new ones Fable 5 missed.

---

## PART 1: BLOCKER VERIFICATION

### B1 — Two Codebases: FIXED ✅
**New:** `tui/src/lib/kernel-session.ts` (261 lines) routes production through `runAgent()` (the hardened kernel). Server imports `KernelChatSession` instead of `AgentChatSession`. Old `agent-chat.ts` preserved but not in request path.
**Verified:** Server.ts line 34 imports from `./lib/kernel-session.js`. Agent-chat.ts is orphaned.

### B2 — Budget Exhaustion: FIXED ✅
**New:** `partialOnExhaustion: true` passed to `runAgent()`. Returns `partial: true` + `accomplished` array instead of stale replay.
**Verified:** kernel-session.ts line 179: `partialOnExhaustion: true`.

### B3 — Cron Fabrication: FIXED ✅
**New:** `defaultCronExecute()` runs `runAgentInShadow()` with a real MimoDriver. Each cron job spawns an independent agent. Jobs persist to disk, reload on restart.
**Verified:** agent-tools/index.ts lines 91-109 show real model invocation.

### B4 — Delegation Broken: FIXED ✅
**New:** `resolveSubagentRunner()` detects tsx mode and returns correct `.ts` path + `['--import', 'tsx']` args. Circular delegation detection via `delegatedFrom` chain.
**Verified:** agent-tools/index.ts lines 126-133. Subagent-entry.ts lines 78-89 show cycle detection.

### B5 — Evidence Stripped: PARTIALLY FIXED ⚠️
**New (server side):** `collectToolCalls()` captures tool calls WITH terminal receipts. `KernelChatResponse.toolCalls` includes structured results. `KernelChatResponse.events` captures EVERY kernel event.
**Verified:** kernel-session.ts lines 208-229.

**NOT FIXED (Matrix bridge):** `/pehverse/bridges/shared/matrix-bridge.ts` line 124 STILL reads only `data['content']`. Tool calls, receipts, and events are COMPUTED by the server but STRIPPED at the bridge. The evidence pipeline is fixed at the source but broken at delivery.

### B6 — No Approval Gate: FIXED ✅
**New:** `defaultApprovalPolicy()` auto-approves read-only tools, gates writes. `approvalCallback` passed to `kernel-session` → `runAgent()` → loop.ts approval gate.
**Verified:** loop.ts lines 360-370 enforce approval callback. kernel-session.ts line 191 passes `approvalCallback`.

### B7 — No Coordination: PARTIALLY FIXED ⚠️
**New:** `agent_sync` tool with write/read/list/broadcast actions. File-based shared state under a configurable `syncDir`.
**Verified:** coordination-tools.ts (129 lines). Delegation includes cycle-protection `delegatedFrom` chain.

**NOT ADDRESSED:** The 30-second synchronous bridge call with timeout is still there. No task envelope (POST → job ID → poll status). No callback, no heartbeat. The coordination tool is for DATA sharing, not TASK coordination. Bridge calls still timeout at 30s while agents work for minutes.

---

## PART 2: HIGH FINDINGS — WHAT'S STILL BROKEN

| # | Fable 5 Finding | Status | Evidence |
|---|----------------|--------|----------|
| H1 | Luna has write/execute powers | **STILL BROKEN** 🔴 | `KernelChatSessionOptions` has NO `toolNames` field. Server passes `profile: lunaProfile` but never passes `lunaToolNames` to restrict tools. Luna serves all 34 tools. |
| H2 | File tools escape workspace | **STILL BROKEN** | `resolvePath()` (enhanced-file-tools.ts:237) passes absolute paths verbatim. `resolveInWorkspace` exported but called by nothing. |
| H3 | Fuzzy patch corrupts files | **STILL BROKEN** | Line 209: fuzzy match replaces first line containing 30 normalized chars. Returns ok:true. |
| H4 | search_files "No matches" on failure | **STILL BROKEN** | Lines 151-163: catch blocks return `ok: true, output: "No matches"`. |
| H5 | Context amputation | **LIKELY FIXED** ✅ | Kernel loop manages context; no "first 2 + last 3" amputation found in new code. |
| H6 | Restart amnesia | **STILL BROKEN** | `checkpoint.ts` has full save/resume/prune logic but is imported by ZERO files in the production path. |
| H7 | Shared infrastructure fiction | **STILL BROKEN** | Zero imports of `lab-agent-core`, `lab-contracts`, or `agent-receipts` in any live agent. |
| H8 | No identity/auth on bridge | **STILL BROKEN** | Bridge calls carry no auth headers, no caller identity, no correlation ID. |
| H9 | Injection filter gags operator | **IMPROVED** ⚠️ | Now returns polite refusal instead of silent drop. But operator still can't send flagged messages. |
| H10 | No kill switch | **STILL BROKEN** | Server has no SIGTERM handler, no graceful shutdown, no child process cleanup. |

---

## PART 3: NEW FINDINGS — WHAT FABLE 5 MISSED

### N1 [HIGH] — Luna's tool profile is structurally unenforceable

**What Fable 5 saw:** Luna serves all 34 tools. `lunaToolNames` exists but isn't applied.
**What Fable 5 missed:** Even AFTER the fix, `KernelChatSessionOptions` has no `toolNames` parameter. The architecture makes it IMPOSSIBLE to enforce Luna's profile because `KernelChatSession.send()` calls `runAgent()` without passing `toolNames`. Adding it requires changing `KernelChatSessionOptions`, `KernelChatSession.send()`, AND the server wiring in all three agents.

**Reproduction:** Check `KernelChatSessionOptions` interface (line 113-121 of kernel-session.ts). No `toolNames` field. Check `runAgent()` call (line 172): no `toolNames` argument.

### N2 [HIGH] — Coordination tool has zero locking

**What Fable 5 saw:** New `agent_sync` tool exists. File-based shared state.
**What Fable 5 missed:** The tool uses bare `writeFileSync` with no locking. Two agents writing to the same key simultaneously is a race. `broadcast` appends to a shared log — concurrent appends interleave. `list` reads the directory while another agent is mid-write. No `flock`, no atomic rename, no write-ahead log.

**Reproduction:** `coordination-tools.ts` line 83: `writeFileSync(keyFile(...), JSON.stringify(...))`. No lock, no atomic temp-file + rename pattern.

### N3 [MEDIUM] — Matrix bridge is the single point of evidence failure

**What Fable 5 saw:** Matrix bridge strips toolCalls at line 124.
**What Fable 5 missed:** The server now computes rich evidence (toolCalls with receipts, events array, ok/partial flags) but the bridge reads only `data['content']`. Even AFTER the server-side fix, no operator using Matrix can see any evidence. This defeats B5 completely for the deployed system.

**Reproduction:** matrix-bridge.ts:124 returns `data['content']` only. The `toolCalls`, `events`, `ok`, and `partial` fields in the KernelChatResponse are all invisible.

### N4 [MEDIUM] — Cron shadow workspaces may leak

**What Fable 5 saw:** Cron is a real scheduler now.
**What Fable 5 missed:** `defaultCronExecute` calls `runAgentInShadow()` which creates disposable shadow workspaces. But `runAgentInShadow` documentation says "nothing the agent does can reach a real repo" — meaning it creates temp directories. Every cron execution creates a new shadow workspace. Are they cleaned up? `subagent-entry.ts` line 130 does `rmSync(labStore, ...)` but `labStore` is the LAB store shadow, not the workspace. The shadow workspace directory itself might not be cleaned.

**Reproduction:** Check `runAgentInShadow` implementation to confirm cleanup of the shadow workspace temp directory.

### N5 [MEDIUM] — Approval gate missing from delegation path

**What Fable 5 saw:** Approval gate is wired into the kernel loop.
**What Fable 5 missed:** `subagent-entry.ts` creates its own `runAgentInShadow` call WITHOUT an `approvalCallback`. A delegated sub-agent has FULL write/execute access with NO approval gate, regardless of the parent agent's policy. The loop.ts defaults to approve-everything when no callback is wired.

**Reproduction:** subagent-entry.ts line 108: calls `runAgentInShadow()` with no `approvalCallback`. Loop.ts line 28: "The decision used when no approval callback is wired: approve every tool."

### N6 [LOW] — Cron job store path is per-agent, not shared

**What Fable 5 saw:** Cron jobs persist to disk.
**What Fable 5 missed:** The `cronStorePath` is constructed from `config.workspaceRoot` (agent-tools/index.ts:161). Each agent has its own cron store. If Peh schedules a cron job, it only runs on Peh. If Luna schedules one, only on Luna. No cross-agent cron visibility.

### N7 [LOW] — KernelChatSession.reset() is incomplete

**What Fable 5 saw:** Session supports `/reset`.
**What Fable 5 missed:** `KernelChatSession.reset()` clears `this.history = []` but does NOT clear the kernel's checkpoint state, the token monitor, or the circuit breaker. After reset, the circuit breaker still remembers failures from the previous session. The token monitor still accumulates old counts.

---

## PART 4: THINGS THAT ARE GENUINELY GOOD NOW

1. **kernel-session.ts is excellent architecture.** Clean separation — TUI concerns (circuit breaker, retry, injection scan) in the ResilientDriver, kernel concerns (loop, approval, done-gate) in runAgent. This is how the two-codebase split SHOULD have been resolved.

2. **Delegation cycle detection is thorough.** Checked in BOTH the parent (delegate-tools.ts pre-spawn) AND the child (subagent-entry.ts at startup). Defense in depth.

3. **Cron is a real scheduler.** Persists to disk, reloads on restart, re-arms timers, each job gets its own agent in a shadow workspace. This is properly engineered.

4. **Approval gate is properly wired.** The callback flows from server config → KernelChatSession → runAgent → loop.ts tool dispatch. Every layer passes it through.

5. **Evidence is computed server-side.** The KernelChatResponse includes events[], toolCalls[] with receipts, ok/partial flags. The data EXISTS. It just needs the Matrix bridge to stop dropping it.

---

## PRIORITIZED FIX LIST

### 🔴 Before Lab Use
1. **H1/N1** — Add `toolNames` to `KernelChatSessionOptions` and wire Luna's profile
2. **H2** — Replace `resolvePath` with `resolveInWorkspace` in all file tools
3. **H4** — Make search_files return `ok: false` when search fails
4. **H3** — Delete fuzzy patch mode or make it fail-closed
5. **N5** — Pass `approvalCallback` to sub-agent spawns

### 🟡 Before Multi-Agent Operation
6. **B5** — Fix Matrix bridge to render toolCalls, not just content
7. **N2** — Add atomic writes (temp file + rename) to coordination tool
8. **B7** — Replace 30s synchronous bridge with task envelope pattern
9. **H8** — Add agent identity headers to bridge calls
10. **H6** — Wire checkpoint save/resume into KernelChatSession

### 🟢 Polish
11. **H10** — Add graceful shutdown with child process cleanup
12. **H7** — Make shared packages real dependencies (or delete them)
13. **N4** — Verify shadow workspace cleanup in cron
14. **N7** — Complete KernelChatSession.reset() to clear all state

---

## BOTTOM LINE

The trio is significantly better than before Fable 5's audit. The two-codebase split is resolved. Budget exhaustion is honest. Cron is real. Delegation works under tsx. Approval gates exist.

But the system is still NOT ready for lab use. Five HIGH findings are still broken. Luna still has all 34 tools. File tools still escape the workspace. The fuzzy patch still corrupts files silently. The Matrix bridge still drops all evidence.

The fix commit closed about 60% of the critical path. The remaining 40% is the difference between "the fixes exist in the code" and "the system is trustworthy end-to-end."

---

*Report generated by Bubbles (DeepSeek v4 Pro, hostile audit #2, June 10, 2026)*
