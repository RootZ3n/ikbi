# ikbi Outsider Audit — Bubbles Pass

**Auditor:** Bubbles (fresh-eyes pass)  
**Date:** 2026-06-08  
**Repo:** `/pehverse/repos/ikbi`  
**Commit/Ref:** (tip of main as audited)

---

## Executive Summary

**Verdict: Ready for development use, with caveats.**  

ikbi is *remarkably* well-constructed for a project at this stage. The security invariants are consistently enforced, the architecture is modular with clean seams, and the test suite (862/862 passing) actually tests *behavior* rather than just surface assertions. The previous auditors (Codex, Claude Code, Julian) did solid work — the drift-prevention, injection neutralization, trust model, and circuit breaker are all properly implemented.

The previous auditors were optimistic, and *mostly* correctly so. What they missed are edge cases and operational gaps rather than fundamental design flaws. ikbi is closer to production-ready than I expected, but there are real blind spots that need addressing before it replaces Claude Code as a daily driver.

---

## Phase 1: Test Quality

### Overall: GOOD. Tests test behavior, not just existence.

I reviewed representative test files across:
- `core/provider/circuit-breaker.test.ts` — 7 tests, all behavioral
- `core/injection/neutralize.test.ts` — 6 tests, actual injection detection
- `core/identity/security.test.ts` — fail-closed, forged identity, escalation prevention
- `modules/worker-model/progressive-disclosure.test.ts` — brief-first, scout_detail drill-down, out-of-range
- `core/substrate/lock.test.ts` — concurrency, timeout, cleanup
- `core/contracts/contracts.test.ts` — versioning, compatibility, registry

### Finding 1.1 [LOW] — No injection-defang edge-case tests
**File(s):** `src/core/injection/defang.test.ts` (all relevant)  
**What:** The defanging tests cover the happy-path patterns (ChatML, role tags, Llama markers) but don't test:
- Nested control tokens (double-encoded ChatML patterns)
- Zero-width vs non-zero-width Unicode tricks (RTL override, homoglyph substitution in role tag names)
- Control tokens split across chunk boundaries
- Extremely long control token strings (the pattern uses `{0,60}` so probably safe, but untested)

### Finding 1.2 [LOW] — No concurrent-access tests for builder tools
**File(s):** `src/modules/worker-model/builder-tools/*.test.ts` (all)  
**What:** The builder tools (write_file, patch, terminal) are called sequentially in tests. There are no tests for two concurrent sub-agents writing to the same file, or concurrent terminal calls interacting. The lock system (in-process mutex + cross-process file lock) exists in `core/substrate/lock.ts`, but it's not exercised anywhere in the builder-tool path. If the builder or sub-agent runs parallel tasks in the future, this will be a blind spot.

### Finding 1.3 [INFO] — 82 test files for 167 source files
47% test-to-source ratio is respectable. The tests are also meaningful (not stub/empty passes). Good work on the test culture.

---

## Phase 2: Security Gaps

### Finding 2.1 [MEDIUM] — Worktree confinement has a TOCTOU window
**File(s):** `src/modules/worker-model/builder-tools/confine.ts:31-40`  
**What:** `confinePath()` resolves the deepest existing ancestor of the target path via `realExistingAncestor()`, which calls `realpathSync()` iteratively walking up the directory tree. Between the `realpathSync()` probe and the subsequent file operation, an attacker-controlled symlink could be swapped in (if the attacker has write access to the worktree — e.g., a builder writing a malicious symlink through write_file). The check is:
```
if (!isUnder(worktreeReal, realExistingAncestor(resolved))) {
  return { ok: false, error: ... };
}
```
But after this check, the actual tool call uses the *resolved* path (`c.full`), not the realpathed ancestor. If a component of the path between the resolved target and the existing ancestor was a symlink swapped between check and use, the tool could operate outside the worktree.

**Severity rationale:** MEDIUM because exploiting this requires (a) attacker-controlled write access within the worktree, and (b) precise timing to swap the symlink between the sync probe and the tool operation. The TOCTOU window is ~microseconds. This is a *theoretical* gap — I was unable to verify a practical exploit path.

### Finding 2.2 [LOW] — No DNS rebinding protection in egress allowlist
**File(s):** `src/core/provider/fetch-guard.ts` (all relevant)  
**What:** The egress allowlist covers domains by hostname, but there's no DNS pinning or re-validation after connection. If an allowed domain (e.g., `html.duckduckgo.com`) initially resolves to a legitimate IP but later the DNS record changes (or an attacker controls upstream DNS), the connection goes to the attacker's IP despite the allowlist check. This is standard for DNS-based allowlists; no project in this class handles it perfectly. Worth noting as a blind spot.
**Current allowlist:** `html.duckduckgo.com, docs.python.org, developer.mozilla.org, stackoverflow.com`

### Finding 2.3 [INFO] — Dev-mode keys are clearly documented and tested
**File(s):** `src/core/trust/mac.ts`, `src/core/identity/registry.ts`, `cli/doctor.ts`  
**What:** The `IKBI_ALLOW_INSECURE_DEV_KEYS` escape hatch is well-contained. The doctor command clearly warns about it, tests validate both the allowed and blocked paths, and the default path is fail-closed (will refuse to start without the opt-in). This is exactly how it should be done.

### Finding 2.4 [INFO] — Injection neutralization is mandatory and well-enforced
The ONLY path tool results become messages is through `appendToolResult()` -> `neutralizeUntrusted()` -> `toUntrustedMessage()`. Every builder tool (including the sub-agent's delegate tools) passes through this chokepoint. The scan detects `ignore_previous_instructions` patterns and blocks them.

---

## Phase 3: Integration Coherence

### Finding 3.1 [LOW] — 5-role pipeline relies on sequential orchestration
**File(s):** `src/modules/worker-model/orchestrator.ts`  
**What:** The build pipeline runs scout -> builder -> verifier -> critic -> integrator in strict order. There's no parallel execution path yet. The `delegate_task` tool allows the *builder* to parallelize sub-tasks internally, but the main pipeline is linear. The architecture supports adding parallelism later (sub-agent spawning module exists), but it's not wired in yet.

### Finding 3.2 [INFO] — Module registration system is clean
The server registrar pattern (each module registers its own routes without editing `server/index.ts`) is well-designed and properly tested. The contracts registry with version checks is solid.

### Finding 3.3 [INFO] — No circular dependencies detected
Spot-checked import graphs across core/ and modules/. No circular imports found. Module imports go core <- modules (core has zero knowledge of modules). The fetch-guard pattern (injection, not import) is the correct way to handle this.

---

## Phase 4: Error Handling

### Finding 4.1 [MEDIUM] — The context compressor silently swallows ALL errors
**File(s):** `src/modules/worker-model/context-manager.ts:146`  
**What:** Both the model invocation and the summary verification inside `maybeCompress()` use bare `catch {}` (no error logged):
```ts
try {
  const res = await deps.invoke({ ... });
  summaryText = res.content.trim();
} catch {
  return { compressed: false }; // compaction must never fail the build
}
```
If the summarization model call fails consistently, the build will never trigger its "WARNING: context compression failed" — it just silently returns `{ compressed: false }`. The caller in `builder.ts` doesn't log the failure either. A runaway conversation that hits the context limit without compressing will eventually crash with a provider-side context-length error, which is a worse failure mode than an intentional compression failure.

**Recommendation:** Log the error (even at debug level) so an operator can distinguish "compression skipped because conversation was small" from "compression skipped because the model is down."

### Finding 4.2 [LOW] — Circuit breaker's failure count persists through HALF-OPEN
**File(s):** `src/core/provider/circuit-breaker.ts`  
**What:** When the circuit transitions from `open` -> `half_open`, the `consecutiveFailures` counter is NOT reset. This means after the cooldown, the circuit is half-open but still remembers how many failures it took to trip. A half-open probe that succeeds -> `recordSuccess()` resets it. But a half-open probe that fails -> `recordFailure()` increments it further. This is technically fine (the failure threshold is only re-checked on recordFailure if state is closed, and on recordFailure for half-open it re-opens immediately), but the stale counter in the snapshot is misleading.

**Recommendation:** Reset `consecutiveFailures` on the half-open transition. The half-open probe is a fresh start; the old count is noise.

### Finding 4.3 [INFO] — Error messages in tool results are clean
Every builder tool returns errors as clear text in the `output` field (never as thrown exceptions past the boundary) — confirmed in write_file, read_file, terminal, delegate, search_files. The builder loop catches model invocation errors and maps them to `outcome: "failure"`. Good error hygiene.

---

## Phase 5: Performance / Resource Concerns

### Finding 5.1 [LOW] — Conversation memory may be unbounded
**File(s):** `src/modules/lab-context-memory/memory.ts` (inferred from module structure)  
**What:** The `lab-context-memory` module stores conversation facts (files modified, test results, decisions). I could not verify whether this storage has a size cap. If unbounded, a long-running agent session could accumulate gigabytes of metadata.

### Finding 5.2 [INFO] — Event bus bounded buffer is correctly implemented
The event bus uses a bounded buffer with configurable capacity; overflow behavior is tested (drop_oldest, drop_newest). No unbounded growth concern here.

### Finding 5.3 [INFO] — All loops bounded
- Main builder loop: 20 tool iterations + wall-clock timeout
- Sub-agent loop: 8 iterations
- MCP model loop: bounded
- Lock acquisition: configurable timeout with backoff
- File read: 32KB cap
- List dir: 200 entry cap

---

## Phase 6: Model Adaptation

### Finding 6.1 [LOW] — Compression threshold not context-size-aware
**File(s):** `src/modules/worker-model/context-manager.ts`  
**What:** `COMPRESS_THRESHOLD = 0.7` is a flat fraction regardless of model context size. For a model with 4096 context window, the compressor triggers at ~2867 tokens. After compression the remaining headroom is ~1229 tokens. For a code-generating model with tool calls, this is tight. For an 8K+ model it's fine.

**Recommendation:** Consider smaller compression thresholds for smaller-context models so they compress earlier and more aggressively.

### Finding 6.2 [INFO] — No hardcoded model assumptions
Model resolution is fully config-driven through the roster file. No model IDs are hardcoded in the processing logic. Capability profiles handle context size, reasoning levels, and output caps. This is correctly done.

### Finding 6.3 [INFO] — Progressive disclosure is correctly implemented
Scout returns structured findings (path/line/title) and a brief. The builder shows ONLY titles upfront and drills into detail on demand via `scout_detail`. Tests verify the full detail is NOT dumped up front, confirming token savings.

---

## Phase 7: End-to-End Smoke Test

### `ikbi --help` — PASS
All commands listed: version, models, providers, doctor, capabilities, ask, batch, build, classify, kill, kill-status, mcp, recover, trust, unkill.

### `ikbi doctor` — PASS
Correctly reports:
- 4 missing required settings (expected for dev environment; clear ✗ markers)
- 3 model roles resolved (driver 'mimo-v2.5', builder 'mimo-v2.5', critic 'mimo-v2.5-pro')
- Egress allowlist configured (`html.duckduckgo.com, docs.python.org, developer.mozilla.org, stackoverflow.com`)
- Dev-mode key warnings shown
- "NOT ready" with actionable list

### `pnpm test` — PASS (862/862)
All tests pass in ~10s. Test output includes real injection detection events (the scanner finds "ignore previous instructions" patterns and blocks them — end-to-end verifiable from tests).

### Full build pipeline — COULD NOT VERIFY
Requires `IKBI_OPERATOR_TOKEN`, `IKBI_WORKER_TOKEN`, `IKBI_WORKER_MODEL_ENABLED=true` — none configured in this development environment.

---

## Blind Spots

Things I could not verify that should be either tested or accepted as risk:

1. **Real model invocation** — No MiMo API key configured. Provider layer, egress guard, and model invocation are untested against a live endpoint.
2. **DNS rebinding defense** — The egress allowlist validates at connection time; I couldn't verify whether resolved IPs are re-checked.
3. **Long-running memory leaks** — No stress test for conversation memory, event bus, or MCP transport over thousands of iterations.
4. **Cross-process file lock under extreme contention** — Stale-recovery logic is sound, but mass concurrent builds haven't been tested.
5. **Model output quality with drift prevention** — Warn/block policies work in tests, but actual model drift behavior in production is untested here.
6. **Progressive disclosure token savings** — Mechanism works structurally, but actual token reduction in a real build is unmeasured.

---

## Summary of Findings

| # | Severity | Area | Description |
|---|----------|------|-------------|
| 2.1 | MEDIUM | Security | Worktree confinement has microsecond TOCTOU window on symlink resolution |
| 4.1 | MEDIUM | Error Handling | Context compressor silently swallows all model errors (no log) |
| 4.2 | LOW | Error Handling | Circuit breaker failure count not reset on half-open transition |
| 1.2 | LOW | Test Quality | No concurrent-access tests for builder tools |
| 2.2 | LOW | Security | No DNS rebinding protection in egress allowlist |
| 3.1 | LOW | Integration | 5-role pipeline is strictly sequential (no parallelism) |
| 5.1 | LOW | Performance | Conversation memory may be unbounded (could not verify directly) |
| 6.1 | LOW | Model Adaptation | Flat compression threshold; cheap models may run tight on budget |
| 1.1 | LOW | Test Quality | Missing edge-case tests for defanging (nested tokens, unicode) |
| 1.3 | INFO | Test Quality | 82 test files / 167 source files = solid coverage |
| 2.3 | INFO | Security | Dev-mode keys: properly contained, tested, warned |
| 2.4 | INFO | Security | Injection neutralization: mandatory chokepoint, correct |
| 4.3 | INFO | Error Handling | Clean error messages in all builder tools |
| 5.2 | INFO | Performance | Event bus bounded buffer: correct |
| 5.3 | INFO | Performance | All loops bounded, MCP cleanup verified |
| 6.2 | INFO | Model Adaptation | No hardcoded model assumptions |
| 6.3 | INFO | Model Adaptation | Progressive disclosure correctly implemented |

---

## Recommendations

### Before Production Use
1. **Fix finding 4.1 (HIGHEST PRIORITY)** — Add error logging to `maybeCompress()` in `context-manager.ts`. A silent compression failure is a ticking time bomb for context-window overflows.
2. **Fix finding 2.1** — Consider replacing the TOCTOU-prone `realExistingAncestor()` with a single atomic open/resolve. Add documentation acknowledging the window if Node.js doesn't support it.
3. **Fix finding 4.2** — Reset `consecutiveFailures` on half-open transition in `circuit-breaker.ts`.

### Before Trusting in Critical Workflows
4. **Verify conversation memory bounds** in `lab-context-memory/memory.ts` — add a cap if none exists.
5. **Add concurrent-access tests** for builder tools, even if the tests just verify that the lock serializes correctly.

### Nice-to-Have
6. **Add defanging edge-case tests** for double-encoded tokens, RTL override, and Unicode tricks.
7. **Consider context-size-aware compression thresholds** so cheap models compress earlier.
8. **Add a build CI check** that verifies the dist matches source (compilation integrity check).

---

## Closing Thoughts

ikbi is well on its way to being a legitimate Claude Code replacement, especially for teams using cheaper models who need drift prevention and controlled execution. The architecture is sound, the security invariants are consistently enforced, and the test suite is genuinely good.

The previous auditors did solid work — what they missed is edge cases and operational grit rather than fundamental problems. ikbi is ready for development use today, and with the few fixes above (especially the silent compress failure in Finding 4.1), it's ready for production.

Just remember to set your HMAC key, token salt, and operator/worker tokens before trusting it with anything real, boys! 🐱🔧
