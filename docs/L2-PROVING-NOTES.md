# Level 2 Proving Notes — Repository Understanding

Date: 2026-06-11
Tester: Julian (Hermes)
ikbi version: 0.1.0, 1284 tests, critic=minimax-m3, builder=deepseek-v4-flash

---

## Test 1: Audit Toba + Generate Architecture Docs
**Goal:** "Audit this repository thoroughly. Generate ARCHITECTURE.md..."
**Repo:** toba
**Result:** FAILURE (builder over-reached)
**Cost:** $0.20 | **Time:** 2:25

### What happened:
- Scout: ✅ Read entire repo, understood structure
- Builder: Created ARCHITECTURE.md (413 lines, thorough, accurate)
- Builder ALSO rewrote ui/index.html (the world engine UI we built)
- Test broke: `expect(body).toContain("/assets/styles.css")` — the existing UI file was overwritten
- Workspace retained, not promoted ✅

### What went right:
- ARCHITECTURE.md quality was excellent — accurate module structure, data flows, API surface
- Safety system worked — test failure caught, workspace retained
- Scout correctly identified all key components

### What went wrong:
- **CRITICAL: Builder over-writes existing files even on doc-only tasks**
- Builder should only CREATE new files when the task is documentation
- The world engine UI (600+ lines, carefully built) was replaced with builder's own version

---

## Test 2: Find Dead Code in Toba
**Goal:** "Analyze this repository for dead code... Do NOT modify any existing files — only create DEAD-CODE-REPORT.md"
**Repo:** toba
**Result:** FAILURE (same pattern — builder overwrote ui/index.html)
**Cost:** $0.20 | **Time:** 2:25

### What happened:
- Scout: ✅ Read repo, identified code patterns
- Builder: Attempted to create DEAD-CODE-REPORT.md
- Builder ALSO rewrote ui/index.html AGAIN — even with explicit "Do NOT modify" instruction
- Test broke: same `/assets/styles.css` assertion
- Workspace retained, not promoted ✅

### Critical finding:
**The builder ignores explicit "do not modify" instructions in the goal.** The goal text literally said "Do NOT modify any existing files" and the builder still overwrote the UI file.

---

## Level 2 Verdict: NOT PROVEN

### Root Cause:
The builder (deepseek-v4-flash) has a **file boundary discipline problem**. When it reads a file during exploration, it treats it as something to "improve" and writes its own version, regardless of the task scope.

### What this means:
- L1 (bounded tasks like "add a comment") works because the scope is narrow
- L2 (understand and report) fails because the builder explores broadly and then over-writes
- The safety system catches it every time — but the builder can't complete the task

### Required fix before L2 can pass:
The builder needs **file boundary enforcement** — either:
1. A "read-only" mode for doc/audit tasks (builder can read but not write to existing files)
2. A "create-only" mode where the builder can only create NEW files
3. A file allowlist in the goal that the builder must respect
4. The verifier/critic should catch unauthorized file modifications

### What worked:
- Scout role: excellent at understanding repos
- Critic (minimax-m3): would catch this if the builder's changes were reviewed
- Safety system: 100% catch rate on over-reaching builder
- Cost efficiency: $0.20 per failed attempt is acceptable

### What needs to change:
- Builder needs file boundary discipline (architecture fix, not model fix)
- The "do not modify" instruction in the goal should be enforced by the tool layer
- Consider adding a `writeScope` parameter to builder invocations

---

## Next Steps:
1. Fix builder file boundary enforcement in ikbi
2. Re-run L2 tests with the fix
3. If builder respects boundaries, L2 should pass (scout already proves understanding)
