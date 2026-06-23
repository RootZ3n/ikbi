# ikbi → Claude Code Replacement: What's Needed

**Auditor:** Julian (Hermes) — based on Codex audit, Bubbles audit, GLM 5.2 audit, and direct code inspection
**Date:** 2026-06-18

## TL;DR

ikbi has a **stronger engine** than Claude Code — governed workspaces, verification gates, model flexibility, trust tiers, receipts. But the **surface** still leaks. The gap is 80% experiential (polish, defaults, error messages) and 20% architectural (context management, large-repo retrieval). At current velocity, ikbi can be a credible Claude Code replacement in **2-3 weeks** of focused surface work. The engine is done. The wrapping isn't.

## Architecture Gaps (the engine)

### 1. Context Management for Large Repos — Priority: HIGH
**Status:** Works on small repos, degrades on large ones.
**Problem:** ikbi has no smart context windowing. Claude Code uses file-tree awareness, relevance scoring, and lazy loading to handle 1000+ file repos. ikbi dumps context into the model and hopes it fits.
**Fix:** Add a context manager that: (a) indexes the file tree on session start, (b) loads files lazily based on relevance to the prompt, (c) has a hard context budget with priority eviction.
**Effort:** 3-5 days. `src/core/context/` (new module).
**Priority:** HIGH — this is the #1 architectural gap.

### 2. Browser/Visual Tools — Priority: MEDIUM
**Status:** Missing.
**Problem:** Claude Code can browse the web, take screenshots, and inspect rendered UIs. ikbi has no browser integration.
**Fix:** Add a Playwright/Puppeteer tool that the agent can call. MCP browser servers exist.
**Effort:** 2-3 days. Wire an MCP browser server or add a built-in browser tool.
**Priority:** MEDIUM — not blocking daily coding, but blocks UI debugging workflows.

### 3. Multi-File Edit Coordination — Priority: MEDIUM
**Status:** Works but fragile.
**Problem:** When the agent needs to edit 5+ files in a coordinated way (rename a class across a codebase, refactor an API), ikbi's build loop handles it but can lose coherence across iterations. Claude Code's single-turn multi-edit is smoother.
**Fix:** Add a "batch edit" mode where the agent plans all edits first, then applies them atomically.
**Effort:** 2-3 days. `src/modules/worker-model/builder.ts`.
**Priority:** MEDIUM — real work hits this regularly.

### 4. Streaming Tool Output — Priority: LOW
**Status:** Already fixed (SSE /chat/stream).
**Problem:** Was the #1 architectural blocker. Now resolved.
**Fix:** Done. `tui/src/server.ts` — SSE endpoint, 60s timeout, intent routing.
**Priority:** RESOLVED.

### 5. Model Fallback Chain — Priority: LOW
**Status:** Exists and works.
**Problem:** `--fallback-model` is wired. Escalation from flash→pro works. This is already better than Claude Code (which has no fallback).
**Fix:** Already done.
**Priority:** RESOLVED.

## Experience Gaps (the surface)

### 1. REPL Reliability — Priority: CRITICAL
**Status:** Works but not boringly reliable.
**Problem:** The REPL is the golden path now, but it still has edge cases: startup logs leak on some paths, session resume can lose context, error messages from the agent loop are raw/technical. Claude Code's REPL is boring — it just works, every time, with clean output.
**Fix:**
- Harden the REPL entry path (no-args dispatch) — suppress ALL internal logs
- Add a `--clean` flag that strips all non-model output
- Make session resume show a summary of what was being worked on
- Wrap raw errors in user-friendly messages
**Effort:** 2-3 days. `src/modules/chat/cli.ts`, `src/cli/index.ts`.
**Priority:** CRITICAL — this is what users see every day.

### 2. Error Messages — Priority: HIGH
**Status:** Technical, not helpful.
**Problem:** When things go wrong (model timeout, tool failure, context overflow), ikbi shows raw error objects. Claude Code shows "I had trouble with X, let me try Y." ikbi shows `Error: circuit_breaker_open at Object.runAgent (loop.ts:266)`.
**Fix:** Add error translation layer that converts technical errors to user-friendly messages with suggested actions.
**Effort:** 1-2 days. `src/core/errors/` (new module).
**Priority:** HIGH — bad error messages kill trust.

### 3. First-Run Experience — Priority: HIGH
**Status:** Fixed (ikbi init), but needs real-world testing.
**Problem:** The init flow is now correct (IKBI_ prefixed env vars, guided setup, 4 profiles). But nobody has tested it on a fresh machine with a real new user. Claude Code's first-run is `npm install -g @anthropic-ai/claude-code && claude` — that's it.
**Fix:** Test `ikbi init` on a fresh machine. Fix anything that breaks. Add a `ikbi doctor --fix` that auto-repairs common issues.
**Effort:** 1 day. Test + iterate.
**Priority:** HIGH — first impression is everything.

### 4. Help System — Priority: MEDIUM
**Status:** Fixed (6 commands default, --advanced for full).
**Problem:** The help is now clean, but `--advanced` still dumps everything. Claude Code has contextual help — `claude help <command>` shows detailed usage for that command.
**Fix:** Add `ikbi help <command>` that shows detailed usage, examples, and common flags for that specific command.
**Effort:** 1 day. `src/cli/index.ts`.
**Priority:** MEDIUM — discoverability matters.

### 5. CI/Automation — Priority: MEDIUM
**Status:** Exists (`--headless`, `--quiet`, `--json`).
**Problem:** The pipeline works but documentation is sparse. Claude Code has clear CI docs with GitHub Actions examples.
**Fix:** Write CI documentation with real GitHub Actions/GitLab CI examples. Test `ikbi build --headless --quiet --json` end-to-end.
**Effort:** 1 day. Docs + testing.
**Priority:** MEDIUM — CI adoption drives ecosystem growth.

### 6. Quiet Mode — Priority: LOW
**Status:** Fixed (repl --quiet).
**Problem:** Was broken, now gates all non-model output.
**Fix:** Done. `src/modules/chat/cli.ts`.
**Priority:** RESOLVED.

## What ikbi Already Does BETTER

1. **Model Freedom** — ikbi supports 12+ providers (Anthropic, OpenAI, DeepSeek, OpenRouter, Google, Groq, xAI, Ollama, Mistral, Together, MiniMax, MiMo). Claude Code is locked to Anthropic. This is a massive advantage.

2. **Governance** — Trust tiers, verification gates, receipts, workspace isolation, promotion gates. Claude Code has none of this. For a lab/team environment, ikbi's governance is years ahead.

3. **Cost Control** — Role-specific models, escalation chains, fallback routes, per-task cost accounting. Claude Code charges flat rate per token. ikbi lets you optimize cost per task type.

4. **Verification** — Anti-cheat, no-vacuous-green, script-integrity guards, retained failed workspaces. Claude Code trusts the model. ikbi verifies everything.

5. **Local-First** — localhost/Tailscale posture, local state, no cloud dependency. Claude Code requires Anthropic's cloud. ikbi works fully offline with Ollama.

6. **Build/Repair Loop** — The agent loop with critic, verifier, refuter, and escalation is more sophisticated than Claude Code's single-pass approach. ikbi can detect when it failed and retry with a stronger model.

7. **Hooks System** — PreToolUse/PostToolUse/Stop hooks let operators inject custom logic. Claude Code has no equivalent.

8. **Session Fork** — `ikbi repl --fork <id>` lets you branch a conversation. Claude Code can't do this.

## The 5 Things to Fix First

### 1. REPL Entry Path Hardening (CRITICAL)
Make `ikbi` (no args) open a perfectly clean REPL. Zero startup logs, zero config output, zero noise. Just the REPL prompt. This is the #1 daily experience.
- File: `src/cli/index.ts`, `src/modules/chat/cli.ts`
- Effort: 1 day

### 2. Error Message Translation (HIGH)
Wrap all technical errors in user-friendly messages. When the model times out, say "The model took too long — try a simpler prompt or switch to a faster model." Don't show stack traces.
- File: `src/core/errors/` (new), `src/core/loop.ts`
- Effort: 1-2 days

### 3. Context Manager for Large Repos (HIGH)
Add smart context loading: file tree index, lazy loading, relevance scoring, context budget. This is the #1 architectural gap.
- File: `src/core/context/` (new)
- Effort: 3-5 days

### 4. First-Run Real-World Testing (HIGH)
Test `ikbi init` on a fresh machine with a real user. Fix everything that breaks. Add `ikbi doctor --fix`.
- File: `src/cli/init.ts`, `src/cli/doctor.ts`
- Effort: 1 day

### 5. Contextual Help (MEDIUM)
Add `ikbi help <command>` with detailed usage, examples, and common flags.
- File: `src/cli/index.ts`
- Effort: 1 day

## Verdict

**ikbi is 2-3 weeks of focused surface work from being a credible Claude Code replacement.**

The engine is done — and in many ways, it's already better than Claude Code (model freedom, governance, verification, cost control). The gap is entirely on the surface: REPL reliability, error messages, context management for large repos, and first-run experience.

The honest positioning today: **"A governed, model-flexible, verification-heavy coding agent with a stronger engine than Claude Code — and a surface that's catching up fast."**

The positioning after 3 weeks of surface work: **"A Claude Code replacement that works with any model, verifies its own work, and costs less."**

**Timeline:**
- Session 1: REPL hardening + error messages + first-run testing
- Session 2: Context manager + contextual help + CI docs
- Session 3: Real-world dogfooding + edge case fixes + polish

After session 3, run the Codex audit again. The verdict will change.
