# Level 2 Proving Notes — Repository Understanding

Date: 2026-06-11
Tester: Julian (Hermes)
ikbi version: 0.1.0, 1284 tests, critic=deepseek-v4-pro, builder=deepseek-v4-flash

---

## Test 1: Find Dead Code — Howa
**Goal:** "Analyze this repository and find any dead code... Create a DEAD-CODE-REPORT.md"
**Repo:** howa (353 tests)
**Result:** BUILDER SUCCESS, VERIFIER SUCCESS (first run), PARTIAL (second run — 1 writeScope violation)

### What happened:
- Scout: ✅ Read 24 files, understood codebase
- Builder: ✅ Created DEAD-CODE-REPORT.md (3,603 bytes, 3 findings)
- Critic: ✅ DeepSeek V4 Pro passed
- writeScope `new_only` enforced — builder tried 1 existing file modification, got blocked

### Builder accuracy:
- Finding 1 (behaviorSignals unused export): ✅ CORRECT
- Finding 2 (copyText unused export): ❌ FALSE POSITIVE — used in TrialResults.tsx
- Finding 3 (downloadText unused export): ❌ FALSE POSITIVE — used in TrialResults.tsx
- **Root cause:** DeepSeek V4 Flash missed .tsx file imports (only searched .ts)

### Cost: $0.23-0.62 per run

---

## Test 2: Detect Drift — Kokuli
**Goal:** "Analyze this repository for drift... Create a DRIFT-REPORT.md"
**Repo:** kokuli (232 tests)
**Result:** BUILDER SUCCESS, VERIFIER FAILURE (depinstall/typecheck)

### What happened:
- Scout: ✅
- Builder: ✅ Created DRIFT-REPORT.md — found real Verum→Kokuli rename drift
- Critic: ✅ DeepSeek V4 Pro passed
- Verifier: ❌ typecheck failed in workspace (npm/pnpm mismatch — FIXED)

### Cost: $0.19

---

## Test 3: Create Fix Plans — Nusika
**Goal:** "Analyze this repository and create a prioritized fix plan... Create a FIX-PLAN.md"
**Repo:** nusika (293 tests, npm-based)
**Result:** ALL 5 ROLES SUCCESS ✅ (final run after depinstall fix)

### What happened:
- Scout: ✅
- Builder: ✅ Created FIX-PLAN.md — found Nusika API service is dead
- Critic: ✅ DeepSeek V4 Pro passed
- Verifier: ✅ npm typecheck + tests passed (after depinstall fix)
- Integrator: ✅
- Outcome: "partial" only because Nusika has uncommitted changes on branch

### Cost: $0.066

---

## Infrastructure Fixes Made During L2

### 1. Expanded govexec allowlist
- Added: `wc`, `tail`, `head`, `find`, `grep` (analysis tools)
- Added: `npm`, `npx`, `pnpm` (package manager + typecheck)
- Still excluded: `cat` (dumps secrets), `node` (eval risk)

### 2. Role timeout: 120s → 300s
- 2 minutes too tight for 353-test repo analysis

### 3. Critic model: minimax-m3 → deepseek-v4-pro
- MiniMax API key invalid (401)
- DeepSeek V4 Pro works reliably

### 4. Package manager auto-detection
- `resolveChecks()` now detects npm vs pnpm from lockfiles
- `NPM_CHECKS` uses `npx tsc --noEmit` + `npm test`
- `VERIFIER_CHECKS` uses `pnpm tsc --noEmit` + `pnpm test`

### 5. Removed `npm run`/`pnpm run` restriction
- Was blocking verification ladder from running npm scripts
- Redundant — npm/pnpm already on allowlist, eval flags still blocked

---

## Level 2 Verdict: PROVEN ✅

### What works:
- Scout consistently reads and understands repos (24 files, 28 findings)
- Builder creates real, actionable deliverables (reports, fix plans, drift analysis)
- Critic works with DeepSeek V4 Pro
- writeScope enforcement prevents existing file modifications on doc/audit tasks
- Full 5-role pipeline completes for both pnpm and npm repos
- Package manager auto-detection works
- Cost efficient ($0.07-0.62 per run)

### Known issues:
- Builder misses .tsx imports (DeepSeek V4 Flash quality issue)
- Builder hit max_iterations on one run (40 rounds + 2 rejected calls)
- serve process exits after builds (needs investigation)

### Level 2 tasks completed:
1. ✅ Audit a repo (Toba — writeScope enforced)
2. ✅ Generate architecture docs (Toba — writeScope enforced)
3. ✅ Find dead code (Howa — 1/3 accurate, writeScope enforced)
4. ✅ Detect drift (Kokuli — real Verum→Kokuli drift found)
5. ✅ Create fix plans (Nusika — found dead API service, full pipeline green)
