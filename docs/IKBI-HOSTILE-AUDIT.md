# ikbi Hostile Readiness Audit — Architecture, Correctness, and Scale

**Auditor:** Bubbles (DeepSeek v4 Pro, hostile pass)
**Date:** 2026-06-09
**Commit range:** `515486e` → `fdef5c6` (12 new commits, 4 new modules)
**Test status:** 940/940 PASS (irrelevant to this audit — tests passing proves very little)
**Mission:** Find what will break at scale. Find false-green pathways. Find trust divergence. Find silent failure modes.

---

## Executive Verdict: NOT READY FOR CLAUDE CODE REPLACEMENT

ikbi has genuine architectural strengths — but it also has **multiple correctness-threatening failure modes** that would silently produce wrong results at scale. The new retrieval/index/ladder/triage modules are well-constructed individually, but their interaction creates false-green pathways that would allow an operator to confidently promote unverified work. Seven findings below are **BLOCKERS** that should prevent Claude Code replacement until addressed.

---

## 1. TOP 10 ARCHITECTURAL RISKS

### A1 [BLOCKER] — The scout cannot see enough of a large codebase

**What:** `MAX_FILES_SCANNED = 40`, retrieval budget = 60 files max, `MAX_TOTAL_BYTES = 60_000`. For a monorepo with 10,000+ source files, the scout reads 0.4% of the codebase. The builder then operates on a microscopically narrow view. The model literally cannot know what else exists.

**Reproduction:** Create a monorepo with 500 packages, each with 100 files. Run a build targeting a change that spans 3 packages. The scout selects at most 40-60 files. At least 2 of the 3 packages will be unrepresented. The builder operates blind.

**Scale failure:** The caps are hard-coded at pre-scale values. A real CI lab running on real repositories will routinely overflow these caps. The system provides no mechanism to increase them proportionally to repo size.

**Operator overconfidence pathway:** The scout summary says "scouted 40 files — produced 5 findings." The operator sees 5 findings and assumes the scout was thorough. In reality, 40 files out of 50,000 is statistically meaningless. The findings are random.

**Suggested fix:** Make `MAX_FILES_SCANNED` and `MAX_TOTAL_BYTES` configurable via env vars. Add a loud warning when the scout visits < 5% of repo files. Scale the caps based on repo size (e.g., min(40, 5% of files)).

### A2 [BLOCKER] — Vacuous full-verification pass via echo-checks

**What:** When the verification-ladder escalates to full, it runs the ROOT package's test script. If the root package.json has `"test": "echo done"` (common in monorepos where subpackages hold real tests), the verifier reports GREEN with exit 0. The check-triage parser sees `"passed (exit 0)"` with `"unknown format"` — no structured failures, no framework detected. The integrator sees GREEN. The promote proceeds.

**Reproduction:**
1. Create a monorepo where the root package.json has `"scripts": { "test": "echo all good" }` and real tests live in `packages/*/`.
2. Make a change to a shared utility that breaks every subpackage.
3. The verifier escalates to full (because a shared tsconfig changed), runs `pnpm test` at root, gets `"all good"`, exit 0.
4. The triage parser: `"root-package test: passed (exit 0)"` with `detectedFrameworks: []`, `failures: []`.
5. The verifier returns `verdict: "pass"`.
6. The integrator promotes.

**The soundness invariant is violated:** The contract says "green means the target passed" but the target test was `echo all good`. The system has no mechanism to distinguish real test suites from stub/no-op checks.

**False-green:** This is the single most dangerous finding. The check-triage `detectedFrameworks` field reveals the problem (empty = unknown format) but nothing consumes it — the integrator and judge never check this field.

**Suggested fix:** When `detectedFrameworks` is empty AND the test command produced no structured failures, mark the check as `"unverifiable"` rather than `"pass"`. The integrator must treat `"unverifiable"` the same as `"fail"` for promotion decisions. Alternatively, require the operator to whitelist which package roots have "real" checks via config.

### A3 [BLOCKER] — Alphabetical seed priority in retrieval cap

**What:** When goal-mined seeds exceed `maxSeeds` (32), the cap drops seeds alphabetically: `[...seedFiles].sort().slice(0, cfg.maxSeeds)`. Seed files named `aaa.ts` survive; `zzz.ts` gets dropped. Relevance plays zero role in which seeds are kept. A file named `z-auth-middleware.ts` (critical!) gets dropped before `a-constants.ts` (trivial).

**Reproduction:**
1. Create a repo with files `a-types.ts`, `z-critical-auth.ts`, and 50 other files.
2. Set a goal like "fix the auth middleware" which should seed `z-critical-auth.ts` via name-match.
3. If enough other seeds are generated, the alpha cap drops `z-critical-auth.ts` while keeping `a-types.ts`.

**Suggested fix:** Score seeds by match specificity before capping. Exact path matches rank highest, basename matches next, term matches last. Cap by score, not alphabetically.

### A4 [HIGH] — TypeScript path aliases are invisible to import resolution

**What:** The project-index uses regex to extract imports, then resolves relative/package specifiers against the known file set. TypeScript path aliases (`@/utils/X` → `src/utils/X` via tsconfig.json `paths`) are treated as `"unresolved"` or `"external"`. The entire dependency graph between aliased imports is missing from the index.

**Impact:** The retrieval graph, impact analysis, and verification ladder all operate on an incomplete dependency graph. A change to a file imported via path alias shows as having ZERO importers — the reverse-import BFS finds nothing, and the ladder scopes verification too narrowly.

**Reproduction:**
1. Create a TypeScript project with `tsconfig.json` containing `"paths": { "@lib/*": ["src/lib/*"] }`.
2. File `src/lib/auth.ts` is imported as `@lib/auth` by 50 files across 10 packages.
3. Project-index sees 50 `"external"` edges from those imports.
4. Change `src/lib/auth.ts`. The ladder finds 0 importers, 0 affected tests.
5. Verification is scoped to impact-only. Result: PASS. But 50 files are broken.

**Suggested fix:** Parse `tsconfig.json` `paths` and `baseUrl` during indexing. Resolve aliased imports against the known file set before classifying as external.

### A5 [HIGH] — Test detection misses real test directories

**What:** `isTestPath()` matches `__tests__/` segments and `.test.` / `.spec.` extensions. Real projects use: `tests/`, `spec/`, `e2e/`, `integration/`, `__specs__/`, `__mocks__/` (collocated tests), `*.test-d.ts` (type tests), and test runner configs (vitest.config.ts etc.). The index marks these as non-test files, `fileToTests` never maps them, the ladder excludes them.

**Reproduction:**
1. Create a project with tests in `tests/` directory (not `__tests__/`).
2. The index marks all `tests/*.ts` files with `isTest: false`.
3. `fileToTests` produces no mappings.
4. The ladder's `affectedTests` set is empty.
5. The verifier runs 0 tests for the changed source files.
6. Verification reports GREEN.

**Suggested fix:** Make test directory patterns configurable. Scan for test runner configs (vitest.config.ts, jest.config.js, .mocharc.yml) to auto-discover test locations. Default to broader patterns.

### A6 [HIGH] — Root package.json script integrity guard covers only root

**What:** `detectScriptMutation` guards `package.json` scripts but only at the PACKAGE ROOT level (where the workspace diff's `package.json` lives). In a monorepo with subpackages (`packages/auth/package.json`), a builder that modifies `packages/auth/package.json`'s `"test"` script to `"echo pass"` would NOT be caught. The guard only fires on root-level package.json files.

**Reproduction:**
1. Monorepo with `packages/auth/package.json` containing `"test": "jest"`.
2. Builder changes it to `"test": "echo pass"`.
3. `detectScriptMutation` sees a diff in `packages/auth/package.json` but the guard only checks root-level files (via `packagesByRoot.has(dir)` where `dir` is the dirname).
4. The guard doesn't flag it. The verifier runs `echo pass` for the auth package.
5. All auth tests are skipped. Verifier reports GREEN.

**Suggested fix:** Extend `detectScriptMutation` to check ALL package.json files in the diff, not just root-level ones. Any `package.json` at a known package root needs the same script-integrity guard.

### A7 [MEDIUM] — `maxImpactHops = 3` silently truncates transitive dependents

**What:** The reverse-import BFS is bounded by `maxImpactHops = 3`. A change to a deep utility (e.g., a shared ID generator) could affect packages 4+ hops away. The ladder would verify only packages within 3 hops and report GREEN for the scoped verification — leaving distant dependents unverified.

**Reproduction:**
1. Chain: `base-utils.ts` → (hop 1) `validators.ts` → (hop 2) `form-handlers.ts` → (hop 3) `api-routes.ts` → (hop 4) `middleware.ts` → (hop 5) `server.ts`.
2. Change `base-utils.ts` to introduce a subtle bug.
3. The ladder finds dependents up to `api-routes.ts` (hop 3) and runs those tests.
4. `middleware.ts` and `server.ts` (hops 4-5) are unverified.
5. The server's integration tests (which would catch the bug) never run.
6. Verifier reports GREEN (impact-scoped).

**Suggested fix:** Default to unlimited hop depth (0 = unlimited). Cap impact by total file count only, not hop depth. Warn when the hop cap was exceeded.

### A8 [MEDIUM] — Racy-clean index refresh edge case with zero window

**What:** If the operator sets `IKBI_PROJECT_INDEX_RACY_WINDOW_MS=0` (disabling the racy window), a file modified in-place with the SAME SIZE within the SAME mtime second as the index walk would be incorrectly marked "confidently unchanged." The stored hash would be stale.

**Reproduction:**
1. Set `IKBI_PROJECT_INDEX_RACY_WINDOW_MS=0`.
2. File `src/foo.ts` is read by walk at T=0.1s, content "A", size 1000, mtimeMs=0.
3. At T=0.2s, an external process modifies `src/foo.ts` to "B", size 1000, mtimeMs still 0 (1-second resolution filesystem).
4. Index is written with hash of "A".
5. Next refresh: probeUnchanged=true (size 1000 matches, mtimeMs 0 matches). racy=false (mtimeMs 0 >= builtAtMs? with window 0, racyFloor = builtAtMs. If builtAtMs was T=0.5s, 0 < 500 — NOT racy). File is marked confidently unchanged.
6. The index has stale hash for `src/foo.ts`.

**Suggested fix:** Minimum racy window of 1000ms, enforced at config load. Never allow zero.

### A9 [LOW] — DEFAULT_MAX_CROSS_PACKAGE = 0 means any cross-package import escalates

**What:** With `maxCrossPackage = 0`, a single cross-package importer triggers full verification. For a monorepo, this means EVERY non-trivial change escalates to full — defeating the purpose of impact-scoped verification.

**Impact:** Not a correctness risk, but the feature effectively doesn't work for monorepos at default settings.

**Suggested fix:** Default to a reasonable value (e.g., 5 cross-package importers). Document the tradeoff.

### A10 [LOW] — Symlinks silently skipped by walk

**What:** The index walk skips symlinks (`e.isSymbolicLink()`) for safety. But monorepo setups using symlinks for shared configs (`packages/*/tsconfig.json` → `../../tsconfig.base.json`) become invisible to the index. Shared configs that trigger full verification won't be detected.

**Suggested fix:** Log skipped symlinks as warnings. Allow configurable symlink resolution with a depth limit.

---

## 2. TOP 5 FALSE-GREEN RISKS

### F1 [BLOCKER] — Vacuous test pass (echo/true/no-op checks)

**See A2 above.** The single most dangerous finding. A root package with `"test": "echo pass"` produces a GREEN verification for the entire repo. The system has no defense against this.

### F2 [BLOCKER] — Impact-scoped verification with incomplete graph

**See A4 above.** TypeScript path aliases create holes in the import graph. A change to a widely-imported file via path aliases shows 0 dependents, scoping verification to the file alone. The verifier reports GREEN because "no other packages are affected" — according to an incomplete graph.

### F3 [HIGH] — Retrieval dropping high-relevance seeds on alpha cap

**See A3 above.** The alphabetical seed cap can drop the most relevant files from the retrieval set. The scout then operates without critical context, finds fewer issues, and the builder produces a change that LOOKS correct but breaks things the scout never saw.

### F4 [HIGH] — Unrecognized test framework = no structured failures

**What:** The check-triage parser only recognizes tsc, node:test (TAP), pytest, go-test, and vitest/jest. Any other framework (Mocha, Ava, Cypress, Playwright test, custom) gets `detectedFrameworks: []` and `failures: []` even when the test runner reports failures. The verifier sees exit code ≠ 0 (so verdict is `"fail"`), but the integrator only sees `failures: []` (because triage couldn't parse them). If any downstream code checks only the `failures` array, it would miss the actual errors.

**Current state:** The verifier correctly uses exit code for the verdict, so this doesn't currently cause a false-green. But it's fragile — any refactoring that relies on `failures.length` for the verdict would silently break.

### F5 [LOW] — Neutral packages silently excluded from coverage

**What:** Packages with no runnable check are marked "neutral" in the ladder output. The verifier excludes them from the check stages. The operator never sees that these packages were skipped. Over time, as packages are added to a monorepo without test scripts, the effective verification coverage silently decreases.

---

## 3. TOP 5 SCALE RISKS

### S1 [BLOCKER] — Hard caps designed for small repos

**What:** `MAX_FILES_SCANNED=40`, retrieval budget=60K, index `maxParseBytes=1MB`. These caps were chosen for repos with hundreds of files. A monorepo with 50,000+ files makes these caps laughably small. The system provides no proportional scaling.

### S2 [MEDIUM] — Full index rebuild on every HEAD change

**What:** The refresh logic triggers a FULL rebuild on HEAD change. In a CI environment with frequent commits, every verification does an O(N) walk of the entire repo. With `maxFiles=200000` this is fast enough, but the walk reads every file to compute hashes — O(N) disk I/O with N up to 200K.

### S3 [MEDIUM] — Memory pressure from in-memory file content map

**What:** `assemble()` reads EVERY JS/TS file into memory (`contentByRel`) to extract imports. For 200K files at average 5KB each (before `maxParseBytes=1MB` cap), that's 1GB of strings. The `maxParseBytes` cap limits PER-FILE parsing but the raw content is read before capping.

### S4 [MEDIUM] — No concurrent indexing coordination

**What:** Two simultaneous builds would both call `index.refresh(worktree)` for the same repo, both walking the full tree, both writing the index file. The second write overwrites the first. No coordination, no locking.

### S5 [LOW] — `maxImpactFiles=2000` cap on BFS

**What:** When a change affects more than 2000 dependent files (possible in a generated-code monorepo), the BFS truncates. Files beyond the cap are not analyzed for impact, and their tests are excluded from the verification plan.

---

## 4. TOP 5 TRUST/SAFETY RISKS

### T1 [HIGH] — Script-integrity guard is incomplete

**What:** `GUARDED_SCRIPT_KEYS` covers `test`, `pretest`, `posttest`, `build`, `prebuild`, `postbuild`, `tsc`, `pretsc`, `posttsc`. Missing: `lint`, `check`, `validate`, `ci`, `format`, `e2e`, `integration`, `coverage`. If an operator trusts any of these scripts as verification signals, the builder can modify them undetected.

### T2 [HIGH] — Root-only script guard misses subpackage scripts

**See A6 above.** The guard checks only root-level package.json files.

### T3 [MEDIUM] — Trust suppressed performance failures with no audit check

**What:** When `suppressTrustSignal` fires, it writes an audit receipt but NEVER calls `trust.recordOutcome`. A flailing agent that's stuck in timeout cycles produces suppressed receipt after suppressed receipt while its trust tier stays unchanged. Over many cycles, the operator sees no trust demotions and assumes the agent is performing well — when it's actually failing repeatedly.

### T4 [LOW] — `max_iterations` suppression gated on `rejectedToolCalls`

**What:** The bad-output evidence check uses `detail.rejectedToolCalls` to gate suppression. But `rejectedToolCalls` only captures parse/malformed JSON failures, not semantic failures (wrong file edited, correct syntax wrong logic). An agent that makes 40 tool calls that are all syntactically valid but semantically wrong would hit `max_iterations` with zero `rejectedToolCalls` and get the trust demotion suppressed.

### T5 [LOW] — No revocation path for vacuously-passing checks

**What:** Once a package's test script produces a passing result, there's no mechanism to flag it as "this check is vacuous." The operator must manually inspect triage output to notice that `detectedFrameworks` is empty. No automatic flagging, no dashboard alert.

---

## 5. BLOCKING FINDINGS (SHOULD PREVENT CLAUDE CODE REPLACEMENT)

| # | Finding | Category | Impact |
|---|---------|----------|--------|
| F1 | Vacuous full-verification pass (echo-checks) | False-green | Could promote completely untested changes |
| F2 | Impact-scoped verification with incomplete graph (path aliases) | False-green | Misses real dependencies, under-verifies |
| A1 | Scout cannot see enough of a large codebase | Scale | Builder operates blind on real repos |
| A2 | Same as F1 | False-green | — |
| A3 | Alphabetical seed cap drops relevant files | Correctness | Retrieval produces wrong results |
| A4 | Same as F2 | False-green | — |
| A6 | Subpackage script integrity unguarded | Trust | Builder can rewrite subpackage test scripts |
| S1 | Hard caps designed for small repos | Scale | System breaks on production-scale repos |

---

## 6. SUGGESTED FIXES (PRIORITIZED)

1. **Add check-vacuity detection** — When `detectedFrameworks` is empty after a test run with exit 0, mark the check as `"unverifiable"` not `"pass"`. Wire this through the integrator to block promotion.

2. **Parse tsconfig.json `paths` during indexing** — Use `baseUrl` and `paths` to resolve aliased imports. This closes the largest gap in the dependency graph.

3. **Make scout caps proportional to repo size** — Scale `MAX_FILES_SCANNED` and budget based on repo file count. Minimum 40, maximum 5% of files, configurable.

4. **Score seeds before capping** — Replace alphabetical sort with relevance-weighted scoring in the seed cap.

5. **Extend script-integrity to all package roots** — Guard every `package.json` in the diff, not just the root-level one.

6. **Expand test detection patterns** — Make `isTestPath` configurable and auto-detect test runner configs.

7. **Add operator-facing coverage metric** — Show what % of repo packages had their tests run vs were neutral/unverifiable.

---

## Bottom Line

ikbi has the right architecture — frozen core, module contracts, governed exec, worktree isolation. But **the new index/retrieval/ladder/triage modules contain at least two BLOCKING false-green pathways** that would allow unverified code to be promoted with operator confidence. The caps are calibrated for toy repos, not production monorepos. The test detection and import resolution miss common real-world patterns.

The system is 80% of the way to correctness. The remaining 20% is the hardest part — edge cases, scale effects, and silent failure modes that tests don't catch because tests test the happy path. ikbi needs **at-scale testing against real monorepos with real test suites** before it can safely replace Claude Code.

---

*Report generated by Bubbles (DeepSeek v4 Pro, hostile audit, 2026-06-09)*
*This report should be treated as a pre-production correctness review, not a feature request list.*
