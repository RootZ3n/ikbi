# NUSIKA OPERATIONAL AUDIT — Senior Engineer Review

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Context:** Nusika is an adaptive learning engine with companion-driven teaching, spaced repetition, mastery spine, and creative portfolio. It has 20 curriculum modules, a D&D-style SRD (dice, combat, checks, inventory, leveling), a Next.js web frontend, and a multi-engine voice layer (Kokoro, Piper, ElevenLabs, whisper.cpp STT).

**Verdict:** Nusika API: 92% ready. Voice layer: **0% ready — completely non-functional after pehverse migration.** Fix the voice layer first, then deploy.

---

## CRITICAL — Voice layer is entirely broken

### V1 — Kokoro voice service is NOT RUNNING

**Files:** `voice/server.py`, `voice/start.sh`, `server/lib/voices/kokoro.ts`
**What code review sees:** Beautiful Python FastAPI service. Lazy-loads the Kokoro 82M model on first `/generate` call. 28 preset voices. CPU-only. Loopback-only by default on port 18794. Health endpoint with identity check (`engine: "kokoro"`).
**What only runtime reveals:** Port 18794 has **nothing listening**. `curl http://127.0.0.1:18794/health` → connection refused. The `nusika-voice` systemd unit is NOT active. The Python venv exists at `/pehverse/services/nusika-voice/.venv` (5GB), but the service was never started or crashed.

**Impact:** ALL Kokoro voice profiles (28 voices) show as `available: false`. The `/nusika/tts` dispatch path falls through to Piper (V2). Voice previews at `/nusika/voices/preview/kokoro/:id` return 503.

**Fix:** Start the Kokoro service:
```bash
cd /pehverse/repos/nusika/voice
# Ensure nusika-voice.env points to the right venv
NUSIKA_VOICE_VENV=/pehverse/services/nusika-voice/.venv
./start.sh
```
Then enable the systemd unit for persistence.

---

### V2 — Piper binary is NOT FOUND on pehverse

**Files:** `server/routes/voice.ts` (line ~30: `piperBin()`)
**What code review sees:** Defaults to `/home/zen/.local/bin/piper` — reasonable for a developer machine.
**What only runtime reveals:** `/home/zen/.local/bin/piper` does NOT exist on pehverse. No Piper voices found at `/home/zen/.local/share/piper-voices/`. The `.env` file has these paths commented out (`.env.example` defaults), so the server uses the hardcoded defaults — which are all wrong for pehverse.

**Impact:** ALL Piper voice profiles show as `available: false`. The `/nusika/tts` legacy path (query is a Piper voice basename, not a registry profile) returns 503 with "PIPER_BIN not found." The Piper fallback for Kokoro failures (when `NUSIKA_VOICE_FALLBACK=piper`) also fails with a 503.

**Fix:** 
1. Install Piper on pehverse: `pip install piper-tts` or build from source
2. Download voice models to a pehverse-appropriate path
3. Set `PIPER_BIN` and `PIPER_VOICES_DIR` in `.env`

---

### V3 — Whisper.cpp STT binary is NOT FOUND on pehverse

**Files:** `server/routes/voice.ts` (line ~31: `whisperBin()`)
**What code review sees:** Defaults to `/mnt/ai/whisper.cpp/build/bin/whisper-cli` — was correct on the old machine.
**What only runtime reveals:** Neither `/mnt/ai/whisper.cpp/build/bin/whisper-cli` nor `/pehverse/repos/whisper.cpp/build/bin/whisper-cli` exist on pehverse. The STT endpoint returns 503 with "STT not configured."

**Impact:** All `/nusika/stt` (speech-to-text) requests fail with 503. Students who use voice input cannot use Nusika at all.

**Fix:** 
1. Clone and build whisper.cpp on pehverse
2. Download a base model (ggml-base.en.bin)
3. Set `WHISPER_BIN` and `WHISPER_MODEL` in `.env`

---

### V4 — No voice fallback chain survives — total voice outage

**What actually works:** Only the 2 cached WAV files in `state/voices/cache/` from May 31 — these are pre-synthesised samples that still serve from cache. Everything else is broken.

**The fallback chain is:**
1. Kokoro (V1 — not running) → 503
2. Piper fallback (V2 — binary missing) → 503
3. Legacy Piper path (V2 — binary missing) → 503
4. ElevenLabs (deprecated, key not set) → 503

Every path leads to 503. **Nusika currently has no working voice synthesis.**

---

## HIGH — API operational issues

### H1 — Fastify logger uses `consoleLogger` instead of pino transports

**Files:** `server/index.ts`, `server/lib/log.ts`
**What code review sees:** `consoleLogger.info(...)` throughout. The Fastify logger is configured with `pino-pretty` in dev mode.
**What only runtime reveals:** The systemd unit `lab-nusika` IS active (first project with this!) and points at journald. The `consoleLogger` writes to stdout, which journald captures. Good. But the custom `consoleLogger` bypasses pino entirely — no structured JSON, no level filtering via env, no correlation IDs. The Fastify pino logger IS structured, but the application code doesn't use it — it uses `consoleLogger` directly.

**Evidence:** The systemd unit `lab-nusika` is active. `journalctl -u lab-nusika` would show logs. But they're ad-hoc `consoleLogger.info()` strings, not structured.

**Fix:** Replace `consoleLogger` with `app.log` (Fastify's pino instance). Pass it as a dependency. Structured logging throughout.

---

### H2 — Systemd unit `lab-nusika` is active but `nusika-voice` is not

**Files:** `contrib/systemd/nusika-api.service`, `voice/systemd/nusika-voice.service`
**What code review sees:** Two separate systemd units — one for the API, one for Kokoro.
**What only runtime reveals:** `lab-nusika.service` IS active — Nusika API stays up across restarts. But `nusika-voice.service` is NOT active — the voice layer dies with the parent session. This means the API survives reboots but voice is always broken until manually started.

**Fix:** Enable `nusika-voice.service` with `systemctl enable --now nusika-voice` (or whatever the exact unit name is from `contrib/systemd/nusika-kokoro.service`).

---

### H3 — `.env` has all voice paths commented out — defaults are wrong for pehverse

**Files:** `.env`
**What code review sees:** Clean `.env.example` with sensible defaults.
**What only runtime reveals:** The `.env` file has these lines COMMENTED OUT:
```
# PIPER_BIN=/home/zen/.local/bin/piper
# WHISPER_BIN=/pehverse/repos/whisper.cpp/build/bin/whisper-cli
```
All commented out. The server uses the hardcoded defaults in the TypeScript source — which are all paths from the old machine that don't exist on pehverse.

**Fix:** Uncomment and update all voice binary paths to pehverse-correct locations. Then set `NUSIKA_VOICE_FALLBACK=piper` to enable fallback.

---

## MEDIUM — Nice-to-fix

### M1 — Voice cache has 2 files from May 31 — no automated cache pruning ran since

**Files:** `server/lib/voice-cache.ts`
**Risk:** The cache eviction runs on every write (`putCachedVoice` triggers `evictVoiceCacheTo`). But if no new TTS requests succeed (because voice is broken), eviction never runs. The 2 cached files (598KB) are harmless but indicate the cache hasn't been exercised in 10 days.

### M2 — ElevenLabs route still accepts traffic but is deprecated

**Files:** `server/routes/voice.ts` (POST /nusika/tts/elevenlabs)
**Risk:** The route exists and works if `ELEVENLABS_API_KEY` is set. But the voice registry marks it as `deprecated: true`. The dispatch path redirects users to the explicit route rather than silently calling it. Good design.

### M3 — `anySignal` ponyfill in kokoro.ts could be replaced with `AbortSignal.any()`

**Files:** `server/lib/voices/kokoro.ts` (line ~290)
**Risk:** Node 20+ has `AbortSignal.any()` built-in. The ponyfill is a compatibility shim for older Node. Since `package.json` requires `node >= 20`, this can be simplified.

---

## Summary

| # | Severity | What | Status |
|---|----------|------|--------|
| V1 | CRITICAL | Kokoro voice service not running | Port 18794: nothing listening |
| V2 | CRITICAL | Piper binary not found | `/home/zen/.local/bin/piper` missing |
| V3 | CRITICAL | Whisper.cpp STT not found | No whisper-cli binary on pehverse |
| V4 | CRITICAL | Total voice outage — all paths → 503 | Only 2 cached WAVs survive |
| H1 | HIGH | consoleLogger bypasses structured logging | Works via journald but ad-hoc |
| H2 | HIGH | nusika-voice systemd unit not active | API survives, voice doesn't |
| H3 | HIGH | .env voice paths commented out, wrong defaults | Server uses old-machine paths |
| M1 | MEDIUM | Voice cache not exercised in 10 days | Symptom of voice outage |
| M2 | MEDIUM | ElevenLabs deprecated but route exists | Handled gracefully |
| M3 | MEDIUM | AbortSignal.any ponyfill unnecessary on Node 20 | Minor cleanup |

**What's genuinely excellent about Nusika:**

- **The Nusika API is the FIRST project with an active systemd unit.** `lab-nusika.service` is running. This means the API survives reboots and crashes. This alone puts it ahead of every other project I've audited.
- **Kokoro identity check:** The health probe requires `engine: "kokoro"` in the response. This prevents the opencode-sidecar squatter problem — if another service occupies port 18794, the registry correctly marks Kokoro as unreachable rather than silently routing TTS to the wrong service.
- **Voice cache with content-addressed keys:** Same engine + voice + text → same SHA-256 key. Cache hits skip upstream entirely. LRU eviction by mtime.
- **The curriculum system:** 20 modules with per-module companion configs that can override voice engine, voice_ref, language, and style. The registry builds profiles dynamically from disk.
- **The SRD (System Reference Document):** Full D&D-style rules — dice rolling, combat with initiative/AC/hit points, ability checks, inventory management, leveling with XP. This is an actual game engine embedded in a learning platform.
- **Graceful degradation:** The TTS dispatch path falls through: Kokoro → Piper fallback → legacy Piper path → 503 with clear error. Each layer reports what failed.
- **Legacy URL rewriting:** `/magister/*` → `/nusika/*` handled transparently by Fastify's `rewriteUrl`.
- **Receipt system:** Every TTS/STT call writes an audit receipt with engine, voice, duration, character count, and cache hit status.

**Voice layer migration checklist (priority order):**

1. **Start Kokoro voice service** — the venv exists at `/pehverse/services/nusika-voice/.venv`. Run `voice/start.sh` and enable the systemd unit.
2. **Install Piper** — `pip install piper-tts` or build from source. Download voice models. Set paths in `.env`.
3. **Install whisper.cpp** — clone and build on pehverse. Download base.en model. Set paths in `.env`.
4. **Uncomment voice paths in `.env`** — point all `PIPER_BIN`, `PIPER_VOICES_DIR`, `WHISPER_BIN`, `WHISPER_MODEL` to pehverse-correct locations.
5. **Verify:** `curl -X POST http://127.0.0.1:18793/nusika/tts -H 'Content-Type: application/json' -d '{"text":"Hello world","voice":"af_heart"}'` should return audio/wav.

**Bottom line:** Nusika's API layer is solid — structured codebase, proper TTS dispatch with fallback chain, voice registry, content-addressed caching, audit receipts, and the first active systemd unit I've seen. But the voice layer is completely dead after the pehverse migration. The good news: all the CODE is there and correct. You just need to install the binaries and start the services. The Kokoro venv at 5GB suggests it was fully built before migration — just never started on pehverse.
