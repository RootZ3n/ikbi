# Ikbi Proven — L5 Milestone Report

**Date:** June 13, 2026
**Tag:** `ikbi-proven-l5`
**Status:** PROVEN for controlled lab use

---

## What "Proven" Means

ikbi has been tested across five progressive levels, each building on the last.
21/21 tasks passed. No level was skipped. No failures were hand-waved away.

This does NOT mean ikbi replaces Claude Code in every situation.
It means ikbi can be trusted for bounded, real engineering work in the lab.

---

## Test Matrix

### L1 — Single-Task Reliability (5/5)
Small, bounded tasks: docs, tests, bug fixes, endpoints.

| Task | Repo | Result | Files | Lines |
|------|------|--------|-------|-------|
| HELLO.md | kokuli | ✅ PROMOTED | 1 | +lines |
| README Development | howa | ✅ PROMOTED | 1 | +71 |
| getEntriesByResult + tests | kokuli | ✅ PROMOTED | 2 | +46 |
| /health endpoint | howa | ✅ PROMOTED | 1 | +4 |
| CHANGELOG.md | toba | ✅ PROMOTED | 1 | +40 |

**Mode:** Tournament (flash + pro candidates)
**Total cost:** $0.071

### L2 — Repository Understanding (4/4)
Audit, document, analyze existing codebases.

| Task | Repo | Result | Lines |
|------|------|--------|-------|
| API.md | kokuli | ✅ PROMOTED | +207 |
| TYPES.md | kokuli | ✅ PROMOTED | +118 |
| DRIFT-REPORT.md | kokuli | ✅ PROMOTED | +167 |
| FIX-PLAN.md | kokuli | ✅ PROMOTED | +122 |

### L3 — Lab Integration (5/5)
Multi-file features, bug fixes, new endpoints across repos.

| Task | Repo | Result | Files | Tests |
|------|------|--------|-------|-------|
| GET /api/stats | howa | ✅ | 3 | 367 pass |
| getEntriesByType | kokuli | ✅ | 1 | 255 pass |
| GET /api/status | toba | ✅ | 2 | 153 pass |
| POST /api/trials/:id/notes | howa | ✅ | 3 | 367 pass |
| searchEntries | kokuli | ✅ | 1 | 255 pass |

**Mode:** Claude Code Sonnet (post-rescue-fix verification)

### L4 — Independent Projects (4/4)
Build new features from scratch.

| Task | Repo | Result | Files | Lines |
|------|------|--------|-------|-------|
| Honola rebuild | honola | ✅ | 23 | +3,408 |
| GET /api/receipts | ikbi | ✅ | 3 | +384 |
| GET /api/timeline | ikbi | ✅ | 3 | +517 |
| ikbi summary CLI | ikbi | ✅ | 3 | +351 |

**Mode:** Claude Code Sonnet

### L5 — Trusted Builder (3/3)
Plan → build → test → self-review → commit. No intervention.

| Task | Result | Files | Lines | Tests |
|------|--------|-------|-------|-------|
| ikbi workspaces CLI | ✅ | 3 | +448 | 12 |
| ikbi cost CLI | ✅ | 3 | +417 | — |
| ikbi doctor --fix | ✅ | 3 | +497 | — |

**Mode:** Claude Code Opus
**Interventions:** 0

---

## Critical Fix: Auto-Verify Rescue

**Commit:** `29e337c`
**Problem:** DeepSeek v4 Flash writes correct code but fails the done protocol,
hitting `no_progress` after 8-13 tool rounds. The auto-verify rescue existed in
single-run mode but was missing from competitive and tournament modes.

**Solution:** Extracted `maybeAutoVerifyRescueBuilderResult()` helper, wired into
all 3 orchestrator paths. 9 new tests. Fail-closed design.

**Impact:** This was the blocker for L3. Without it, correct work was silently
discarded in tournament mode.

---

## Architecture Summary

- 14 modules, TypeScript, Node.js 22+
- Core: provider, injection, trust, identity, workspace, events, receipt, substrate
- Pipeline: scout → builder → critic → verifier → integrator
- Builder modes: agent (tool-calling), patchsmith (tool-free), tournament (N compete)
- Builder model: deepseek-v4-flash ($0.005-0.03/task)
- Critic model: deepseek-v4-pro
- Escalation: flash → pro → gpt-5.5

---

## What This Means

**ikbi is a tool now, not an experiment.**

Use it daily. Let it earn its keep. The only architecture changes allowed are
ones that daily use exposes as repeated failures.

**Rules for daily-driver mode:**
1. No new features unless a real task demands them
2. No architecture changes unless daily use reveals a repeated failure
3. Log every build — receipts are the truth
4. If it fails, investigate exhaustively before blaming the model

---

## Commits This Session

```
29e337c  fix(orchestrator): auto-verify rescue for all builder paths
0a05d1b  feat(server): GET /api/receipts endpoint
b66dbd8  feat(server): GET /api/timeline endpoint
fb805f5  feat(cli): ikbi summary command
ef738cd  feat(cli): ikbi workspaces command
2da1ed5  feat(cli): ikbi cost command
f1221a8  feat(cli): ikbi doctor --fix
```

7 commits. 8 files changed (server + CLI). All build clean.

---

*"Stop asking 'why won't this model behave?' and start asking 'what job can this model reliably do?'"*

That question is answered now. The job is: bounded, verified, attributed engineering
work under governance. And it does it for pennies.
