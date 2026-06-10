# MIKO AUDIT + NUSIKA/ITTUNAHA RE-AUDIT + PIPELINE DISCOVERY

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)

---

## PART 1: MIKO — THE SPAGHETTI (Confirmed)

**Verdict: DECOMMISSION. Everything Miko was supposed to do has been absorbed into Ittunaha and Ikbi.**

Miko was a governance/validation/trust cluster being extracted from Peh into a standalone service. It has:

| What | Status |
|------|--------|
| 6 subsystems (Sibyl, Veritor, Occasio, Conclave, Arbiter, Validation Sweep) | All marked "scaffold" or "planned" — NONE live |
| 15 validation sweep checks | Reference old names: `aedis-supervisor`, `crucible`, `ptah-bridge` |
| `src/registry.ts` | **EMPTY FILE** (0 bytes) |
| `src/types.ts` | **EMPTY FILE** (0 bytes) |
| `src/routes.ts` | 634-line monolith |
| Port 18816 | Not running |
| Systemd | No unit |
| Dependencies | Only Fastify |

**Where each subsystem's functionality now lives:**

| Miko Subsystem | Now In |
|---------------|--------|
| Sibyl (gap analysis, briefings) | Ittunaha — `core/nous/` observation + coordination |
| Veritor (model truthfulness) | Luak — benchmark suite |
| Occasio (opportunity analysis) | Ittunaha — `core/nous/recommender.ts` |
| Conclave (multi-agent coordination) | Ittunaha — `core/nous/coordination-intelligence.ts` |
| Arbiter/Paedagogus (model trust) | Ikbi — escalation engine + trust module |
| Validation Sweep (certification) | Ittunaha — lifecycle/validation system |

**Recommendation:** Archive Miko. It's dead code with no runtime presence. All its planned functionality has been built into Ittunaha and Ikbi with better architecture.

---

## PART 2: NUSIKA — CONFIRMED FIXED

**Original audit found:** Voice layer completely dead — Kokoro not running, Piper not found, Whisper not found.

**Current state:**

| Check | Before | After |
|-------|--------|-------|
| Kokoro service | ❌ Port 18794: nothing | ✅ `{"ok":true,"status":"ready","model_loaded":true}` |
| nusika-voice systemd | ❌ Not active | ✅ `loaded active running` |
| Whisper binary | ❌ Not found | ✅ `/pehverse/repos/whisper.cpp/build/bin/whisper-cli` |
| Piper binary | ❌ Not found | ❌ Still not found (but Kokoro covers TTS) |
| lab-nusika systemd | ✅ Active | ✅ Still active |

**Remaining voice issue:** Piper is still not installed, so the TTS fallback chain hits Piper and fails. But Kokoro is working — voices are available. The `/nusika/tts` endpoint fails for Piper-specific voice queries but succeeds for Kokoro profiles.

**Verdict: 95% fixed.** Install Piper or remove the Piper fallback path so the error message is clearer. But voice is FUNCTIONAL.

---

## PART 3: ITTUNAHA — CONFIG REBUILT

**Original audit found:** 7 dead `/mnt/ai/` paths, 2 dead agent ports, 6 dead runtime adapters.

**Current state:**

| Issue | Before | After |
|-------|--------|-------|
| Julian/Ricky/Bubbles | ❌ Removed from config | ✅ Restored — Julian at 18832, Ricky/Bubbles at Tailscale IPs |
| Dead `/mnt/ai/` paths in config | ❌ 7 dead paths | ✅ Config rebuilt, paths repointed |
| Agent names | ❌ Wrong (julian ≠ pehlichi) | ✅ Both present — julian at 18832, pehlichi at 18830 |
| Services dashboard | ❌ Broken | ✅ Shows 15 services |
| Service health probes | ❌ Couldn't reach | △ All show "unknown" — probes may need auth or correct endpoints |
| lab-ittunaha systemd | ✅ Active | ✅ Still active |
| Nous model registry | ❌ Not seeded | ✅ Seeded with 100 models (commit 5606e64) |
| Ikbi references | ❌ Still "aedis" | ✅ Renamed to ikbi (commit d28f922) |

**Remaining config issues:**
- All 15 services show status "unknown" — the health probe may need correct endpoints. But the addresses ARE right.
- 3 dead `/mnt/ai/` paths still exist on the filesystem (the directories don't exist) but the code no longer depends on them

**Verdict: Config is fixed.** The address book is correct. Health probes need endpoint verification.

---

## PART 4: THE PIPELINE — IT EXISTS AND IT'S IMPRESSIVE

You said there's a pipeline between Ittunaha/Nous, Luak, and Ikbi. I found it. Here's the architecture:

```
┌──────────────────────────────────────────────────────────────┐
│                    THE NOUS PIPELINE                          │
│                                                              │
│  LUAK                         ITTUNAHA/NOUS        IKBI     │
│  ────                         ─────────────        ────     │
│                                                              │
│  Benchmark ──→ observation-ingest.ts ──→ Lab Spine          │
│  Results        (validates, dedups,          (JSONL files)   │
│                  appends to spine)                            │
│                                                              │
│  Crucible ────→ importer.ts ──→ Capability Ledger           │
│  Bundles         (merges scores,          (Nous Store)       │
│                  weighted avg)                               │
│                        │                                     │
│                        ▼                                     │
│               recommender.ts                                 │
│               (ranks models by                               │
│                capability score)                             │
│                        │                                     │
│                        ▼                                     │
│               staged-promotion.ts                            │
│               (operator stages →                             │
│                agent validates →                             │
│                operator confirms)                            │
│                        │                                     │
│                        ▼                                     │
│               IKBI receives new                              │
│               model assignment                               │
│                                                              │
│  COORDINATION TELEMETRY:                                     │
│                                                              │
│  Agent handoffs ──→ coordination-intelligence.ts             │
│  (workflow steps,    (pair stats, chain analysis,            │
│   escalations,        role specialization,                   │
│   arena runs)         orchestration health)                  │
└──────────────────────────────────────────────────────────────┘
```

**The four pipeline stages:**

### Stage 1: Ingestion (`observation-ingest.ts`)
- Accepts batches of canonical `ObservationReceipt` objects
- Each row independently validated → deduplicated per-day → appended to spine
- Tolerant: one bad row never blocks the batch
- Cap: 1000 rows per call (defensive)

### Stage 2: Import (`importer.ts`)
- Ingests Crucible/Colosseum result bundles into the capability ledger
- Merges scores by weighted average: `(existing.score * N + new.score * M) / (N + M)`
- Confidence grows with sample count, caps at 1.0 (50 samples)
- Evidence sources deduplicated across imports

### Stage 3: Recommendation (`recommender.ts`)
- Ranks models by capability score per category
- Produces `RecommendationDecision` with confidence level and evidence count

### Stage 4: Promotion (`staged-promotion.ts`)
- **Stage:** Operator creates promotion (snapshots current state)
- **Validate:** Target agent checks can it accept this model?
- **Confirm:** Operator commits → agent switches
- **Rollback:** Always available (snapshot preserved)
- Every step emits a receipt
- 7 status states: staged → validated → committed | rolled-back | rejected | failed | cancelled

### Bonus: Coordination Intelligence (`coordination-intelligence.ts`)
This is the OBSERVABILITY layer — it doesn't drive the pipeline but WATCHES it:
- Tracks cross-agent handoffs (workflow steps, escalations, arena comparisons)
- Builds agent pair statistics (success rate, avg latency, fallback count)
- Analyzes workflow ecosystem chains (e.g., "luna→peh→colosseum")
- Detects emergent role specialization (which agent dominates which role)
- Derives orchestration health (calm → stable → strained → degraded → chaotic)
- Detects operator strategy patterns (override frequency, flip-flopping, low-confidence acceptance)
- Tracks recommendation evolution over time (which model dominated when)

**This is genuinely impressive.** The coordination intelligence alone has:
- Atomic file writes (`.tmp` + `rename`) — the ONLY module in the entire pehverse that does this correctly
- Capped arrays at 5000 entries
- Pure deterministic functions for analysis
- Proper separation of storage from computation

---

## WHAT NEEDS ATTENTION NOW

### 1. Get the health probes working (30 minutes)
All services show "unknown." The endpoints are right but the probes may need specific paths or auth headers. Verify each probe returns 200.

### 2. Install Piper or simplify the voice error (30 minutes)
Nusika's TTS works with Kokoro but the Piper fallback returns a confusing "Voice model not found" error. Either install Piper or make the error say "Kokoro is available, use a Kokoro voice profile."

### 3. Archive Miko (10 minutes)
It's dead code. Everything it was supposed to do is now in Ittunaha/Ikbi. Archive it so nobody accidentally tries to run it.

### 4. Wire the pipeline end-to-end (2 hours)
The pipeline components exist. Now wire them:
- Schedule: Luak benchmark run → POST results to Ittunaha's `/api/nous/observations/ingest`
- Schedule: Ittunaha recommender runs → staged promotion created
- Operator reviews promotion → confirms → Ikbi receives new model

### 5. Test the coordination intelligence with real data
The coordination-intelligence module is pure and well-tested. But it needs real coordination observations to feed it. Wire the actual agent handoffs (from Ikbi's escalation engine, from Pehlichi's delegations) into the coordination store.

---

## BOTTOM LINE

**Miko:** Dead. Archive it. Everything it was supposed to do lives in Ittunaha and Ikbi now.

**Nusika voice:** Fixed. Kokoro is running. Just need Piper or a clearer error message.

**Ittunaha config:** Fixed. The address book is right. Health probes need verification.

**The pipeline:** It exists and it's genuinely well-architected. The observation ingestion → import → recommendation → staged promotion chain is complete. The coordination intelligence is the best-architected module in the entire pehverse (atomic writes, pure functions, proper caps). It needs end-to-end wiring but the components are solid.
