# PEHVERSE SYSTEM COHESION AUDIT — The University in Your PC

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Context:** Full-system analysis of 11 services forming a university-like architecture. Each service has been individually audited. This report identifies the gaps BETWEEN them — where the whole is less than the sum of its parts.

**The University Map:**
```
┌─────────────────────────────────────────────────────────────┐
│                    ITTUNAHA — Command Center                │
│              (config has 7 dead /mnt/ai/ paths)             │
└────────────┬───────────────────────────────────┬────────────┘
             │                                   │
    ┌────────┴────────┐              ┌───────────┴───────────┐
    │  PEHLICHI (18830)│              │    IKBI (18796)       │
    │  Main Agent      │              │  Central Builder Core │
    │  Strategist      │              │  Cognition + Escalate │
    └────────┬─────────┘              └───────────┬───────────┘
             │                                    │
    ┌────────┴─────────┐              ┌───────────┴───────────┐
    │ PT AH (18810)     │              │   LUNA (18792)        │
    │ Maintenance Man   │              │  Creative Arts Dept   │
    └───────────────────┘              └───────────────────────┘

    ┌───────────────────┐  ┌───────────────────┐  ┌───────────┐
    │  LUAK (18795)     │  │  HOWA (18799)     │  │ KOKULI    │
    │  Model Testing    │  │  Agent Proving    │  │ Red Team  │
    │  Grounds          │  │  Grounds          │  │ (3000)    │
    └───────────────────┘  └───────────────────┘  └───────────┘

    ┌───────────────────┐  ┌───────────────────┐  ┌───────────┐
    │  NUSIKA (18793)   │  │  TOBA (18815)     │  │ HONOLA    │
    │  Learning Center  │  │  Career Center    │  │ Weather   │
    │  VOICE BROKEN     │  │                   │  │ Center    │
    └───────────────────┘  └───────────────────┘  └───────────┘
```

---

## THE FIVE COHESION GAPS — Ranked by Impact

### GAP 1: Ittunaha is the brain but its map is from the old world

**Impact: CRITICAL — Everything flows through Ittunaha**

Ittunaha's `config/lab-services.toml` and `config/runtime-adapters.toml` have:
- **7 dead `/mnt/ai/` paths** — every single old-PC reference
- **2 dead agent ports** (Ricky:18800, Bubbles:18801) — Hermes profiles that aren't services
- **6 runtime adapters with dead working directories**
- **Agent names that don't match** — config says "julian" at 18830 but the service is Pehlichi

The `.env` partially patches 2 paths. 5 are still broken.

**What this means:** Ittunaha can't see half its own university. The services dashboard probes `/health` on dead endpoints. The runtime workspace can't spawn any agent TUIs. The coordination board can't dispatch to agents it can't find. Ittunaha is running blind.

**Fix priority: #1 — Fix the address book before anything else.**

---

### GAP 2: No unified receipts pipeline — every service produces evidence, nobody consumes it

**Impact: HIGH — The university has no transcript**

Every service produces some form of audit trail:
| Service | Receipt Type | Format | Location |
|---------|-------------|--------|----------|
| Ikbi | Build receipts, escalation events | JSONL | `ikbi/state/` |
| Howa | Trial receipts | JSON + MD | `howa-state/receipts/` |
| Luak | Benchmark bundles, scores | SQLite + JSON | `luak/runs/`, `state/scores.db` |
| Kokuli | Ledger entries, findings | JSON | `kokuli/reports/ledger.json` |
| Toba | Action receipts | SQLite | `toba.db` |
| Nusika | TTS/STT receipts | JSONL | `nusika/state/receipts/` |
| Ittunaha | Event store, activity feed | JSONL | `ittunaha/state/events/` |

**These are all separate silos.** Nobody reads anyone else's receipts. Howa doesn't know what Kokuli found. Luak doesn't know what Ikbi built. Ittunaha's activity feed tries to aggregate but its adapters point at dead `/mnt/ai/` paths.

**The missing pipeline:**
```
Kokuli finds a vulnerability
  → Howa adds it as a trial
    → Luak scores models against it
      → Ikbi uses scores for escal ation decisions
        → Ittunaha surfaces the whole chain
```

None of this exists today. Each service is an island.

---

### GAP 3: The testing trifecta (Kokuli → Howa → Luak) has no feedback loop

**Impact: HIGH — Three services that SHOULD be a pipeline are three silos**

The natural flow should be:
1. **Kokuli** red-teams → finds weaknesses in deployed agents
2. **Howa** turns findings into reproducible trials → scores agents against them
3. **Luak** benchmarks models → feeds scores into model selection

**What actually happens:** Each runs independently. Kokuli's findings live in `reports/ledger.json`. Howa's trials are hand-crafted test packs. Luak's benchmarks are hand-curated task manifests. There's no automated bridge:

- Kokuli finding → Howa test pack: **MANUAL**
- Howa trial result → Luak benchmark: **MANUAL**
- Luak benchmark score → Ikbi escalation weight: **HARDCODED** (the `benchmarkPassRate` signal exists in the escalation scorer but isn't populated from Luak)

**The ikbi escalation scorer has a `benchmarkPassRate` field** — it's waiting for this data. But nothing feeds it.

---

### GAP 4: The trio (Pehlichi/Luna/Ptah) + Ikbi have no defined delegation protocol

**Impact: HIGH — The main agent can't delegate to its own team**

Pehlichi is the main agent. Luna does creative work. Ptah does maintenance. Ikbi builds. But:
- How does Pehlichi delegate a build task to Ikbi?
- How does Ptah know which services need maintenance?
- How does Luna receive creative requests?

Ittunaha has a "coordination board" and "council rooms" but the actual delegation protocol is:
- **Ittunaha's config** — dead agent references
- **Ikbi's cognition layer** — can recommend "worker-model" but has no concept of "delegate to Luna"
- **The trio's agent loop** — each agent has its own kernel-session but cross-agent communication goes through Matrix bridges

There's no structured "Pehlichi → Ikbi: build this" or "Pehlichi → Luna: design that" protocol. The bridge system in Ittunaha was designed for this but can't function with dead agent configs.

---

### GAP 5: Nusika's voice layer is down — the learning center is mute

**Impact: HIGH — The most user-facing service can't speak**

Nusika is the learning center — the service with the most potential to help people. But:
- Kokoro voice service: **NOT RUNNING** (port 18794: nothing)
- Piper binary: **NOT FOUND** (old-machine path)
- Whisper STT: **NOT FOUND** (old-machine path)
- Only 2 cached WAV files from May 31 survive

This is a migration issue, not an architecture issue. But it means the university's "classrooms" have no audio.

---

## WHAT'S ALREADY COHESIVE — Build on these strengths

### Strength 1: The Ikbi escalation engine is ready to consume Luak/Howa data

The `benchmarkPassRate` signal exists. The `scoutScore` signal exists. The weights are configurable. The scorer is pure and deterministic. As soon as someone wires Luak benchmark results into the escalation context, Ikbi automatically uses them to decide model tiers.

### Strength 2: The systemd situation is improving

| Service | Systemd Active? |
|---------|----------------|
| Ittunaha | ✓ `lab-ittunaha.service` |
| Nusika API | ✓ `lab-nusika.service` |
| Luak | ✗ |
| Howa | ✗ |
| Kokuli | ✗ |
| Toba | ✗ |
| Ikbi | ✗ (check) |

Two active, five not. But the pattern is clear — newer deployments have it.

### Strength 3: The communication layer exists

Matrix (Synapse on port 8008) provides the messaging backbone. The trio agents already communicate through Matrix. Ittunaha bridges into Matrix. The infrastructure for cross-service communication exists — it just needs the right addresses.

### Strength 4: All services ARE running

Despite the config chaos, every service is alive and responding to health checks:
- 11 services listening on their correct ports
- Ittunaha has 46+ hours uptime
- All databases are reachable

The hardware is healthy. The software is running. The problems are all in the wiring.

---

## PRIORITIZED ACTION PLAN

### Phase 1: Fix the address book (Week 1 — 3 hours)

**Goal:** Ittunaha can see and reach every service.

1. Rewrite `ittunaha/config/lab-services.toml` — map real services with correct ports
2. Rewrite `ittunaha/config/runtime-adapters.toml` — replace `/mnt/ai/` with `/pehverse/repos/`
3. Update 3 dead fallback paths in `ittunaha/src/server.ts`
4. Verify: `curl http://127.0.0.1:18821/api/services` shows all 11 services healthy

### Phase 2: Restore Nusika's voice (Week 1 — 2 hours)

**Goal:** The learning center can speak and hear.

1. Start Kokoro: `cd /pehverse/repos/nusika/voice && ./start.sh`
2. Enable `nusika-voice.service`
3. Install Piper + whisper.cpp on pehverse (or accept Kokoro-only for now)
4. Verify: `curl -X POST http://127.0.0.1:18793/nusika/tts -d '{"text":"Hello"}'` returns audio/wav

### Phase 3: Wire the testing pipeline (Week 2 — 4 hours)

**Goal:** Kokuli findings → Howa trials → Luak benchmarks → Ikbi escalation.

1. Create a `Kokuli → Howa` bridge: Kokuli's `reports/ledger.json` → Howa test pack creation
2. Create a `Howa → Luak` bridge: Howa trial results → Luak's `POST /toba/job-scout/ingest` (or a new ingestion endpoint)
3. Wire Luak benchmark scores → Ikbi's `benchmarkPassRate` escalation signal
4. Run one end-to-end: Kokuli red-teams Pehlichi → Howa creates trial → Luak benchmarks → Ikbi uses score

### Phase 4: Define the delegation protocol (Week 2-3 — 6 hours)

**Goal:** Pehlichi can delegate structured tasks to Ikbi, Luna, and Ptah.

1. Define a simple JSON task envelope: `{from, to, action, payload, priority, deadline}`
2. Ikbi's cognition layer can already produce `recommendedNext` — extend it to include delegation targets
3. Ittunaha's council rooms can route delegation messages
4. Each agent accepts delegation tasks via its Matrix bridge or HTTP endpoint

### Phase 5: Enable systemd for all services (Ongoing)

**Goal:** The university survives reboots.

1. Enable systemd for: Luak, Howa, Kokuli, Toba, Ikbi
2. Each unit gets the hardening treatment (NoNewPrivileges, ProtectSystem, ReadWritePaths)
3. Verify: `systemctl status lab-*` shows all green after reboot

### Phase 6: Unified observability (Future)

**Goal:** One dashboard to see the whole university.

1. Standardize log format across all services (JSON lines)
2. Ittunaha's services dashboard becomes the single pane of glass
3. Add cross-service correlation IDs (trace a task from cognition → build → test → benchmark → escalation)

---

## BOTTOM LINE

Your university already exists. All 11 buildings are standing. The lights are on. The problem isn't that you need to build more — it's that the walkways between buildings are from an old campus map.

**The single highest-leverage action:** Fix Ittunaha's config. Everything else flows from the command center being able to see and reach its own services.

**The thing that makes this a university, not a server rack:** Wire the testing pipeline. Kokuli → Howa → Luak → Ikbi. That's the feedback loop that makes the whole system self-improving.

**The thing that makes it work for humans:** Restore Nusika's voice. The learning center is your most human-facing service and it can't speak.
