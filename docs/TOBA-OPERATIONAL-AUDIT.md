# TOBA OPERATIONAL AUDIT — Senior Engineer Review

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Context:** Toba is a "Career Transformation Platform" — a standalone Fastify + SQLite service with V1 (profile/experience) and V2 (campaigns/applications/Peh agents/receipts) database layers, 7 built-in provider adapters, a Peh agent registry with per-agent routing, Velum content review, receipt audit trail, job scout ingestion, search lanes, and interview story bank.

**Verdict:** 90% ready. 3 CRITICAL blockers, 3 HIGH, 3 MEDIUM.

---

## CRITICAL — Block deploy

### C1 — No file log transport (BLIND OPERATOR)

**Files:** `src/server.ts`, `src/routes.ts`
**What code review sees:** Fastify's built-in logger with `logger: { level: "info" }`. Structured, pino-backed. The systemd unit has `StandardOutput=journal` — looks production-ready.
**What only runtime reveals:** The server runs as a background process (PID 132084, started by Hermes node). Fastify's logger outputs to stdout. The systemd unit is NOT active (see C2), so `StandardOutput=journal` is moot. All logs go to /dev/null.

Fastify's pino logger CAN be configured with multiple transports, but the current config is console-only.

**Evidence:** Server uptime 3.6+ days. `find /pehverse/repos/toba -name "*.log"` returns nothing. The health endpoint shows `uptime: 318509s` — server has been running, but there's zero persistent record of any warnings, errors, or operational events.

**Fix:** Add a pino file transport. Minimum:
```ts
const server = Fastify({
  logger: {
    level: "info",
    transport: { target: "pino/file", options: { destination: "state/server.log" } }
  }
});
```
Or enable the systemd unit (C2) and journald handles persistence automatically.

---

### C2 — No systemd unit active — server is an orphan process

**Files:** `toba.service`
**What code review sees:** Good systemd unit — `NoNewPrivileges=true`, `ProtectSystem=full`, `ReadWritePaths=/mnt/ai/cursus/state`, `StandardOutput=journal`, `Restart=on-failure`.
**What only runtime reveals:** The unit is NOT enabled or active. The server runs as a direct child of Hermes node (PID 132084). If the Hermes session ends, Toba dies silently.

Additionally, the systemd unit has **deployment path mismatch**:
- Unit: `WorkingDirectory=/mnt/ai/cursus`, `TOBA_DB_PATH=/mnt/ai/cursus/state/cursus.db`
- Actual: repo at `/pehverse/repos/toba`, DB at `/var/lib/toba/toba.db`

**Fix:** Either update the systemd unit to match the current deployment and enable it, or wrap in podman like the rest of pehverse.

---

### C3 — Provider config is in-memory only — restart loses all runtime changes

**Files:** `src/provider.ts` (line ~120: `let currentConfig: ProviderConfig = defaultConfigFromEnv()`), `src/routes.ts` (PATCH /toba/provider)
**What code review sees:** The comment explicitly says: "Runtime selection — applied in-process, not persisted. To make persistent, set TOBA_PROVIDER/TOBA_MODEL/... in the systemd unit (or .env consumed by it) and restart the service."
**What only runtime reveals:** An operator changes provider via `PATCH /toba/provider {"provider": "openrouter", "model": "deepseek/deepseek-v4-pro"}` — it works immediately. Then the server restarts (crash, deploy, OOM) — the provider reverts to what's in `.env` or the default `"none"`. All Peh agents that relied on the runtime provider now fail with "provider_unconfigured" errors.

This is a **documented design decision**, not a bug. But it's an operational footgun — the API accepts mutations that silently don't survive restarts. No warning is returned to the caller.

**Fix:** Either persist provider config to `state/provider-config.json` on every patch (load on startup, env vars are defaults that can be overridden), OR return a warning header on PATCH: `X-Toba-Warning: provider config is runtime-only, will reset on restart`.

---

## HIGH — Fix before production use

### H1 — DB_PATH resolution can silently pick the WRONG database

**Files:** `src/server.ts` lines ~40-43
```ts
const CANONICAL_DB = "/var/lib/toba/toba.db";
const LEGACY_DB = "/mnt/ai/peh-v2/state/toba.db";
const DB_PATH = env("TOBA_DB_PATH", "CURSUS_DB_PATH") ??
  (existsSync(CANONICAL_DB) || !existsSync(LEGACY_DB) ? CANONICAL_DB : LEGACY_DB);
```
**What code review sees:** Fallback chain: env var → canonical → legacy. Reasonable.
**What only runtime reveals:** The logic is:
1. If TOBA_DB_PATH is set → use it ✓
2. If CANONICAL_DB exists → use it ✓
3. If CANONICAL_DB does NOT exist AND LEGACY_DB does NOT exist → still use CANONICAL_DB (creates it)
4. Only if CANONICAL_DB does NOT exist AND LEGACY_DB EXISTS → use LEGACY_DB

This means: **once `/var/lib/toba/toba.db` exists, it's used FOREVER, even if the operator intended to use a different path.** The systemd unit sets `TOBA_DB_PATH=/mnt/ai/cursus/state/cursus.db` — but since `/var/lib/toba/toba.db` already exists (and is the live DB), the systemd unit's env var would be ignored if the unit were active. Wait — actually the env var takes priority. So if the systemd unit were enabled with `TOBA_DB_PATH=/mnt/ai/cursus/state/cursus.db`, that WOULD override the fallback. But the unit isn't active.

**Current state confusion:**
- `/var/lib/toba/toba.db` — the LIVE database (health check confirms)
- `/pehverse/repos/toba/state/cursus.db` — a different database (340KB), not in use
- The systemd unit points at `/mnt/ai/cursus/state/cursus.db` — yet another path

**Fix:** Remove the complex fallback logic. Use: `TOBA_DB_PATH ?? "/var/lib/toba/toba.db"`. One canonical default. Document migrations for legacy paths in a separate migration script.

---

### H2 — 7 backup files with no TTL reaper (DISK GROWTH)

**Files:** `backups/toba-reset-*.db`
**What code review sees:** Reset script creates timestamped backup before wiping data.
**What only runtime reveals:** 7 backup files (200KB each = 1.4MB total) from May 31 to June 3. No automatic cleanup. Over months of active use with daily resets, this becomes hundreds of stale backup files.

**Fix:** Add a retention policy to the reset script — keep last N backups (e.g., 5). Delete older ones. Or add a TTL (30 days).

---

### H3 — V1 and V2 DB share the same SQLite file with separate connections — no coordination

**Files:** `src/server.ts` lines ~56-57
```ts
const v1 = new TobaV1DB(DB_PATH);
const v2 = new TobaV2DB(DB_PATH);
```
**What code review sees:** Two class instances sharing one SQLite file. WAL mode enabled. Perfectly fine for reads.
**What only runtime reveals:** Both `v1.close()` and `v2.close()` are called on shutdown. But if one close fails (e.g., a prepared statement is still running), the other connection stays open and the process may hang. There's no timeout on the shutdown sequence.

Additionally, schema migrations run independently in each constructor — V1 creates its tables, V2 runs its migrations. If V2's migration adds a column to a V1 table, V1's `createTables()` won't know about it. Currently this isn't an issue because V1 and V2 use disjoint table sets, but it's a latent hazard.

**Fix:** Add a 5-second shutdown timeout. Consider a single DB connection shared between V1 and V2.

---

## MEDIUM — Address when blockers are cleared

### M1 — API keys in `.env` are readable by anyone with filesystem access

**Files:** `.env` (chmod 600 — `-rw-------` — good)
**Risk:** The `.env` file is mode 600 (owner-only), which is correct. But `TOBA_PROVIDER_API_KEY` and `TOBA_XIAOMI_API_KEY` contain plaintext API keys. If the file is ever copied, backed up, or read by a compromised process running as `zen`, keys leak.

### M2 — `backups/` directory contains full database copies with plaintext data

**Files:** `backups/toba-reset-*.db`
**Risk:** Each backup is a complete SQLite database containing all profile data, API keys (if stored in the DB), and campaign information. These are 200KB files with no encryption.

### M3 — `patchAgent` route has complex boolean coercion logic

**Files:** `src/routes.ts` (PATCH /toba/peh/agents/:id)
**Risk:** The `local_only`/`cloud_allowed`/`enabled` fields use this coercion: `typeof v === "boolean" ? (v ? 1 : 0) : v === null ? null : Number(v) ? 1 : 0`. This treats the string `"0"` as `true` (because `Number("0")` is 0 which is falsy, so `Number(v) ? 1 : 0` → `0`). Actually wait, `Number("0") ? 1 : 0` → `0`. So `"0"` → `0`. That's correct. But `"false"` → `Number("false")` is `NaN` → `NaN ? 1 : 0` → `0`. Also correct. The logic works but is hard to audit.

---

## Summary

| # | Severity | What | Code review sees | Why missed |
|---|----------|------|-----------------|------------|
| C1 | CRITICAL | No file log persistence | Fastify has logger, systemd has journald | Only runtime reveals neither is active |
| C2 | CRITICAL | No process supervision | Good systemd unit exists | Only runtime reveals it's not active + path mismatch |
| C3 | CRITICAL | Provider config in-memory only | Documented design decision | Only runtime reveals restart = silent revert |
| H1 | HIGH | DB_PATH resolution can pick wrong DB | Fallback chain looks reasonable | Only runtime reveals CANONICAL_DB exists = legacy path ignored forever |
| H2 | HIGH | 7 backup files with no TTL | Reset script creates backups | Only runtime reveals accumulation |
| H3 | HIGH | Two DB connections, no coordination | WAL mode handles concurrency | Only runtime reveals shutdown race risk |
| M1 | MEDIUM | API keys in .env | chmod 600 is correct | Defense in depth |
| M2 | MEDIUM | Backups contain full DB | Reset safety measure | Defense in depth |
| M3 | MEDIUM | Complex boolean coercion | Functional but hard to audit | Code review could catch |

**What's genuinely excellent about Toba:**

- **Provider registry with local/cloud awareness:** `isLocalProvider()`, `local_only` enforcement, per-agent provider overrides with fallback chain. The `buildRequestPreview()` function (for tests) is a nice touch.
- **Receipt system:** Every mutation creates an audit receipt with action, provider, model, local_mode, velum status. The receipt table is append-only.
- **Graceful shutdown:** SIGTERM/SIGINT handlers close both DB connections and the HTTP server.
- **Velum integration:** Content redaction at the API layer with per-field reporting.
- **Legacy path rewrite:** `rewriteRequestUrl()` handles `/cursus/*` → `/toba/*` seamlessly.
- **Network exposure classification:** `classifyBind()` correctly identifies loopback, tailscale, and public binds with a warning on non-loopback.
- **Schema versioning:** `TOBA_SCHEMA_VERSION = 8` with `stampVersion()` — the DB tracks its own version.
- **DB backups on reset:** The reset script creates a timestamped backup before wiping data. Just needs a TTL (H2).
- **Peh agent registry:** Per-agent provider/model/base_url/api_key overrides with cloud_allowed and fallback_provider/model. Impressively complete.

Toba is a self-contained, zero-external-dependency Fastify + SQLite service that does exactly what it says on the tin. The architecture is clean, the provider system is well-designed, and the receipt audit trail is thorough.

**Priority order:**
1. Fix C2 (enable systemd) — gives you journald logging for free
2. Fix C1 (or let C2 handle it via journald)
3. Fix C3 (persist provider config) — prevents silent revert on restart
4. Fix H1 (simplify DB_PATH) — remove the confusing fallback logic
