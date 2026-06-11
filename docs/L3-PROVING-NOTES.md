# L3 Proving Notes — Lab Integration

## Test 1: Add a New Ptah Skill (Bridge Health Monitor)

**Goal:** Create a bridge health monitoring script for the Pehverse lab

**Input:** 7 agents with correct ports (Pehlichi@18830, Ptah@18810, Luna@18792, ikbi@18796, Howa@18799, Toba@18815, Nusika@18793)

**Builder output:**
- `scripts/check-bridges.sh` — 133 lines, valid bash syntax
- `docs/BRIDGE-HEALTH.md` — 82 lines, agent reference

**Quality assessment:**
- ✅ All 7 agents with correct ports
- ✅ Associative array for agent registry
- ✅ Color support with terminal detection
- ✅ Curl with timeout and HTTP code capture
- ✅ Summary table with formatted output
- ✅ Non-zero exit if any agent is down
- ✅ Script runs correctly against live lab (6/7 UP, Nusika DOWN = accurate)

**Issues found:**
- Builder creates target files early (turns 3-4) then continues creating unnecessary files
- Hits 40-iteration limit → pipeline reports "failure" despite correct output
- DeepSeek V4 Flash doesn't know when to stop
- Response time shows "?ms" (minor: `date +%s%3N` not supported on this system)

**Infrastructure fixes applied:**
1. Dependency guard blocks writes to `node_modules/`, `.git/`, `dist/`, `.next/`, `.cache/`
2. Guard returns clear error message guiding builder to valid directories

**Cost:** $0.008-$0.32/run (varies due to network errors and retries)

**Verdict:** PARTIAL PASS — builder creates correct, working files. Pipeline "failure" is from iteration limit, not output quality. The script is genuinely useful and runs correctly against the live lab.

**Known issue:** Builder lacks early-stop mechanism. DeepSeek V4 Flash treats 40-iteration budget as "use all 40" rather than "finish quickly." Needs investigation.
