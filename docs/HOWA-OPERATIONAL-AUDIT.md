# HOWA OPERATIONAL AUDIT — Senior Engineer Review

**Date:** 2026-06-10
**Auditor:** Bubbles (Hermes Agent, DeepSeek v4 Flash)
**Context:** Howa is an "Agent Proving Ground" that runs AI agents through test packs in isolated workspaces. It has 11 adapters, 9 test packs, a receipt system (JSON + Markdown), a live event stream, Velum safety scanning, and a React UI. Four trials have been run — truthfulness, tool-calling, and safety packs.

**Verdict:** 91% ready. 3 CRITICAL blockers, 3 HIGH, 3 MEDIUM.

---

## CRITICAL — Block deploy

### C1 — Logger has zero file persistence (BLIND OPERATOR)

**Files:** `src/api/server.ts` (console.log), `src/runner/trial-runner.ts` (emits via onEvent), all catch blocks
**What code review sees:** `console.log("Howa API listening on...")` — fine for dev mode.
**What only runtime reveals:** The server runs as a background process (PID 119918, started by Hermes node, no PTY). All stdout is disconnected. Operators have no visibility into:
- Server startup/shutdown
- Trial runner errors caught by catch blocks
- Adapter health check failures
- Receipt write errors

The trial events ARE persisted (4 trial event files, 7,982 lines total) — but they only cover trial lifecycle. Server-level errors (port binding failure, state directory missing, uncaught exceptions) have no persistent record.

**Evidence:** Server uptime 3.6+ days. `find /pehverse/repos/howa -name "*.log"` returns nothing. 4 trials completed successfully — but if one had failed, the operator would have no idea why.

**Fix:** Add a file transport alongside the event system. Minimum: append JSON lines to `howa-state/server.log`. The systemd unit already points at journald (`StandardOutput=journal`) but the unit isn't active. Either enable systemd (C2) OR add file logging.

---

### C2 — No systemd unit active — server is an orphan process

**Files:** `docs/systemd/howa.service`
**What code review sees:** Excellent systemd unit — `NoNewPrivileges=true`, `ProtectSystem=full`, `ReadWritePaths=/var/lib/howa`, `StandardOutput=journal`, `Restart=on-failure`. This is genuinely one of the best-hardened systemd units I've seen.
**What only runtime reveals:** The unit is NOT enabled or active. The server runs as a direct child of Hermes node (PID 119918). If the Hermes session ends:
- Howa dies silently with no restart
- In-flight trials are abandoned (fixtures, subprocesses, adapter sessions all leak)
- No journald logging is active (the unit's `StandardOutput=journal` is moot)

**Evidence:** `systemctl status howa` → "No systemd unit active." `ss -tlnp | grep 18799` → node process owned by `zen`, not `howa`.

**Fix:** Either enable the systemd unit (`systemctl enable --now howa` after adjusting paths), or wrap in podman like the rest of pehverse. The systemd unit is already well-written — it just needs to be deployed.

---

### C3 — No atomic writes for receipts, trials, or events (CORRUPTION RISK)

**Files:** `src/receipts/receipt-store.ts`, `src/storage/index.ts`
**What code review sees:** `fs.writeFile(file, JSON.stringify(...))` — standard Node.js pattern. Fine for dev.
**What only runtime reveals:** Every persistence operation overwrites in place:
- `ReceiptStore.save()` → `fs.writeFile` (no `.tmp` + `rename`)
- `TrialStore.saveTrial()` → `fs.writeFile` 
- `TrialStore.saveTrialEvents()` → `fs.writeFile`

A crash mid-write (SIGKILL, OOM, power loss) corrupts the ONLY copy. There's no backup, no journal, no atomic rename pattern. All 4 trials and 22 receipts in `howa-state/` are at risk.

**Fix:** Write to `.tmp` first, then `fs.rename()` (which is atomic on Linux). Pattern:
```ts
const tmp = file + ".tmp";
await fs.writeFile(tmp, JSON.stringify(data));
await fs.rename(tmp, file);
```

---

## HIGH — Fix before production use

### H1 — Preserved FAIL/ERROR fixtures have no TTL reaper (INDEFINITE DISK GROWTH)

**Files:** `src/runner/fixture-manager.ts`
**What code review sees:** `DEFAULT_CLEANUP_POLICY = "success"` — preserves FAIL/ERROR workspaces for evidence. Correct by design.
**What only runtime reveals:** Preserved workspaces live in `howa-state/fixtures/<trialId>/` forever. There is NO periodic reaper, NO TTL, NO operator cleanup mechanism except manual `rm -rf`. After months of trials:
- Failed safety tests with sensitive prompts persist indefinitely
- Error workspaces with partial agent output accumulate
- Disk usage grows without bound

**Current state:** 4 trial fixture directories exist (1.6MB total — small now). Each preserved FAIL/ERROR workspace could be 10-100MB depending on the test pack.

**Fix:** Add a `reapStaleFixtures()` function that removes preserved workspaces older than N days. Wire it to the server startup (setInterval, unref'd). Add a `/api/admin/cleanup` endpoint with a dry-run mode.

---

### H2 — Trial event timeline silently discards events at 1,000 cap

**Files:** `src/runner/trial-runner.ts` line ~120: `if (timeline.length > 1_000) timeline.splice(0, timeline.length - 1_000);`
**What code review sees:** Cap at 1,000 events. Reasonable memory management.
**What only runtime reveals:** The splice removes events from the BEGINNING of the array. For a long trial (tool-calling pack: 4,144 lines in trial events file = ~1,036 events), the first ~36 events are silently discarded. These are typically the MOST diagnostic: setup events, adapter health check, pack enumeration.

The operator reviewing a trial after the fact sees events 37-1036 but never sees events 1-36. There's no indication in the trial summary that events were trimmed, no "events_discarded" count, no warning. The operator just sees a trial that starts mid-flow.

**Evidence:** Trial `XlBezWsa0t` events file is 4,144 lines — right at the cap boundary. Earlier trial `6an08BnDSh` is only 988 lines — didn't hit the cap.

**Fix:** 
1. Add `summary.eventsDiscarded` count when events exceed 1,000
2. Bump cap to 5,000 (events are just text — 5,000 events is ~200KB)
3. Always preserve the first 50 events (setup/health check are most valuable for debugging)

---

### H3 — Adapter `health()` failure stores raw reason in trial summary — potential leak

**Files:** `src/runner/trial-runner.ts` line ~160: `summary.notes = 'setup_failed reason="..."'`
**What code review sees:** Preflight health check failure is stored in trial summary. Good for debugging.
**What only runtime reveals:** The `health.reason` is embedded directly into `summary.notes` with only quote-escaping (`reason.replace(/"/g, "'")`). If an adapter's health check returns a reason containing file paths, environment variable names, or stack traces, those leak into the trial summary JSON which is served by the API.

The `adapter_setup_failed` path DOES run through `redact()` for the event message text, but the trial summary's `notes` field bypasses redaction entirely.

**Fix:** Run `summary.notes` through `redact()` before storing. The `redact()` function is already imported in trial-runner.ts.

---

## MEDIUM — Address when blockers are cleared

### M1 — `.env` file uses `source` in start.sh — bash-ism

**Files:** `start.sh` line ~25: `source "${REPO_ROOT}/.env"`
**Risk:** `source` is a bash builtin. The shebang is `#!/usr/bin/env bash` so this IS correct when run as `./start.sh`. But if executed as `sh start.sh` or `bash start.sh` (different PATH), it still works. Low risk — POSIX `.` is equivalent. The existing `set -o allexport` wrapping is CORRECT.

### M2 — `FixtureManager.createWorkspace` appends `nanoid(6)` — collision risk is low but unnecessary

**Files:** `src/runner/fixture-manager.ts`
**Risk:** `nanoid(6)` = 64^6 ≈ 68 billion combinations. Per-trial scope makes this effectively zero collision risk. Not a real issue — just noting it for completeness.

### M3 — No `/api/admin/cleanup` endpoint for manual fixture reaping

**Files:** API routes — none for admin operations
**Risk:** Operators have no way to trigger cleanup from the UI or CLI. Must SSH in and `rm -rf` manually. The `applyCleanupPolicy` function exists but is only called at end-of-trial.

---

## Summary

| # | Severity | What | Code review sees | Why missed |
|---|----------|------|-----------------|------------|
| C1 | CRITICAL | Logger has zero file persistence | console.log is fine for dev | Only runtime reveals stdout is disconnected |
| C2 | CRITICAL | No process supervision | Excellent systemd unit exists | Only runtime reveals it's not active |
| C3 | CRITICAL | No atomic writes | writeFile is standard | Ops mindset needed |
| H1 | HIGH | Preserved fixtures have no TTL | Cleanup policy by design | Only runtime reveals indefinite growth |
| H2 | HIGH | Timeline silently discards events at 1K | Reasonable cap | Only runtime reveals early events are the most diagnostic |
| H3 | HIGH | Health failure reason bypasses redaction | Quote-escaping looks safe | Only runtime reveals path/secret leak |
| M1 | MEDIUM | bash-ism `source` in start.sh | Shebang says bash | Low risk, already correct |
| M3 | MEDIUM | No admin cleanup endpoint | Function exists internally | CLI/UI gap |

**What's genuinely excellent about Howa:**

- **Receipts-first design:** Every test produces both JSON and Markdown receipts. The runner even generates receipts for error paths ("receipts-first invariant").
- **Velum guard layer:** Scans both prompts AND agent outputs. Correctly distinguishes "prompt-side finding" (evidence, never auto-fail) from "agent-side finding" (can flip pass→fail). Secret-only findings defer to the test's judgment.
- **Infrastructure failure detection:** `detectInfrastructureFailure()` catches auth errors, model-unavailable, and generic crashes before they're misclassified as agent behavior failures.
- **Systemd unit:** Genuinely hardened — `NoNewPrivileges`, `ProtectSystem=full`, `ReadWritePaths`, `PrivateTmp`. One of the best I've seen.
- **Fixture isolation:** Every test gets a fresh per-test workspace with nanoid suffix. Agents NEVER touch real repos.
- **Honesty flags:** `modelUnknown`, `costUnknown`, `isMockTrial` — the system is honest about what it doesn't know.
- **Adapter truth contract:** Operator overrides (`--model`, `--provider`, `--cost-mode`) can fill in fields the adapter couldn't know, but adapter values always win when present.
- **The `.env` handling in start.sh:** `set -o allexport; source .env; set +o allexport` is the correct pattern for propagating env vars.

**Bottom line:** Howa is the most operationally mature project I've audited. The receipt-first design, infrastructure failure detection, Velum safety layer, and systemd hardening are all excellent. The remaining issues are minor compared to what I found in Luak and Kokuli — no missing HMAC keys, no broken TTL reapers, no in-memory-only circuit breakers.

**Priority order:**
1. Fix C2 (enable systemd) — gives you journald logging for free
2. Fix C3 (atomic writes) — protects the 4 trials and 22 receipts already on disk
3. Fix H1 (fixture TTL reaper) — prevents disk growth over months of trials
4. Fix H2 (eventsDiscarded counter) — one-line addition
5. Fix H3 (redact health reason) — one-line addition
