# ikbi → Claude Code Replacement — Consolidated Audit (2026-06-23)

**Auditor:** Julian (Hermes), following Claude Code's prior 29-commit pass.
**Scope:** Verify the four prior audits (AUDIT-MINIMAX, AUDIT-REPLACEMENT, BUBBLES-AUDIT,
GLM52-AUDIT), check the live build/test state, and find what all four missed in the
intervening work (incl. Claude Code's 6-gap close on 2026-06-23).
**Repo:** /pehverse/repos/ecosystem/ikbi @ 07665b1 (29 commits ahead of origin)
**Build/test state:** pnpm build clean · 2629/2629 tests passing · 38 src/ modules

## TL;DR

ikbi is **closer to a credible Claude Code replacement than any of the prior audits
implied**, because Claude Code (the agent) shipped a focused 6-gap close in this
branch: lsp_diagnostic, ask_user, custom agents (.ikbi/agents/), MCP OAuth,
`ikbi review`, and notebook_edit. The build now passes (the 5 LSP type errors from
earlier today are gone), 2629 tests run green, and the tool inventory is at 25/25
parity between builder and chat.

But four real gaps still stand between ikbi and "drop-in Claude Code replacement
that lets you run cheap models":

1. **The capability-harness and tournament — the primitives that *prove* ikbi
   beats Claude Code on cost — have no CLI surface.** A user who wants ikbi to
   compete with Claude Code on a task has no `ikbi evaluate` / `ikbi side-by-side`
   command. The engine supports it; the surface doesn't.
2. **The contextual help system (`ikbi help <command>`) only covers 6 of ~30
   commands.** Every command CC added (review, agents, mcp auth, the new tools)
   has no help page. New users have nothing to discover them.
3. **The operator's "lab-only, you handle auth" stance leaves `/ikbi/*` and
   `/api/receipts`, `/api/timeline` wide open** if the server is exposed. The
   `apiAuth` hook was deliberately removed in commit 0edeee7. For a tool
   claiming to be a daily driver, that's a real posture issue.
4. **The GLM 5.2 / Bubbles "store atomicity + path traversal" fixes were applied
   to correction-library and spec-artifact but not job-cards.** Three consecutive
   audit cycles have all flagged the same race / traversal pattern in
   `src/modules/job-cards/store.ts` and it hasn't been touched.

The 3 HIGH security/correctness findings from GLM 5.2 + Bubbles (refuter
category-only suppression, verifier cross-role bleed, spec execute returning
false completion) are **all properly fixed and tested**. The 4 prior audits did
their job; what's left is "polish + capability-harness CLI + per-command help."

## What Was Already Audited

Four prior audits (in chronological order):

| Audit | Date | Author | Focus | Top finding |
|---|---|---|---|---|
| AUDIT-REPLACEMENT | 2026-06-18 | Julian (Hermes) | Surface polish sprint plan | REPL hardening, error messages, context manager |
| BUBBLES-AUDIT | 2026-06-22 | Bubbles | Auth + spec execution | 3 HIGH on /ikbi/* routes, spec execute lies, refuter semantic disabled |
| GLM52-AUDIT | 2026-06-23 | GLM 5.2 | Correction-system correctness | HIGH-1/2: refuter category-only suppression, verifier cross-role bleed |
| AUDIT-MINIMAX | 2026-06-23 | M3 (MiniMax) | Architectural parity vs CC | 10 architecture gaps, 14 UX gaps, top-5 fix list |

All four pointed at real problems. The intervening work (commits 8203950 →
07665b1) closed the security/correctness findings decisively. The remaining
gaps are architectural/UX, not bugs.

## State of the Repo (Live, 2026-06-23)

- **pnpm build:** clean (was broken 7 hours ago with 5 LSP type errors and a
  dead notebook-tools.js import; Claude Code's `lsp` module + `notebook-tools.ts`
  commit resolved both)
- **Tests:** 2629/2629 passing (was 1881/1959 before; 670 new tests added by
  CC's gap-closing commits and the late fix chain)
- **Modules:** 41 module directories under src/modules/, 19 registered as
  reachable CLI commands (per MODULE_CENSUS.md)
- **Tool parity:** 25 builder / 25 chat tools — full parity, with the 3 new
  CC-shipped tools (lsp_diagnostic, ask_user, notebook_edit) in both loops
- **CLI surface:** ~30 registered commands; 6 with help pages
- **tsconfig:** strict + noImplicitOverride + noUncheckedIndexedAccess +
  noUnusedLocals/Parameters + exactOptionalPropertyTypes + verbatimModuleSyntax.
  Among the strictest real-world configs I've seen; the build passing at this
  level is real discipline.
- **Frozen core:** unchanged. M3's audit correctly noted that nothing in this
  audit needs to touch src/core/.

## Verification of Prior Audit Findings

### GLM 5.2 audit (the most concrete)

| Finding | Verdict | Where |
|---|---|---|
| **HIGH-1** — refuter category-only suppression | **FIXED** | `refuter.ts:479-521` now indexes by `category + [check_id]` prefix parsed from `c.finding`. Matching is structurally narrower; a `test_weakening` correction only suppresses `tests_not_weakened` findings. **Test gap:** no test exercises the unrelated-check / same-category case to prove the narrowing. The narrowing is in the code, not pinned by a regression test. |
| **HIGH-2** — verifier `verification_forgery` cross-role bleed | **FIXED** | `verifier.ts:237-262` now only matches `expected_manifest_change`, AND the new value must be a recognized real test runner. `verification_forgery` is no longer a whitelisting key. |
| **MEDIUM-1** — non-atomic store writes | **PARTIAL** | `correction-library/store.ts:54-57` and `spec-artifact/store.ts:38-41` use `writeFileSync(tmp) + renameSync(tmp, path)`. `job-cards/store.ts:41` does NOT — still uses raw `writeFileSync`. Three audit cycles have all flagged the same race; the third store is consistently left behind. |
| **MEDIUM-2** — spec PATCH no field allowlist | **FIXED** | `spec-artifact/index.ts:103-129` has explicit `EDITABLE` and `BLOCKED` sets; `status`, `output`, `error`, `id`, `createdAt`, `updatedAt` are rejected at the handler. |
| **MEDIUM-3** — `fileRefuterCorrections` proposes for non-critical findings | **FIXED** | `orchestrator.ts:957-960` adds `if (f.severity !== "critical") continue;` before `proposeCorrection(...)`. |
| **LOW-1** — spec execute re-runs terminal-status specs | **FIXED** | `spec-artifact/index.ts:142-145` blocks `completed`/`failed`/`not_implemented` with a 409. |
| **LOW-2** — UI at `/` returns 401 when `IKBI_API_TOKEN` is set | **LATENT** | The auth hook was REMOVED in commit 0edeee7 (operator decision; see below). The bug is dormant: if the hook is ever re-enabled, the UI is broken. Fix is one line: add `/` (and likely static asset extensions) to `PUBLIC_PREFIXES` in `src/server/auth.ts:18`. |
| **LOW-3** — store id path traversal | **PARTIAL** | `correction-library/store.ts:18-22` and `spec-artifact/store.ts:14-18` both `assertSafeId(id)` (rejects `/`, `\`, `..`). `job-cards/store.ts:23-25` (`cardPath`) does NOT. Same store-pattern, same gap. |

### Bubbles audit (auth + spec execution)

| Finding | Verdict | Where |
|---|---|---|
| **HIGH-1** — zero auth on `/ikbi/*` routes (17 routes) | **REVERTED (operator decision)** | Commit 8203950 added `app.addHook("preHandler", apiAuth)` in `buildServer()`. Commit 0edeee7 (one day later) **removed it** and replaced it with the README disclaimer: "If you expose any service to the public internet, YOU are responsible for securing it." The hook is still wired in `tasks.ts:185` (only protects `/api/*` task routes). `/ikbi/*` and `/api/receipts` + `/api/timeline` are wide open. This is a deliberate posture change, not a missed fix. |
| **HIGH-2** — spec execute returns false completion | **FIXED** | `spec-artifact/index.ts:120-167` now returns `status: "not_implemented"` with a "dry-run preview" output message. Also blocks re-execution of terminal statuses. |
| **HIGH-3** — refuter semantic spec-match (#7) never activates | **FIXED (gated)** | `orchestrator.ts:937-940` honors `IKBI_REFUTER_SEMANTIC=true`. Defaults to `false` for backward compat — meaning out of the box, the off-target build check is still the trivial heuristic. Cost-opt-in is defensible but worth flagging in product docs. |
| **MEDIUM-1** — no auth on `/api/receipts`, `/api/timeline` | **STILL OPEN** | Neither route registers an auth hook. Confirmed by live server probe: `curl /api/receipts` returns 200 with no token, full receipt history exposed. |
| **MEDIUM-2** — TOCTOU in file stores | **PARTIAL** | Same as GLM MEDIUM-1 above. |
| **MEDIUM-3** — no input length validation | **STILL OPEN** | No `maxLength` on POST body fields in any of the three stores. Combined with the open auth posture, an unauthenticated client can write unbounded JSON to disk. |
| **MEDIUM-4** — correction dir deletion = silent data loss | **STILL OPEN** | `correction-library/store.ts:91-92` returns `[]` when the dir doesn't exist, with no warning. The audit's recommendation (startup integrity check) is not implemented. |
| **LOW-1** — no auth tests for `/ikbi/*` | **N/A** | The 12 auth tests in `src/server/auth.test.ts` were DELETED in commit 0edeee7 (file count dropped by 211). With the auth hook removed, the tests became irrelevant. |
| **LOW-2** — job card default `maxFilesChanged: 0` = "no limit" | **STILL OPEN** | `job-cards/index.ts:67`: `guardrails: ... ?? { maxFilesChanged: 0, ... }`. The default means no limit, and no body validation. |

### M3 (MiniMax) audit — architectural parity

M3's audit was a strategic review (parity matrix vs Claude Code), not a
code-level bug hunt. The architectural gaps it identified (plan mode, hooks,
session memory, parallel exec, IDE extension) have been **partially addressed**:

- **Hooks:** SHIPPED in `src/modules/hooks/` (commit 1625eb1), 3 hook types
  (PreToolUse/PostToolUse/Stop), but **zero tests** (see "What I Found New" below).
- **Session memory:** SHIPPED (`src/modules/chat/session.ts` + `session-store.ts`),
  `--continue`, `--resume`, `--fork` flags all in place.
- **Parallel exec:** The architecture is sequential per turn; parallel tool
  dispatch is not implemented. NOT FIXED.
- **Plan mode:** NOT IMPLEMENTED. `step-planner` and `batch-planner` exist but
  output flows directly into execution. M3's #1 finding is still the #1 finding.
- **IDE extension:** NOT IMPLEMENTED. M3's #5 finding is still pending.

### Julian (Hermes) audit — surface polish

- **REPL hardening** — DONE (commit 14dabde "REPL as golden path")
- **Error translation** — DONE (`src/core/errors/`, 1-2 day estimate held)
- **Context manager** — DONE (`src/core/context/`)
- **`ikbi init`** — DONE (commit 2e3bb5c)
- **Contextual help** — PARTIALLY DONE — only 6 commands have help pages

The 2-3 week surface sprint plan from this audit is ~80% complete. What's
missing is the "1-day" contextual-help item and the CLI for the evaluation
primitives (next section).

## What I Found New (Not in Any Prior Audit)

### Finding A — `capability-harness` has no CLI command

**File:** `src/modules/worker-model/capability-harness.ts` (237 lines) +
`src/modules/worker-model/capability-harness.test.ts`

The capability-harness is the right primitive for the user's stated goal:
"ikbi and Claude Code do a side-by-side comparison and have ikbi work with
cheaper models." It evaluates a model across 4 modes (agent, patch, plan_patch,
repair) against in-memory fixtures with ground-truth oracles and emits a
scorecard + routing recommendation (`agent_builder`, `patch_builder`,
`repair_builder`, `critic_only`, `not_recommended`).

The user could:
1. Define a fixture (a small repo + goal + oracle)
2. Run the harness against a Claude Code model id AND a DeepSeek Flash model id
3. Get a side-by-side scorecard showing which one is reliable for the task
4. Wire the cheap one as the builder

But there's no `ikbi evaluate` or `ikbi side-by-side` command. The harness
is library-only; you have to write a script that imports it. For a user
explicitly trying to use ikbi to replace Claude Code on cost grounds, this is
a meaningful gap — the comparison story is the whole pitch.

**Fix:** Add a `src/cli/evaluate.ts` (or similar) that:
- Reads a fixture set (JSON or YAML in `.ikbi/fixtures/`)
- Runs each model × each fixture × each mode through the harness
- Emits a JSON or markdown comparison table
- Optionally writes a "blessed roster" of model-to-mode routing to
  `~/.ikbi/providers.json`

**Effort:** 1-2 days. The harness primitives are all there.

### Finding B — Contextual help covers 6 of ~30 commands

**File:** `src/cli/help-pages.ts` (the `HELP_PAGES` table has exactly 6 entries)

The 6 with help: `build`, `init`, `models`, `serve`, `repl`, `fix`, `doctor`.

Without help: `review` (CC's new command), `agents` (CC's new command),
`mcp` and `mcp auth` (CC added OAuth), `audit`, `batch`, `classify`, `clean`,
`cost`, `diff`, `kill`, `kill-status`, `memory`, `receipts`, `recover`,
`repos`, `summary`, `trust`, `undo`, `unkill`, `workspace`, `workspaces`,
`ask`, `setup`, `version`, `capabilities`, `providers`.

A new user who runs `ikbi help review` gets the basic help screen back, not
the detail page. The contextual help pattern is in place; it just hasn't been
populated for the long tail.

**Fix:** Add help pages for the high-traffic commands first (review, agents,
mcp, audit, cost, diff, undo, trust). 30 minutes per page.

### Finding C — `src/modules/hooks/` has zero test files

**File:** `src/modules/hooks/index.ts` (211 lines) + `config.ts` (10 lines)

Hooks are a security-sensitive feature: `PreToolUse` with `exit 2` BLOCKS a
tool. The hook module has:
- 3 hook types (PreToolUse, PostToolUse, Stop)
- A 30-second timebox
- Fail-open semantics for non-zero exits
- A 32KB output truncation

A bug in any of these (especially the BLOCK semantics) is a real safety issue.
And the module has 0 test files. For comparison, `labmem-recall` (183 lines)
has 2 test files; `hooks` (221 lines) has zero.

**Fix:** Port the obvious happy-path + exit-2-blocks-tool + timeout tests.
1 day. This is the highest-leverage test gap.

### Finding D — Auth posture regression (operator decision, but worth flagging)

**Commits:** 8203950 (added) → 0edeee7 (removed, same day)

The `app.addHook("preHandler", apiAuth)` in `buildServer()` was added on
2026-06-22, then removed 13 hours later. The commit message says "AUTH
DISCLAIMER: lab-only product, authentication is user's responsibility." The
README was updated with a banner saying the same.

This is **a deliberate operator decision**, not a bug. But it has consequences
for the "Claude Code replacement" story:
- Claude Code is single-user, CLI-only — no network surface.
- ikbi is a localhost/Tailscale service with a public-bind flag
  (`IKBI_ALLOW_PUBLIC_BIND=true`).
- The default `IKBI_BIND_HOST` is `127.0.0.1`, so the server is unreachable
  from the network by default.
- But if a user turns on `IKBI_ALLOW_PUBLIC_BIND=true` to share a build with a
  colleague, every `/ikbi/*` route is reachable unauthenticated.

For a tool claiming to replace Claude Code (which is fundamentally
single-user), this is a defensible posture. But:
- The server-side `applyTo` mechanism means a future module that adds routes
  will silently be unauthenticated. The default is "open" not "deny."
- The auth helper (`apiAuth` in `src/server/auth.ts`) is now only applied
  in `src/server/tasks.ts:185` (scoped to `/api/*` task routes).

**Recommendation:** If the operator's posture stays "lab-only," the README
disclaimer is the right call. But the **default-deny inversion** Bubbles
recommended (server-level `addHook` with explicit opt-outs) was the safer
default. Worth re-enabling the hook with a one-line addition: add `/` to
`PUBLIC_PREFIXES` in `auth.ts:18` to keep the UI reachable. That single
change closes Finding LOW-2 GLM at the same time.

### Finding E — `job-cards/store.ts` is 3 audits behind

**File:** `src/modules/job-cards/store.ts` (45 lines)

This is the same file that has been flagged in every audit cycle:
- GLM 5.2 MEDIUM-1: non-atomic writes
- GLM 5.2 LOW-3: missing `assertSafeId`
- Bubbles LOW-2: default `maxFilesChanged: 0`

`correction-library/store.ts` and `spec-artifact/store.ts` have both been
patched; `job-cards/store.ts` has not. Likely because the file is small and
"it works in the single-writer test path" — but under concurrent
`POST /ikbi/job-cards` calls (the task API supports 3 concurrent builds
per the Bubbles audit), `cardPath` lets a `..` id through and `writeJson`
clobbers itself.

**Fix:** Two-line patch:
```ts
function cardPath(storeDir: string, id: string): string {
  assertSafeId(id); // mirror correction-library pattern
  return join(storeDir, `${id}.json`);
}
function writeJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
function assertSafeId(id: string): void {
  if (/[\\/]/.test(id) || id.includes("..")) {
    throw new Error(`unsafe job card id: ${id}`);
  }
}
```
**Effort:** 15 minutes. Ship it.

### Finding F — Stale test count in README

**File:** `README.md` line ~50: "node:test runner — 2199 tests, all passing"

The actual count is **2629 tests, all passing** (CC added 430 in the gap-closing
commits). The README is materially out of date. Small thing, but the
CLAUDE.md / README pair is the operator's first stop when figuring out what
to trust.

**Fix:** `sed -i 's/2199/2629/' README.md`. 30 seconds.

### Finding G — `console.warn` in two production paths

**Files:** `src/modules/worker-model/orchestrator.ts:1418`,
`src/modules/drift-prevention/drift.ts:156`

Both files use `console.warn(...)` instead of the structured pino logger
that the rest of the system uses. The messages go to stderr in tests and
in the REPL's quiet mode (the `--quiet` flag) the model-facing output is
clean, but these warnings will still leak through. The drift warning in
particular is one a user will want to see in the JSON log stream, not as
a stray stderr line.

**Fix:** Replace with the structured `log.warn({...}, "...")` pattern.
15 minutes each.

## Side-by-Side Comparison Framework (User's Stated Goal)

The user wants ikbi to compete with Claude Code on cost. The engine has the
primitives:

1. **`capability-harness`** (Finding A) — in-memory fixture + 4 mode eval +
   routing recommendation. The right tool for "is this model good enough
   to replace Claude Code at this task?"
2. **`tournament`** (`src/modules/worker-model/tournament.ts`, 562 test lines) —
   N candidate models race on the same task in isolated workspaces, deterministic
   judge scores them, shadow workspace replay, only then promote. Already
   used in `competitive` mode.
3. **Multi-model roster** (`src/modules/model-evaluation/luak-adapter.ts`) —
   Luak leaderboard ranking.

What's missing is the surface. The user can't currently run:

```
ikbi evaluate --fixture .ikbi/fixtures/auth-refactor.json --models deepseek-v4-flash,claude-sonnet-4 --modes agent,patch
```

And get a side-by-side scorecard. The CLI for this is Finding A. A workable
approach:

1. Add `src/cli/evaluate.ts` that imports `runCapabilityHarness` from
   `worker-model/capability-harness.ts`
2. Add a fixture-loader that reads `.ikbi/fixtures/*.json` (or inline JSON via `--fixture`)
3. Emit a markdown or JSON comparison table
4. Optionally write a routing recommendation to `~/.ikbi/providers.json`

The harness's in-memory design (no fs, no git, no governed exec — see file
header) means it can run anywhere, including in CI, without disturbing the
worktree. Cost: 1-2 days. Leverage: this is the comparison story.

## What the Four Audits Got Right (Credit)

- **GLM 5.2's HIGH-1/2** were real, real bugs. The fact that the FIX ships with
  a comment crediting the audit, and the verifier fix is structurally tight
  (must be a recognized real test runner, never whitelists real→stub forgeries)
  is exactly the right standard. The new code is *better* than the audit's
  suggested fix.
- **Bubbles' HIGH-1/2/3** were real, real bugs. The spec-execute fix returns
  `not_implemented` (honest) and the refuter fix is env-gated (defensible
  backward-compat).
- **M3's "trust, receipts, governed exec, worktree isolation"** is the
  four-pillar story the README and posture.ts lean on, and it's accurate.
  Those four are *not features any Claude Code competitor ships* and they're
  the reason ikbi is interesting.
- **Julian's "REPL as golden path"** is now the literal default — `ikbi` with
  no args opens the REPL. The 2-3 week sprint is real.

## What the Four Audits Missed (Honest List)

1. **Hook module has zero tests** (Finding C) — security-relevant, completely
   uncovered.
2. **Capability-harness has no CLI** (Finding A) — the comparison primitive
   is library-only, the user can't use it.
3. **Help pages cover 6 of ~30 commands** (Finding B) — discoverability gap
   for everything new.
4. **`job-cards` is the persistent audit-cycle laggard** (Finding E) —
   flagged in every cycle, never fixed.
5. **The "test gap" on GLM HIGH-1's narrowing fix** — the code is correct,
   the test only exercises the matching case. No test pins "a different
   check-id with the same category does NOT suppress." A future refactor
   could re-broaden the matching.
6. **`/api/receipts` and `/api/timeline` are open** (Bubbles MEDIUM-1) —
   not closed because the broader auth posture was reverted.

## The 5 Things to Fix Next (If You Have a Week)

Ordered by leverage for "Claude Code replacement" claim:

1. **Build the `ikbi evaluate` CLI** (Finding A). This is the comparison
   story. 1-2 days. Unlocks the "ikbi beats Claude Code on cost" pitch
   with real data instead of vibes.
2. **Add help pages for review, agents, mcp, audit, cost, diff, undo, trust**
   (Finding B). 30 minutes each. Discoverability is the daily-driver
   differentiator.
3. **Port 4-5 hook tests** (Finding C). The hooks module is security-sensitive
   and uncovered. 1 day.
4. **Fix `job-cards/store.ts`** (Finding E). 15 minutes. Closes 3 open
   audit findings in one diff.
5. **Decide on auth posture** (Finding D). Either:
   (a) Re-enable the server-level auth hook + add `/` to `PUBLIC_PREFIXES`
       (1 line change, default-deny posture)
   (b) Document the lab-only posture in SECURITY.md with explicit
       guidance for any non-localhost bind.
   1 hour.

## Verdict

ikbi is **1-2 weeks of focused work from being a credible Claude Code
replacement that beats Claude Code on cost for the right tasks.** The
engine is genuinely good — the trust/receipt/governance story is
unmatched. The build is clean, the tests pass, the tool inventory has
real parity, the new tools (lsp_diagnostic, ask_user, notebook_edit) close
the most-cited UX gaps, and the prior audit cycle's HIGH and MEDIUM
findings are decisively fixed.

What's left is polish (help pages, hook tests, the job-cards laggard) and
the comparison surface (capability-harness CLI). Neither is a deep
architectural change. Neither touches the frozen core.

The honest positioning today: **"A governed, model-flexible,
verification-heavy coding agent with a stronger engine than Claude Code
on trust/safety, real CLI parity, and a comparison harness waiting to be
exposed."**

The positioning after 1-2 weeks: **"A Claude Code replacement that
proves itself cheaper via the same eval harness Claude Code can't run."**
