# ITTUNAHA OPERATIONAL AUDIT — Senior Engineer Review

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Context:** Ittunaha is the lab command center — the central coordination hub for all pehverse services. It monitors agents, runs the arena (multi-agent comparison), manages council rooms, coordinates workflows, and surfaces the operator dashboard. It has 100+ test files, a 27-document lab manual, and deep integration with every service in the pehverse.

**Verdict: REBUILD THE CONFIG LAYER FROM SCRATCH. The code is worth preserving.**

---

## THE RAW NUMBERS

### 7 dead `/mnt/ai/` paths — every single one
```
/mnt/ai/hermes                    → DEAD
/mnt/ai/ikbi                      → DEAD
/mnt/ai/peh-v2                    → DEAD
/mnt/ai/ptah                      → DEAD
/mnt/ai/luna                      → DEAD
/mnt/ai/lab-context-spine         → DEAD
/mnt/ai/colosseum/colosseum-state → DEAD
```

### 2 dead agent ports
```
ricky  → 18800 → nothing listening
bubbles → 18801 → nothing listening
```

### 6 runtime adapters with dead working directories
```
hermes → cwd="/mnt/ai/hermes"           → DEAD
ikbi   → cwd="/mnt/ai/ikbi"             → DEAD
peh    → cwd="/mnt/ai/peh-v2"           → DEAD
ptah   → cwd="/mnt/ai/ptah"             → DEAD
luna   → cwd="/mnt/ai/luna"             → DEAD
```

### 3 dead server.ts fallback paths
```typescript
"/mnt/ai/lab-context-spine"        // spine adapter
"/mnt/ai/peh-v2/state/receipts"    // peh receipt adapter
"/mnt/ai/colosseum/colosseum-state" // colosseum state root
```

---

## WHAT'S ACTUALLY WORKING

Despite all the dead config, Ittunaha IS running and healthy:
- Port 18821, systemd unit `lab-ittunaha.service` ACTIVE — second project with systemd!
- 46+ hours uptime, version 0.3.0
- All 11 real services ARE reachable at their correct ports
- The health endpoint returns `{"ok": true, "safe": true}`

The `.env` file partially patches some dead paths:
```
ITTUNAHA_PEH_RECEIPTS=/pehverse/repos/peh-lab/state/receipts  ✓
ITTUNAHA_SPINE_ROOT=/pehverse/repos/peh-lab/state             ✓
```

But the `.env` only fixes 2 of the 7 dead paths. The other 5 are still hardcoded in `server.ts` defaults and `runtime-adapters.toml`.

---

## WHY REBUILD INSTEAD OF PATCH

### 1. The agent registry has the wrong abstraction layer

`lab-services.toml` defines 15 services. But the Hermes "agents" (Julian, Ricky, Bubbles) were profiles within a single Hermes instance — not standalone services with their own ports. The old architecture had separate Hermes profiles each running on their own port (18830, 18800, 18801). The new architecture has:
- Hermes running as a single process
- ikbi (formerly Aedis) replacing Claude Code as the daily coding agent
- The trio (Pehlichi, Mad-Ptah, Loony-Luna) at 18830, 18810, 18792

Julian/Ricky/Bubbles are now Hermes chat personas, not separate services. They shouldn't be in the service registry at all.

### 2. The runtime adapter layer assumes Ink/React TUIs that don't exist

`runtime-adapters.toml` has entries for peh, ptah, luna, and ikbi — all pointing at `/mnt/ai/` paths for TUI binaries. But:
- These TUIs were planned but never built (the docs say "NO TUI YET — 2026-05-20 lab survey")
- ikbi has a CLI but no TUI (`/mnt/ai/ikbi/dist/cli/ikbi.js tui` doesn't exist)
- All cwd paths are from the old machine

The runtime workspace feature is completely non-functional after migration. This is a significant feature surface (embedded terminal sessions per agent) that's entirely dead.

### 3. The colosseum/crucible references are from the old architecture

`server.ts` has hardcoded fallbacks to `"/mnt/ai/colosseum/colosseum-state"` and the agent registry has a "crucible" entry. But:
- Luak (formerly Crucible/Crucibulum) is at `/pehverse/repos/luak/`, port 18795
- Howa (formerly Colosseum) is at `/pehverse/repos/howa/`, port 18799
- The old `/mnt/ai/colosseum/colosseum-state` path is dead

### 4. The `paths` section in lab-services.toml duplicates dead defaults

```toml
[paths]
spine_root    = "/mnt/ai/lab-context-spine"
luna_receipts = "/mnt/ai/luna/state/receipts"
ptah_receipts = "/mnt/ai/ptah/data/receipts"
peh_receipts  = "/mnt/ai/peh-v2/state/receipts"
```

All four are dead. The `.env` overrides `spine_root` and `peh_receipts` but the TOML config still has the old values as reference.

---

## WHAT TO REBUILD VS WHAT TO KEEP

### KEEP (the code is excellent):
- **All 100+ route handlers** — well-structured, tested, functional
- **The Arena system** — multi-agent comparison with stream logging
- **Council rooms** — multi-agent group chat with chat adapters
- **The lab manual** — 27 documents that are still valuable
- **The lifecycle system** — migrations, compatibility, confidence scoring
- **The Nous model intelligence** — cost-aware routing, staged promotions
- **The event store** — append-only JSONL with adapters
- **The workflow engine** — cross-agent workflow coordination
- **The bridge system** — agent conversation contract
- **The vendor packages** — `@ai-lab/agent-receipts` and `@lab/contract-keys`

### REBUILD:
- **`config/lab-services.toml`** — Remove Julian/Ricky/Bubbles as standalone services. Map only real services with correct ports. Remove dead `[paths]` section.
- **`config/runtime-adapters.toml`** — Replace all `/mnt/ai/` paths with `/pehverse/repos/` equivalents. Remove TUI entries for agents that don't have TUIs. Add only what actually exists.
- **`src/server.ts` default paths** — Replace all 5 hardcoded `/mnt/ai/` fallbacks with `/pehverse/` equivalents or `null`.
- **`src/core/adapters/spine.ts`** — Point to `/pehverse/repos/peh-lab/state` (already in `.env`).
- **`src/core/adapters/peh-receipts.ts`** — Point to `/pehverse/repos/peh-lab/state/receipts` (already in `.env`).

---

## SUMMARY

| Category | Count | Details |
|----------|-------|---------|
| Dead `/mnt/ai/` paths | **7** | Every single old-PC path is dead |
| Dead agent ports | **2** | Ricky (18800), Bubbles (18801) |
| Dead runtime adapters | **6** | All have `/mnt/ai/` cwd paths |
| Dead server defaults | **3** | Spine, peh receipts, colosseum state |
| Fixed by `.env` | **2** | Spine root, peh receipts |
| Still broken | **5** | Luna receipts, ptah receipts, colosseum state, all runtime adapters |
| Active systemd unit | **1** | lab-ittunaha.service — ACTIVE |
| Working services | **11** | All real services are reachable |

**Bottom line:** Ittunaha's codebase is a masterpiece of lab orchestration — the arena, council rooms, workflow engine, and Nous intelligence are genuinely impressive. But the configuration layer is a graveyard of dead references from the old PC. Every single `/mnt/ai/` path is dead. Two of the 15 registered agents don't exist. Six runtime adapters point to non-existent binaries.

**Don't rebuild the code. Rebuild the config.** The code is worth preserving. The fix is surgical:
1. Rewrite `lab-services.toml` — 15 entries → map only real services
2. Rewrite `runtime-adapters.toml` — replace all `/mnt/ai/` with `/pehverse/repos/`
3. Update 3 hardcoded fallbacks in `server.ts`
4. Remove Julian/Ricky/Bubbles from the agent registry (they're Hermes personas, not services)

Estimated effort: 2-3 hours of config editing. The codebase itself is solid and well-tested.
