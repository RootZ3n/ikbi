# IKBI Phase 5 Operational-Friction Audit

**Date:** 2026-08-06
**Auditor:** Hermes Agent (Ricky persona, Julian logic)
**Branch:** state-bound-mutation-hardening
**HEAD:** 468a21a (test: add capability-aware test profiles)
**Fixture:** /tmp/ikbi-cold-test (preserved, acceptance fixture for vertical slice)

---

## 1. CAPABILITY-ENABLED BASELINE

**Repository:** /pehverse/repos/ecosystem/ikbi
**Branch:** state-bound-mutation-hardening
**HEAD:** 468a21a

**Expected Phase Commits — All Confirmed:**
- ✓ 2a977db — feat(workspace): add state-bound mutation core
- ✓ fd49f96 — feat(worker): bind builder and chat edits to observations
- ✓ 9993823 — feat(repair): bind repair and replay mutations to candidate state
- ✓ 468a21a — test: add capability-aware test profiles

**Environment:**
- Node: v22.22.3
- npm: 10.9.8
- OS: Linux 7.1.6-201.fc44.x86_64 (Fedora)
- Shell: /bin/bash

**Test Doctor — All Capabilities Supported:**
- ✓ tempWritable
- ✓ subprocess
- ✓ processSignal
- ✓ symlink
- ✓ fsyncRename
- ✓ gitExecutable (git 2.55.0)
- ✓ gitRepository
- ✓ gitWorktree
- ✓ crossProcessLock
- ✓ localhostIpv4
- ✓ localhostIpv6

**Test Results:**
- **deterministic:** 342 suites, 3,983 tests, 3,982 pass, 0 fail, 1 skipped
- **integration:** 17 suites, 426 tests, 426 pass, 0 fail
- **full:** Both profiles combined — all green

**Integration Suite Names (17):**
1. src/acceptance/cli-smoke.test.ts
2. src/acceptance/verifier-target.test.ts
3. src/modules/worker-model/checks-nonjs.test.ts
4. src/modules/worker-model/critic-recovery-conformance.test.ts
5. src/modules/worker-model/invocation-ledger-conformance.test.ts
6. src/modules/worker-model/orchestrator.test.ts
7. src/modules/worker-model/phase11b-lane-authority-conformance.test.ts
8. src/modules/worker-model/phase11c-receipt-authority-conformance.test.ts
9. src/modules/worker-model/phase12-semantic-substance-conformance.test.ts
10. src/modules/worker-model/phase13-immutable-verification-conformance.test.ts
11. src/modules/worker-model/phase13b-frozen-snapshot-conformance.test.ts
12. src/modules/worker-model/phase13c-physical-snapshot-conformance.test.ts
13. src/modules/worker-model/phase15-evidence-relevance-conformance.test.ts
14. src/modules/worker-model/phase16-quarantine-conformance.test.ts
15. src/modules/worker-model/promotion-authority-conformance.test.ts
16. src/modules/worker-model/safety-evidence-conformance.test.ts
17. src/server/tasks.test.ts

**Build:** PASS · **Typecheck:** PASS · **All 342 suites genuinely green.**

---

## 2. COLD-AGENT FIXTURE

**Location:** `/tmp/ikbi-cold-test` (preserved, disposable)
**Contents:** Minimal TypeScript project with calculator module containing a deterministic defect (sum() skips first element due to loop starting at index 1)
**Initial state:** 6 tests, 3 failing (sum of array, negative numbers, single element)
**Git:** Clean initial commit on master branch

**Fixture code:**
```typescript
// src/calculator.ts — BUG: loop starts at index 1
export function sum(numbers: number[]): number {
  let result = 0;
  for (let i = 1; i < numbers.length; i++) { // BUG: should be i = 0
    result += numbers[i];
  }
  return result;
}
```

---

## 3. FIRST SUCCESSFUL PUBLIC INVOCATION

**ikbi fix** succeeded on the cold fixture:
```
ikbi fix /tmp/ikbi-cold-test --check "npm test"
```

**Result:** FIXED_NARROWLY
- Reproduced: exit 1 — 2 failures (sum, calculator)
- Diagnosis: implementation_bug (confidence 1.00)
- Diagnosis text: "The test expects sum([42]) to return 42 but the code starts its loop at index 1"
- Patched: src/calculator.ts (loop index 1 → 0)
- Targeted check: PASS
- Full check: PASS (0 regressions)
- Anti-cheat: All 4 checks PASS
- Promoted: No (fix mode never promotes)

**ikbi build** failed due to provider misconfiguration (see friction register).

---

## 4. EVERY GUESS, WORKAROUND, AND SOURCE-CODE LOOKUP REQUIRED

| # | What I Had to Figure Out | How | Friction |
|---|--------------------------|-----|----------|
| 1 | How to invoke ikbi | README.md Quickstart | Low |
| 2 | Which env vars are required | README + INSTALL.md + .env.example | Medium — scattered across 3 files |
| 3 | That trust keys are mandatory | Error message + INSTALL.md | Medium — error says "refuses to start" but dev keys bypass |
| 4 | That IKBI_ALLOW_INSECURE_DEV_KEYS exists | .env.example comment | Medium — buried in comments |
| 5 | That ikbi's provider roster is separate from system config | Tried build, got provider error | High — nowhere does it say "ikbi ignores your system API keys" |
| 6 | How to configure MiMo provider | MANUAL.md provider table | High — must create providers.json manually |
| 7 | That `workspace inspect` doesn't exist | Tried command, got error | Medium — help shows `workspaces inspect` not `workspace inspect` |
| 8 | That fix mode works without provider config | Tried fix, it worked | Lucky — fix uses local model-free diagnosis |
| 9 | Where receipts are stored | `ikbi receipts --task` | Low |
| 10 | How to clean up workspaces | `ikbi workspace discard` | Low |

---

## 5. PUBLIC ENTRY-POINT MAP

### Primary Commands (from `ikbi help`)

| Command | Audience | Status | Notes |
|---------|----------|--------|-------|
| `ikbi` (no args) | Developer | Production | Starts REPL |
| `ikbi init` | New user | Production | Guided first-run setup |
| `ikbi build <goal>` | Developer | Production | 5-role pipeline |
| `ikbi models` | Operator | Production | Shows model roster |
| `ikbi serve` | Operator | Production | HTTP server |
| `ikbi help` | Anyone | Production | Basic help |

### Advanced Commands (from `ikbi help --advanced`)

| Command | Audience | Status | Notes |
|---------|----------|--------|-------|
| `ikbi doctor` | Operator | Production | Health check |
| `ikbi fix <repo>` | Developer | Production | Diagnosis-first repair |
| `ikbi repl` | Developer | Production | Interactive session |
| `ikbi audit <repo>` | Operator | Production | Read-only diagnostic |
| `ikbi trust` | Operator | Production | Trust management |
| `ikbi memory` | Operator | Production | Memory governance |
| `ikbi workspace` | Operator | Production | Workspace management |
| `ikbi receipts` | Operator | Production | Audit trail |
| `ikbi diff` | Developer | Production | Workspace diff |
| `ikbi undo` | Developer | Production | Revert promotion |
| `ikbi clean` | Operator | Production | Workspace cleanup |
| `ikbi batch` | Developer | Production | Multi-task builds |
| `ikbi cost` | Operator | Production | Cost tracking |
| `ikbi review` | Developer | Production | Code review |
| `ikbi spec` | Developer | Production | Spec management |
| `ikbi consult` | Developer | Production | Frontier model consultation |
| `ikbi evaluate` | Operator | Production | Model benchmarking |
| `ikbi health` | Operator | Production | Repo health scoring |
| `ikbi detect` | Operator | Production | Project detection |
| `ikbi classify` | Developer | Production | Intent classification |
| `ikbi peh` | Developer | Production | Teaching guide |
| `ikbi monitor` | Operator | Production | Build monitoring |
| `ikbi heal` | Operator | Production | Self-heal |
| `ikbi recover` | Operator | Production | Capability recovery |
| `ikbi kill/unkill` | Operator | Production | Kill switch |
| `ikbi game-studio` | Developer | Production | Game asset management |
| `ikbi agents` | Developer | Production | Agent personas |
| `ikbi ask` | Developer | Production | Lab memory queries |
| `ikbi repos` | Operator | Production | Repo registry |
| `ikbi job-cards` | Developer | Production | Reusable automations |
| `ikbi mcp` | Developer | Experimental | MCP integration |

### Duplicate/Ambiguous Commands

| Issue | Details |
|-------|---------|
| `workspace` vs `workspaces` | Two separate commands with different subcommands |
| `workspace ls` vs `workspaces list` | Both list workspaces but different output |
| `workspace inspect` doesn't exist | Only `workspaces inspect` works |
| `clean` vs `workspace clean` vs `workspaces clean` | Three ways to clean workspaces |

---

## 6. CONFIGURATION PRECEDENCE

**Load order (last wins):**
1. Built-in defaults (in `src/core/config.ts`)
2. `~/.ikbi/env` (user-global)
3. Install-root `.env`
4. `<repo>/.env` (project — non-secrets only)
5. Environment variables (shell)
6. CLI flags

**Special rules:**
- Trust secrets (`IKBI_OPERATOR_TOKEN`, `IKBI_WORKER_TOKEN`, `IKBI_TRUST_HMAC_KEY`, `IKBI_IDENTITY_TOKEN_SALT`) are REFUSED from project `.env`
- `IKBI_ALLOW_INSECURE_DEV_KEYS=true` enables default dev keys (never in production)
- `IKBI_EGRESS_ALLOWLIST` setting REPLACES defaults (must include provider hosts)
- `IKBI_WORKER_MODEL_ENABLED=true` is the master switch for builds

**Resolution chain:**
- Config is loaded once at startup via `loadConfig()` into a frozen singleton
- Modules read their own `IKBI_<MODULE>_*` slice
- Provider roster loaded from `providers.json` in state root
- Model routing determined by `IKBI_MODEL_DRIVER`, `IKBI_MODEL_BUILDER`, `IKBI_MODEL_CRITIC`

---

## 7. PREFLIGHT GAPS

| Check | When | Gap |
|-------|------|-----|
| Trust keys present | Startup | ✓ Doctor reports missing keys |
| Worker token set | Startup | ✓ Doctor reports missing |
| Worker model enabled | Build time | ⚠ Only checked when build starts, not in doctor |
| Provider API key valid | First API call | ⚠ No preflight reachability check |
| Model exists in roster | First API call | ⚠ Error only after scout fails |
| Provider reachable | First API call | ⚠ No connectivity preflight |
| Bubblewrap available | Doctor | ✓ Doctor probes sandbox |
| Git repository valid | Build time | ⚠ No preflight check |
| Test command exists | Fix time | ✓ Fix mode checks |
| Workspace writable | Doctor | ✓ Doctor checks state root |

**Key gap:** No preflight validation that the configured provider/model combination is actually reachable. The build fails at the scout stage after allocating a workspace and consuming startup time.

---

## 8. ERROR AND TERMINAL-RESULT GAPS

| Error | Quality | Gap |
|-------|---------|-----|
| Provider failure | Good | Clear message: "All providers failed for model X" |
| Missing trust keys | Good | Clear message with fix instructions |
| Missing worker token | Good | Clear message |
| Egress blocked | Good | Clear message with fix instructions |
| Command not found | Good | "unknown subcommand" with usage hint |
| Workspace not found | Good | Clear message |
| Sandbox unavailable | Good | Doctor reports, build fails closed |

**Strengths:**
- All errors include stable context (taskId, workspaceId, role)
- Receipts provide complete audit trail
- Failed workspaces are retained for inspection

**Gaps:**
- No machine-readable error codes (just human strings)
- No structured JSON error output by default (need --json flag)
- No pre-flight validation of provider/model reachability

---

## 9. OBSERVABILITY FINDINGS

**Available evidence:**
- Console output (human-readable)
- Receipts (structured, per-task)
- Workspace state (retained on failure)
- Cost tracking (per-task)
- Trust state (MAC-protected)

**Timeline reconstruction:**
- ✓ Run creation → receipt logged
- ✓ Preflight → receipt logged
- ✓ Workspace allocation → receipt logged
- ✓ Provider invocation → receipt logged
- ✓ Tool calls → receipt logged
- ✓ Verification → receipt logged
- ✓ Promotion → receipt logged

**Gaps:**
- No structured event journal (only receipts)
- No replay capability
- No export as diagnostic bundle
- Chronological reconstruction requires manual receipt inspection

---

## 10. INSPECTION/RETRY/REPLAY FINDINGS

| Capability | Available? | How |
|------------|------------|-----|
| List runs | ✓ | `ikbi receipts` |
| Inspect run | ✓ | `ikbi receipts --task <id>` |
| Summarize run | ✓ | `ikbi summary` |
| Explain causally | Partial | Receipts show what happened, not why |
| Resume run | ✗ | Not available |
| Retry from clean | ✗ | Must create new build |
| Replay deterministic | ✗ | Not available |
| Export diagnostic | ✗ | Not available |
| Discard workspace | ✓ | `ikbi workspace discard <id>` |
| Undo promotion | ✓ | `ikbi undo <receipt-id>` |

---

## 11. DOCUMENTATION FINDINGS

**Available documentation:**
- README.md — Quick start, overview, safety model
- docs/INSTALL.md — Detailed installation guide
- docs/MANUAL.md — Comprehensive operator manual (47KB)
- docs/KNOWN-LIMITATIONS.md — Platform limitations
- SECURITY.md — Security model
- CHANGELOG.md — Release notes
- SUPPORT.md — Support boundaries

**Quality:**
- MANUAL.md is excellent — covers every command, config var, and error
- INSTALL.md is clear and actionable
- README.md is good but could link to MANUAL.md more prominently

**Gaps:**
- No single "first build" tutorial that walks through provider setup
- `.env.example` is comprehensive but overwhelming
- Provider configuration requires reading multiple documents
- No documentation that ikbi's provider roster is separate from system config

---

## 12. RANKED OPERATIONAL-FRICTION REGISTER

### FRICTION-001: Provider Configuration Is Invisible
**Severity:** Critical · **Frequency:** Every first run · **Prevents:** First successful build

**Problem:** ikbi has its own provider roster (`providers.json` in state root) that's completely separate from the system's API key configuration. Setting `IKBI_MIMO_API_KEY` in the environment is NOT sufficient — the model must also exist in the providers roster with the correct provider chain.

**Observed:** Build failed with "All providers failed for model 'mimo-v2.5-pro': deepseek=permanent_error" even though MiMo API key was set. The models list showed only deepseek models.

**Root cause:** Provider roster is loaded from `<stateRoot>/providers.json`, not from environment variables. The default roster only includes deepseek models.

**Fix:** `ikbi init` or `ikbi doctor --fix` should detect configured API keys and automatically populate the providers roster.

---

### FRICTION-002: No Provider Preflight
**Severity:** High · **Frequency:** Every first build · **Wastes:** Model tokens + workspace allocation

**Problem:** No validation that the configured provider/model combination is reachable before starting a build. The build allocates a workspace, starts the scout, and only then discovers the provider is misconfigured.

**Observed:** Build created workspace 7dff7fbb6ea0ee66 and 3e136c56d62a3d36 before failing at scout stage.

**Fix:** Add `ikbi doctor --check-providers` that validates API key reachability for all configured providers.

---

### FRICTION-003: Duplicate Workspace Commands
**Severity:** Medium · **Frequency:** Every workspace operation · **Creates:** Confusion

**Problem:** Two separate commands exist:
- `ikbi workspace <ls|discard|clean>`
- `ikbi workspaces <list|inspect|clean>`

`workspace inspect` doesn't exist — only `workspaces inspect` works.

**Fix:** Consolidate into one command or make `workspace` an alias for `workspaces`.

---

### FRICTION-004: CLI Help Is Split
**Severity:** Medium · **Frequency:** Every first session · **Requires:** Discovery

**Problem:** Basic `ikbi help` shows only 6 commands. The full command list requires `ikbi help --advanced`. A new user doesn't know about `fix`, `doctor`, `audit`, etc.

**Fix:** Show all commands in basic help, or add a "see also: ikbi help --advanced" hint.

---

### FRICTION-005: No Machine-Readable Error Codes
**Severity:** Medium · **Frequency:** Every error · **Affects:** Agent automation

**Problem:** Errors are human-readable strings with no stable error codes. An agent parsing output must match on substrings rather than codes.

**Fix:** Add `error_code` field to JSON output (e.g., `PROVIDER_NOT_CONFIGURED`, `MODEL_NOT_IN_ROSTER`).

---

### FRICTION-006: Trust Key Configuration Is Scattered
**Severity:** Medium · **Frequency:** Every first setup · **Requires:** Multiple document reads

**Problem:** Trust key requirements are documented in README.md, INSTALL.md, MANUAL.md, and .env.example. Each says slightly different things. A cold agent must read all four to understand the full picture.

**Fix:** Single canonical trust-key setup guide linked from all other docs.

---

### FRICTION-007: No `ikbi build --dry-run`
**Severity:** Low · **Frequency:** Exploration · **Wastes:** Tokens when testing configuration

**Problem:** No way to test if a build would succeed without actually running it. Must allocate workspace and start scout to discover configuration issues.

**Fix:** Add `ikbi build --dry-run` that validates configuration, provider reachability, and workspace allocation without invoking models.

---

### FRICTION-008: Fix Mode Works Without Provider Config
**Severity:** Positive surprise · **Frequency:** First fix attempt

**Observation:** `ikbi fix` works without any provider configuration because it uses local model-free diagnosis. This is a strength, not a bug — but it's undocumented.

**Fix:** Document that fix mode works without API keys (uses local diagnosis).

---

## 13. FIRST VERTICAL-SLICE PROPOSAL

### `ikbi doctor --check-providers`

**Purpose:** Validate that all configured providers are reachable and all configured models exist in the roster, before starting a build.

**Interface:**
```bash
ikbi doctor --check-providers [--json]
```

**Behavior:**
1. Load config and providers roster
2. For each configured model (driver, builder, critic):
   - Check if model exists in roster
   - Check if provider has API key configured
   - Make a minimal API call (e.g., list models) to validate reachability
3. Report results

**JSON output schema:**
```json
{
  "status": "pass" | "fail",
  "providers": [
    {
      "name": "deepseek",
      "configured": true,
      "reachable": true,
      "models": ["deepseek-v4-flash", "deepseek-v4-pro"]
    },
    {
      "name": "mimo",
      "configured": false,
      "reachable": false,
      "error": "IKBI_MIMO_API_KEY not set"
    }
  ],
  "models": {
    "driver": { "model": "deepseek-v4-flash", "provider": "deepseek", "status": "ok" },
    "builder": { "model": "deepseek-v4-flash", "provider": "deepseek", "status": "ok" },
    "critic": { "model": "deepseek-v4-pro", "provider": "deepseek", "status": "ok" }
  }
}
```

**Error codes:**
- `PROVIDER_NOT_CONFIGURED` — API key not set
- `MODEL_NOT_IN_ROSTER` — Model not in providers.json
- `PROVIDER_UNREACHABLE` — API call failed
- `MODEL_NOT_FOUND` — Model doesn't exist on provider

**Files to modify:**
- `src/modules/health/cli.ts` — Add `--check-providers` flag
- `src/core/provider/` — Add reachability check function
- `src/modules/health/provider-check.ts` — New module for provider validation

**Tests:**
- Unit test: mock provider responses, verify JSON output
- Integration test: real provider reachability check
- E2E test: `ikbi doctor --check-providers --json` on cold install

**Migration risks:** None — additive feature, no existing behavior changed.

**Implementation order:**
1. Add provider reachability check function
2. Add `--check-providers` flag to doctor command
3. Add JSON output format
4. Add tests
5. Update documentation

---

## 14. REQUIRED FILES, SYMBOLS, CONTRACTS, AND TESTS

**Files:**
- `src/modules/health/cli.ts` — Doctor command implementation
- `src/core/provider/` — Provider resolution and API calls
- `src/core/config.ts` — Configuration loading

**Symbols:**
- `loadConfig()` — Configuration loader
- Provider resolution chain
- Model roster loading

**Contracts:**
- JSON output schema (above)
- Error code enum
- Exit codes (0 = all pass, 1 = any fail)

**Tests:**
- `src/modules/health/provider-check.test.ts` — Unit tests
- Integration test in test-runner.sh

---

## 15. DEFERRED WORK

- Structured event journal (beyond receipts)
- Replay capability
- Diagnostic bundle export
- `ikbi build --dry-run`
- Consolidated workspace command
- Unified CLI help
- Machine-readable error codes for all errors
- Provider preflight in `ikbi init`

---

## 16. REASONS IMPLEMENTATION SHOULD NOT BEGIN

None. The first vertical slice is well-scoped, additive, and immediately improves cold-agent usability. No existing behavior is changed.

---

## 17. RECOMMENDED PROMPT FOR CODEX

```
Implement `ikbi doctor --check-providers` — a preflight check that validates
provider reachability before starting a build.

Requirements:
1. Add `--check-providers` flag to the doctor command
2. For each configured model (driver, builder, critic):
   - Verify model exists in providers roster
   - Verify provider has API key configured
   - Make a minimal API call to validate reachability
3. Output structured JSON with `--json` flag
4. Include stable error codes: PROVIDER_NOT_CONFIGURED, MODEL_NOT_IN_ROSTER,
   PROVIDER_UNREACHABLE, MODEL_NOT_FOUND
5. Exit 0 if all checks pass, 1 if any fail
6. Add unit tests for the check function
7. Add integration test that validates against a real provider

Files to modify:
- src/modules/health/cli.ts
- src/core/provider/ (add reachability check)
- src/modules/health/provider-check.ts (new)

Do NOT modify existing doctor behavior — this is additive only.
```

---

## ACCEPTANCE CRITERIA FOR VERTICAL SLICE

The following behaviors must be verified against the preserved fixture (`/tmp/ikbi-cold-test`):

1. A cold external agent can discover configured providers without inspecting source code.
2. Missing provider configuration is detected before any paid invocation.
3. The result is available in machine-readable JSON.
4. The output contains a stable error code and exact recovery instruction.
5. The same cold fixture can successfully proceed after valid configuration is supplied.

---

**Audit complete. No production code was modified. No commits were made. The fixture is preserved at `/tmp/ikbi-cold-test`.**
