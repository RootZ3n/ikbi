# Level 2 Proving Notes — Repository Understanding

Date: 2026-06-11
Tester: Julian (Hermes)
ikbi version: 0.1.0, 1284 tests, critic=minimax-m3, builder=deepseek-v4-flash

---

## Test 1: Audit Toba + Generate Architecture Docs
**Goal:** "Audit this repository. Generate ARCHITECTURE.md."
**Repo:** toba
**Result:** PARTIAL SUCCESS (writeScope enforcement working, pre-existing test mismatch)
**Cost:** $0.04 | **Time:** 2:29

### What happened:
- Scout: ✅ Read entire repo, understood structure
- Builder: ✅ Created ARCHITECTURE.md (new file, writeScope allowed)
- Builder: ✅ Did NOT modify ui/index.html (writeScope blocked)
- Test failure: Pre-existing — `ui/index.html` (world engine UI) doesn't reference `/assets/styles.css` which the test expects from the original SPA
- Workspace retained (correct behavior)

### WriteScope enforcement (NEW):
- `detectWriteScope("Audit...Generate ARCHITECTURE.md")` → `"new_only"` ✅
- `write_file` on ARCHITECTURE.md → ALLOWED (new file, existsSync=false) ✅
- `write_file` on ui/index.html → NOT ATTEMPTED (builder respected the system prompt hint) ✅
- Terminal write commands → Blocked by pattern matching ✅

### Key finding:
**The writeScope enforcement works.** The builder respects the "new_only" constraint. The test failure is NOT from the builder — it's a pre-existing mismatch between the world engine UI and the original test expectations.

---

## Test 2: Find Dead Code
**Status:** Not re-run after writeScope fix. First attempt failed because writeScope didn't exist yet.

---

## Level 2 Verdict: PARTIALLY PROVEN

### What works:
- Scout role: excellent at understanding repos (reads all files, identifies structure)
- WriteScope enforcement: prevents builder from modifying existing files on doc/audit tasks
- Builder creates new files correctly when writeScope is "new_only"
- Cost efficiency: $0.04 per attempt

### What needs work:
- Pre-existing test mismatch in Toba (ui/index.html vs original SPA test expectations)
- The builder still writes to ui/index.html when writeScope is "all" (the original problem)
- Need to run L2 tests on a repo without pre-existing test failures

### Architecture improvements made:
1. `writeScope` field added to WorkerTask contract
2. `detectWriteScope()` auto-detects doc/audit tasks from goal text
3. `write_file` handler rejects writes to existing files when writeScope is "new_only"
4. `patch` handler rejects all modifications when writeScope is "new_only"
5. `terminal` handler rejects file-writing shell commands when writeScope is restricted
6. System prompt includes WRITE SCOPE hint when restricted
7. Debug logging added for writeScope resolution

### Next steps:
1. Run L2 on a clean repo (no pre-existing test failures)
2. Or fix the Toba test mismatch first
3. Then L2 should be fully proven
