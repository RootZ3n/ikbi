# Pehverse Lab — End-to-End Testing Protocol

A **runnable, reusable** protocol for proving the lab works. No internal knowledge required — copy/paste the commands. Written for the lab host **192.168.88.11 (Fedora 44)**; all repos under `/pehverse/repos/`.

> Conventions: ✅ = expected pass, ⚠️ = known baseline (allowed to fail at the stated count), ❌ = must investigate. "Green" means counts match this doc.

---

## 0. Prerequisites

```bash
node --version      # expect v22+
pnpm --version      # pnpm for most repos
cd /pehverse/repos
```

A few repos use `npm` instead of `pnpm`: **kokuli, nusika, honola**. All others use `pnpm`.

---

## 1. Smoke Tests — service health (fast, ~10s)

Run this block. Every line should print `200` (or the noted status). This is the daily "is the lab alive?" check.

```bash
# Format: NAME PORT  -> expected
for e in "ikbi:18796" "Ptah:18810" "Pehlichi:18831" "Luna:18792" \
         "Luak:18795" "Howa:18799" "Ittunaha:18783"; do
  n=${e%%:*}; p=${e##*:}
  printf "%-10s %s -> HTTP %s\n" "$n" "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:$p/health)"
done
systemctl is-active nusika.service
```

**Expected:**
| Service | Port | Expected | Health shape |
|---------|------|----------|--------------|
| ikbi | **18796** | ✅ 200 | `{"service":"ikbi","version":"..."}` |
| Ptah | 18810 | ✅ 200 | `{"agent":"P-tah",...}` |
| Pehlichi | 18831 | ✅ 200 | `{"agent":"Pehlichi","toolCount":34}` |
| Luna | 18792 | ✅ 200 | `{"agent":"Luna",...}` |
| Luak | 18795 | ✅ 200 | `{"service":"luak",...}` |
| Howa | 18799 | ✅ 200 | HTML UI |
| Ittunaha | 18783 | ⚠️ 000 today | JSON dashboard API (currently down) |
| Nusika | systemd | ⚠️ `inactive` today | — |

> **Gotchas baked in from validation:** ikbi is on **18796**, not 18830 (18830 is a Pehlichi-style agent). Toba does **not** own 18831 — that's Pehlichi. Confirm listeners with `ss -ltnp | grep 187`.

**Pass criteria:** ikbi, Ptah, Pehlichi, Luna, Luak, Howa all return 200.

---

## 2. Unit Test Verification — per-project suites

Run from each repo. The pass/fail counts below are the **acceptance baseline** (2026-06-10).

```bash
cd /pehverse/repos/ikbi       && pnpm build && pnpm test    # ✅ 1181 pass / 0 fail
cd /pehverse/repos/luak       && pnpm build && pnpm test    # ⚠️ 1751 pass / 16 fail (baseline)
cd /pehverse/repos/howa       && pnpm build && pnpm test    # ✅ 353 pass / 0 fail
cd /pehverse/repos/toba       && pnpm build && pnpm test    # ✅ 150 pass / 0 fail
cd /pehverse/repos/ittunaha   && pnpm build && pnpm test    # ⚠️ 1351 pass / 1 fail (baseline)
cd /pehverse/repos/kokuli     && npm  run build && npm test # ✅ 232 pass / 0 fail
cd /pehverse/repos/mad-ptah   && pnpm build && pnpm test    # ✅ 131 pass / 0 fail
cd /pehverse/repos/pehlichi   && pnpm build && pnpm test    # ✅ 131 pass / 0 fail
cd /pehverse/repos/loony-luna && pnpm build && pnpm test    # ✅ 132 pass / 0 fail
cd /pehverse/repos/nusika     && npm  run build && npm test # ✅ 293 pass / 0 fail
cd /pehverse/repos/honola     && npm  run build && npm test # ✅ 20 pass / 0 fail
```

**Total acceptance: 4823 pass / 17 fail (4840 tests).** The 17 failures are the *known baselines* and must match exactly:
- **luak 16:** adapter-registry + vision-fixture preflight (V2/V7/V8/V9/V14, P9/P10, `verifyFixtureOnDisk`, Phase 3/4 guards, `regex_match`, `release-gauntlet --dry-run-inventory`).
- **ittunaha 1:** `GET /lab/migrations`.

**Regression rule:** any *new* failing test, or a count below the baseline, is a ❌ regression — investigate before proceeding. Do **not** "fix" by editing test files.

### One-shot sweep helper

```bash
# Runs build+test for every repo, logs to /tmp/labval, prints a summary.
mkdir -p /tmp/labval
for d in ikbi luak howa toba ittunaha kokuli mad-ptah pehlichi loony-luna nusika honola; do
  pm=pnpm; case $d in kokuli|nusika|honola) pm=npm;; esac
  ( cd /pehverse/repos/$d \
    && { [ $pm = npm ] && npm run build || pnpm build; } > /tmp/labval/$d.build.log 2>&1 \
    && $pm test > /tmp/labval/$d.test.log 2>&1; echo "$d exit=$?" )
done
grep -hE "^# (tests|pass|fail)|Tests +[0-9]" /tmp/labval/*.test.log
```

---

## 3. Integration Tests — data flow between projects

The pipeline is **Luak benchmarks → observation-ingest → Lab Spine → Capability Ledger → ikbi**. Verify each hop's data is real, not stubbed.

### 3.1 Luak exports benchmark bundles
```bash
curl -s http://localhost:18795/api/runs | head -c 400          # list of run ids
# detail of one run (signed EvidenceBundle JSON):
RID=$(curl -s http://localhost:18795/api/runs | grep -oE '"[a-f0-9-]{8,}"' | head -1 | tr -d '"')
curl -s http://localhost:18795/api/runs/$RID | head -c 600
```
✅ Pass: you get JSON bundles with task scores (correctness/regression/integrity/efficiency) + usage. On-disk copies live under `luak/runs/` (`*.json` + `.hash`).

### 3.2 Observation-ingest → Lab Spine (Ittunaha)
```bash
# Spine is append-only JSONL by UTC day under $LAB_SPINE_ROOT (default /mnt/ai/lab-context-spine)
ls -la "${LAB_SPINE_ROOT:-/mnt/ai/lab-context-spine}/observations/" | tail
# Recent observations via API (when ittunaha is up):
curl -s "http://localhost:18783/api/nous/observations?days=7&limit=5"
```
✅ Pass: dated `.jsonl` files exist and grow; API returns observation rows.

### 3.3 Capability Ledger (Ittunaha Nous store)
```bash
# Capability scores aggregated from Luak runs:
curl -s http://localhost:18783/api/nous/capability-scores | head -c 600
# Or inspect the store directly:
find /pehverse/repos/ittunaha -name scores.json -path '*nous*' -exec head -c 400 {} \;
```
✅ Pass: `CapabilityScore` records (modelId, category, score, confidence, sampleCount, evidenceSources like `luak:run_…`).

### 3.4 ⚠️ ikbi ← Capability Ledger (KNOWN GAP)
```bash
# This SHOULD show ikbi consuming the ledger. Today it returns nothing — gap G1.
grep -rn "capability-scores\|/api/nous\|CapabilityScore\|ledger" \
  /pehverse/repos/ikbi/src/modules --include=*.ts | grep -v test
```
❌ Expected today: **no matches** → ikbi routing is static-config-driven, not capability-driven. When this hop is built, this grep should hit a ledger client in `agent-router`/`cognition-layer`. Treat a continued empty result as "integration not yet done," not a regression.

---

## 4. Agent Capability Tests — can each agent do its job?

### 4.1 ikbi makes real model calls (the critical proof)
```bash
cd /pehverse/repos/ikbi
IKBI_ALLOW_INSECURE_DEV_KEYS=true \
IKBI_EGRESS_ALLOWLIST="api.xiaomimimo.com,api.deepseek.com,openrouter.ai" \
node --import tsx -e '
(async()=>{
  await import("./src/modules/egress/index.ts");                 // load egress floor FIRST
  const prov = await import("./src/core/provider/index.ts");
  const identity = { agentId:"validator", functionalRole:"operator", trustTier:"trusted" };
  for (const m of ["mimo-v2.5","mimo-v2.5-pro","deepseek-v4-pro"]) {
    try { const r = await prov.invokeModel({ model:m, identity, temperature:0, maxTokens:24,
      messages:[{role:"user",content:"Reply with the single word PONG."}] });
      console.log(m, "OK tokens="+r.usage?.totalTokens, JSON.stringify((r.content||"").trim())); }
    catch(e){ console.log(m, "FAIL", e.message); } }
})();'
```
✅ Pass: `mimo-v2.5` and `mimo-v2.5-pro` print `"PONG"`; `deepseek-v4-pro` returns 200 (content may be empty).
**Two required env vars** (learned the hard way):
- `IKBI_ALLOW_INSECURE_DEV_KEYS=true` — else core refuses to boot without trust keys.
- `IKBI_EGRESS_ALLOWLIST=...provider hosts...` — else egress is **default-deny** and every call fails closed (gap G3).
- Must `import` `src/modules/egress/index.ts` **before** the provider, or you get *"no egress fetch guard registered."*

### 4.2 ikbi tool dispatch
```bash
cd /pehverse/repos/ikbi
grep -n "name:" src/modules/worker-model/builder.ts | head            # expect the 16-tool array
node --import tsx --test src/modules/worker-model/builder-tools/*.test.ts 2>&1 | tail -5
```
✅ Pass: builder exposes read_file, write_file, list_dir, search_files, patch, terminal, git_*, web_*, delegate_task, vision_analyze, scout_detail, run_checks, done; tool tests green.

### 4.3 Trio agents answer
```bash
for e in "Ptah:18810" "Pehlichi:18831" "Luna:18792"; do
  n=${e%%:*}; p=${e##*:}
  echo "== $n =="; curl -s http://localhost:$p/health | head -c 200; echo
done
```
✅ Pass: each returns its agent name + model + toolCount. (The trio are **standalone**; ikbi does not call them — gap G5.)

---

## 5. Escalation Tests — model-tier escalation

### 5.1 Config sanity + env overrides
```bash
cd /pehverse/repos/ikbi
# Defaults vs overrides (note the REAL env var names):
IKBI_ALLOW_INSECURE_DEV_KEYS=true \
  node --import tsx -e 'import("./src/modules/escalation/config.ts").then(m=>{
    const c=m.escalationConfig;
    console.log("thresholds w->m/m->f:", c.workerToMidThreshold, c.midToFrontierThreshold);
    console.log("maxEscalations:", c.maxEscalations);
    console.log("tierModels:", JSON.stringify(c.tierModels)); })'
```
✅ Expect: thresholds `50` / `70`, `maxEscalations: 2`, three tier rosters.

### 5.2 Tier → registry coverage (gap G2 guard)
```bash
cd /pehverse/repos/ikbi
IKBI_ALLOW_INSECURE_DEV_KEYS=true node --import tsx -e '
(async()=>{ await import("./src/modules/egress/index.ts");
  const prov=await import("./src/core/provider/index.ts");
  const ids=prov.registry.listModels().map(m=>m.id);
  const tm=(await import("./src/modules/escalation/config.ts")).escalationConfig.tierModels;
  for(const t of ["worker","mid","frontier"]) for(const m of tm[t])
    console.log(t, m, ids.includes(m)?"REGISTERED":"** NOT IN REGISTRY **");
})();'
```
✅ Healthy state: every tier's **first** model is REGISTERED.
⚠️ Today: `worker:deepseek-v4-flash`, `worker:minimax-m2.7`, `frontier:gpt-5.5`, `frontier:opus-4.8` are NOT registered — a `mid→frontier` escalation would fail. Fix by adding ids to `state/providers.json` or setting `IKBI_ESCALATION_*_MODELS`.

### 5.3 Escalation unit suite
```bash
cd /pehverse/repos/ikbi
node --import tsx --test src/modules/escalation/escalation.test.ts 2>&1 | tail -6
```
✅ Pass: green. Covers: worker→mid auto (no approval), mid→frontier always-requires-approval, cap at `maxEscalations`, decline-reasons, idempotent `evaluate` + committing `recordEscalation` (C1).

---

## 6. Regression Tests — what to check after any change

1. **Build everything** that the change touches: `pnpm build` (TS strict — must be 0 errors).
2. **Run the affected repo's full suite** and confirm the count **≥ baseline** (Section 2). Never edit existing tests to make them pass.
3. **If you touched ikbi provider/escalation/router/cognition:**
   - re-run Section 4.1 (live calls), 5.1–5.3 (escalation), and `node --import tsx --test src/modules/agent-router/*.test.ts src/modules/cognition-layer/*.test.ts`.
   - Confirm C1 (evaluate idempotent + recordEscalation commits), H1 (brace-counting `extractFirstJsonObject` in both router.ts and cognition.ts), H2 (env overrides) still hold.
4. **If you touched the pipeline (luak/ittunaha):** re-run Section 3.1–3.3.
5. **Health smoke** (Section 1) — nothing you changed should knock a service offline.
6. **No new npm deps** in ikbi without checking existing ones (per `CLAUDE.md`).

---

## 7. Acceptance Criteria — "the lab is ready"

The lab passes when **all** of these hold:

| Check | Threshold |
|-------|-----------|
| **Builds** | 11/11 repos `build` with exit 0 (TS strict). |
| **Tests** | **4823 pass**, failures **≤ 17** and **only** the named baselines (luak 16, ittunaha 1). Zero new failures. |
| **Services** | ikbi (18796), Ptah (18810), Pehlichi (18831), Luna (18792), Luak (18795), Howa (18799) all return health 200. |
| **Model calls** | Section 4.1 — `mimo-v2.5` and `mimo-v2.5-pro` return `"PONG"`; `deepseek-v4-pro` returns 200. |
| **Escalation** | Section 5 — thresholds 50/70, cap 2, escalation suite green. |
| **Pipeline backbone** | Section 3.1–3.3 — Luak bundles exist, spine JSONL grows, capability scores present. |
| **Fixes intact** | C1 + H1 (both files) + H2 verifiable. |

### Known-not-ready (tracked gaps, do NOT block "foundation ready", DO block "specialization ready")
- **G1** ikbi does not query the Capability Ledger (Section 3.4) — *the* integration to build next.
- **G2** escalation frontier/worker tiers reference unregistered models (Section 5.2).
- **G3** default egress allowlist excludes provider hosts (Section 4.1 env workaround).
- **G4** plaintext API keys in `state/providers.json` → move to env, gitignore `state/`.
- **G5** ikbi↔trio dispatch not wired (standalone by design today).
- **G6** Ittunaha API (18783) down; Nusika inactive.

**Foundation readiness = Sections 1–2, 4.1, 5 green.** **Specialization readiness additionally requires G1 + G2 closed.**

---

*Generated by the lab validation sweep, 2026-06-10. Companion to `docs/LAB-VALIDATION-REPORT.md`.*
