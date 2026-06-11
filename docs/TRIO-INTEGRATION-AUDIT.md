# TRIO INTEGRATION AUDIT — Pehlichi, Mad-Ptah, Loony-Luna

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Context:** The trio has received a major lab-wide integration pass — new skills, bridge endpoints, work order pipelines, pattern detection, and matrix control. This audit evaluates the cohesion: what's wired, what's missing, and what's broken.

**Verdict: 88% integrated. Strong Pehlichi→Ptah pipeline. Weak ikbi/Ittunaha connections. Minor bugs.**

---

## THE INTEGRATION MAP — What's Wired

```
┌──────────────────────────────────────────────────────────────┐
│                      PEHLICHI (Coordinator)                  │
│  Skills: peh-coordinator, peh-planner, peh-archivum,        │
│          peh-safety, peh-toba-nusika, work-order-creator     │
│                                                              │
│  ── BRIDGES ──                                               │
│  Toba (18815) ← career profile, campaigns, export           │
│  Nusika (18793) ← modules, lessons, sessions, memory        │
│  Ptah ← work orders via /pehverse/state/work-orders/        │
│                                                              │
│  ── MISSING BRIDGES ──                                       │
│  ikbi ✗, Ittunaha ✗, Luak ✗, Howa ✗, Kokuli ✗             │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                      PTAH (Repairman)                        │
│  Skills: ptah-repairman, ptah-work-orders, ptah-occasio     │
│                                                              │
│  ── INTEGRATIONS ──                                          │
│  Work orders ← /pehverse/state/work-orders/ (reads WOs)     │
│  Atoni (18805) ← reads findings for pattern detection       │
│  Repair log → /pehverse/state/ptah/repair-log.jsonl         │
│  Matrix control → remote operation via Matrix                │
│                                                              │
│  ── OCCASIO PATTERN DETECTION ──                             │
│  Scans: repair log, Atoni findings, work orders, test suites│
│  Detects: repeated failures, stale WOs, regressions,        │
│           provider degradation, memory staleness             │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                      LUNA (Creative)                         │
│  Skills: luna-creative-director, luna-minimax-generation,   │
│          luna-comfyui-control                                │
│                                                              │
│  ── INTEGRATIONS ──                                          │
│  MiniMax ← primary generation backend                       │
│  ComfyUI ← secondary (moody friend)                         │
│  Matrix control → remote operation via Matrix                │
│                                                              │
│  ── MISSING BRIDGES ──                                       │
│  No service bridges (leaf agent, by design)                 │
└──────────────────────────────────────────────────────────────┘
```

---

## WHAT'S WORKING WELL

### 1. The Pehlichi → Ptah work order pipeline is solid

Pehlichi's `work-order-creator` skill has:
- Clear schema documentation
- Severity guide (critical through info)
- Category system (bug, regression, test-failure, service-down, etc.)
- Step-by-step instructions with exact bash commands

Ptah's `ptah-work-orders` skill has:
- Complete workflow: check → assign → diagnose → fix → verify → log
- Resolution object format
- Repair log format (JSONL)
- Category-to-action mapping
- Atomic commit rule

This pipeline is **production-ready.** The only thing missing is Ptah's end of the loop — when Ptah fixes something, does Pehlichi get notified? There's no "fix confirmed" notification back to the coordinator.

### 2. Ptah's Occasio pattern detection is genuinely clever

The `ptah-occasio` skill detects 8 pattern types:
- `repeated-failure` — same thing breaking repeatedly
- `stale-open-loop` — work orders stuck in progress
- `regression-watch` — test counts dropping
- `verification-needed` — claims without proof
- `provider-degradation` — model performance declining
- `workflow-candidate` — patterns that should be automated
- `memory-staleness` — outdated information
- `maintenance-due` — scheduled work needed

Each detection type has a concrete shell command to find it. The timing intelligence (immediate/next-session/nightly/on-demand/suppressed) prevents alarm fatigue.

### 3. Pehlichi's Toba-Nusika bridge is comprehensive

The `peh-toba-nusika` skill documents:
- 14 Toba endpoints with curl examples
- 12 Nusika endpoints with curl examples
- When-to-route decision trees for both services
- Past-life voice integration (stone age man, ancient librarian)
- Conversation saving patterns

This is a full API reference disguised as a personality skill. Well done.

### 4. Matrix control is available across all three

All three agents have the matrix-control feature (`full-access sandbox + writes for remote control via Matrix`). This means any of them can be operated from Matrix — the same communication backbone that connects the lab.

### 5. Tool permissions are correctly scoped

| Agent | delegate_task | cronjob | Role |
|-------|--------------|---------|------|
| Pehlichi | ✗ not in toolNames | ✗ not in toolNames | Coordinator (but can't delegate or schedule?) |
| Ptah | ✓ | ✓ | Repairman (full access) |
| Luna | ✗ | ✗ | Leaf creative (correct — shouldn't orchestrate) |

Wait — Pehlichi's toolNames don't include `delegate_task` or `cronjob` or `execute_code`. But the description says "full builder tools" and Pehlichi is the coordinator. A coordinator who can't delegate or schedule is a bottleneck.

---

## WHAT'S MISSING

### GAP 1: Pehlichi has no bridge to ikbi (the builder core)

**Why this matters:** Pehlichi is the coordinator. Ikbi is the builder core with the cognition layer, agent router, and escalation engine. If Pehlichi can't talk to Ikbi, the coordinator can't delegate builds. The most important integration in the lab is the coordinator → builder pipeline, and it doesn't exist.

**What's needed:** A `peh-ikbi` skill that documents:
- How to route build tasks to ikbi (port 18796)
- How to use ikbi's `classify` and `ask` CLI commands
- How to read ikbi's build receipts
- How the escalation engine works and when to trust its decisions

### GAP 2: Pehlichi has no bridge to Ittunaha (the command center)

**Why this matters:** Ittunaha has the services dashboard, Nous model intelligence, coordination intelligence, and staged promotion system. Pehlichi should be able to query Ittunaha for:
- "Which model should I use for this task?"
- "What's the health status of all services?"
- "Has Luna been producing good work lately?"

### GAP 3: Ptah's Atoni integration uses port 18805 — Atoni may not be running

**Why this matters:** Ptah's Occasio skill has `curl http://127.0.0.1:18805/findings?days=7` hardcoded. If Atoni isn't running (which it wasn't when I checked), pattern detection silently fails. The curl command doesn't check for connection errors.

### GAP 4: No Ptah → Pehlichi notification loop

Ptah fixes a work order. Pehlichi created it. But Pehlichi never learns the outcome unless it manually checks. There's no "WO resolved" notification flowing back.

### GAP 5: Pehlichi's toolNames are missing delegation capabilities

The coordinator profile says "You route tasks: 'This is a Ptah job' or 'Luna should handle this.'" But Pehlichi's `coordinatorToolNames` doesn't include `delegate_task`, `cronjob`, or `execute_code`. The coordinator can't actually delegate programmatically — only verbally suggest.

### GAP 6: Luna is completely isolated

Luna has no service bridges. This is correct for a leaf agent — but she could benefit from reading Luak benchmark results (to know which model generates best) or ikbi build status (to know if the creative tools are healthy).

---

## WHAT'S BROKEN

### BUG 1: Ptah's Occasio test suite scan includes wrong repos

The skill runs `pnpm test` on `honola` — but Honola is a Vite app with `"test": "vitest run"` (not `pnpm test`), and `mad-ptah` and `pehlichi` and `loony-luna` don't have `pnpm test` either. The command should use `npm test` or check for available test commands.

### BUG 2: Work order schema references "archelon"

Pehlichi's work-order-creator skill lists `"source": "peh|luna|julian|zen|archelon|ptah"`. "Archelon" is the old name. Should be "atoni".

### BUG 3: Pehlichi's `coordinatorToolNames` is out of sync with profile description

The profile says Pehlichi is the coordinator who "routes tasks" and has "full builder tools." But the actual toolNames list is missing `delegate_task`, `cronjob`, and `execute_code`. The description and the permissions don't match.

---

## SUMMARY

| # | What | Status |
|---|------|--------|
| 1 | Pehlichi → Ptah work order pipeline | ✅ Solid |
| 2 | Ptah Occasio pattern detection | ✅ Clever, well-designed |
| 3 | Pehlichi → Toba bridge | ✅ Comprehensive |
| 4 | Pehlichi → Nusika bridge | ✅ Comprehensive |
| 5 | Matrix control (all three) | ✅ Available |
| 6 | Pehlichi → ikbi bridge | ❌ MISSING |
| 7 | Pehlichi → Ittunaha bridge | ❌ MISSING |
| 8 | Pehlichi toolNames (delegate/cronjob) | △ Out of sync with role |
| 9 | Ptah → Atoni connection | △ Depends on Atoni running |
| 10 | Ptah → Pehlichi notification loop | ❌ MISSING |
| 11 | Luna → external services | ❌ Isolated (by design) |
| 12 | Ptah test scan command wrong | ❌ Uses `pnpm test` on wrong repos |
| 13 | Work order schema says "archelon" | ❌ Old name |

**Bottom line:** The Pehlichi ↔ Ptah pipeline is production-ready. The Pehlichi → Toba/Nusika bridges are comprehensive. But the coordinator can't talk to the builder core (ikbi) or the command center (Ittunaha) — those are the two most important missing integrations. Fix the 3 bugs, add ikbi and Ittunaha bridges, and sync Pehlichi's tool permissions with the coordinator role.
