# ikbi Experience Gaps — What's Missing to Replace Claude Code

**Compiled by:** Bubbles
**Date:** June 10, 2026
**Context:** The ikbi ENGINE is ready. The ikbi EXPERIENCE is not. This is the gap list.

---

## THE HARD TRUTH

Claude Code replaced: you open a terminal, type `claude`, and it works. You see your project. You ask for something. You watch it happen. You see diffs. You see cost. You undo mistakes. You resume where you left off. The experience is frictionless.

ikbi today: powerful engine, bare cockpit. You can fly the plane but you can't see the instruments.

---

## PRIORITY 1: DAILY DRIVER BASICS (without these, it's not a replacement)

### 1. Session Resume
**What CC does:** `claude --continue` resumes your last session. `claude --resume <id>` picks a specific one. You close your laptop, open it tomorrow, pick up exactly where you left off.

**ikbi today:** REPL is ephemeral. Close it, lose everything. No resume capability.

**Why it blocks replacement:** Without resume, every interruption is a hard reset. A 30-minute build that's 80% done? Gone. A conversation with context about a complex bug? Gone. This alone makes ikbi unusable for real daily work.

### 2. Session Management
**What CC does:** `claude sessions list` shows recent sessions. You can browse, rename, delete, export. Your work history is searchable.

**ikbi today:** No session list. No session search. No export. Nothing persists.

**Why it blocks replacement:** You can't find what you did yesterday. You can't reference a previous solution. You can't prove what was changed or why.

### 3. Context Window Visibility
**What CC does:** Shows context usage as a percentage bar. "Context: 45%". When it gets high, you know to `/compact`. You never suddenly hit the limit.

**ikbi today:** Context compression is silent. The user has zero visibility into how full the context window is. The first sign of trouble is the model refusing to respond.

**Cost to fix:** The data is already computed (`estimateTokens`). Just needs a display line in the REPL.

### 4. File Rollback
**What CC does:** `/rollback` undoes the last file change. `/rollback 3` undoes the last 3. You can experiment freely knowing you can always undo.

**ikbi today:** No intra-session rollback. `ikbi undo` reverts promotions at the commit level, but within a REPL session, you can't undo a bad `write_file` or `patch`.

**Why it blocks replacement:** Fear of mistakes slows down work. Without undo, every tool call is a commitment. CC's rollback makes experimentation safe.

### 5. Slash Commands
**What CC does:** `/help`, `/model`, `/compact`, `/reset`, `/cost`, `/status`, `/rollback`, `/memory`, `/permissions`, `/agents` — 40+ in-session commands.

**ikbi today:** `/plan`, `/agent`, `/exit`. That's it.

**Missing commands that matter daily:**
| CC Command | What it does | ikbi status |
|-----------|-------------|-------------|
| `/model` | Switch models mid-session | ❌ |
| `/compact` | Manually compress context | ❌ |
| `/reset` | Start fresh session | ❌ |
| `/cost` | Show spending | ❌ (data exists but not in REPL) |
| `/status` | Show session info | ❌ |
| `/rollback` | Undo last file change | ❌ |
| `/memory` | View/edit persistent instructions | ❌ |
| `/help` | Show available commands | ❌ (partial — no command list) |

---

## PRIORITY 2: DEVELOPER COMFORT (makes it feel polished)

### 6. Project Auto-Discovery
**What CC does:** On startup: "I see a TypeScript project with Express, Jest, and Prisma. 240 source files, 85 test files." You know immediately that it understands your codebase.

**ikbi today:** REPL starts blank. No greeting. No project overview. The scout only runs inside a build, not at session start.

**Why it matters:** First impressions. CC feels intelligent from the first second. ikbi feels like a blank terminal.

### 7. Inline Diffs with Syntax Highlighting
**What CC does:** Shows diffs with green/red highlighting, line numbers, and context — exactly like `git diff` with delta.

**ikbi today:** Has `colorizeDiff()` (recently added) but it's only ANSI codes in CLI output. The REPL doesn't show diffs after tool calls. You have to run `ikbi diff <id>` separately.

**Cost to fix:** Wire `colorizeDiff` into the REPL's tool result display.

### 8. Progress Indicators
**What CC does:** Shows a spinner with what it's doing. "Reading codebase..." "Analyzing dependencies..." "Writing files..." You know the system is working.

**ikbi today:** Structured progress events exist but are hidden behind `--verbose`. The REPL is silent until completion. A 60-second build looks like a hang.

**Cost to fix:** Wire the existing progress events to the REPL display. A spinner + phase name is ~20 lines.

### 9. User Memory / Instructions
**What CC does:** `/memory` lets you set persistent instructions. "Always use conventional commits." "Never modify package-lock.json." These persist across sessions.

**ikbi today:** No persistent user-facing memory. Lab-context-memory exists but is agent-to-agent, not user-to-agent.

**Why it matters:** CC learns your preferences over time. ikbi forgets everything every session.

### 10. Permission Modes
**What CC does:** `auto` (auto-approve safe commands), `accept` (prompt on dangerous), `manual` (prompt on all), `prohibit` (block all). Plus per-tool permission rules.

**ikbi today:** Human-approval gate exists only at promotion time (SG-10). No per-command or per-tool permissions during the REPL session.

**Why it matters:** Trust. CC's permission system lets you gradually increase autonomy as you gain confidence. ikbi is all-or-nothing.

---

## PRIORITY 3: POLISH (the things that make it feel complete)

### 11. Shell Integration
**What CC does:** `claude` command available from any directory. `claude "fix the login bug"` from scripts. `cat error.log | claude "what's wrong?"` for piped input. Shell aliases auto-installed.

**ikbi today:** Must be in the ikbi repo directory. No global command. No piped input. No scriptability.

**Cost to fix:** A one-line shell script in PATH: `node --import tsx /pehverse/repos/ikbi/src/cli/index.ts repl "$@"`

### 12. Prompt Caching Visibility
**What CC does:** Shows when prompt caching is active. You know you're saving money on repeated context.

**ikbi today:** No caching visibility. Cost is shown but caching savings are invisible.

### 13. Model Hot-Swap
**What CC does:** `/model` opens an interactive picker. Swap from Sonnet to Opus mid-session without losing context.

**ikbi today:** Model is set at startup via env vars. Can't change mid-session.

### 14. Background Tasks
**What CC does:** On desktop/web, you can kick off long-running tasks and check back later. Multiple tasks run in parallel.

**ikbi today:** Single-threaded REPL. One task at a time. Start it and wait.

### 15. Multi-Platform Access
**What CC does:** Terminal, VS Code, JetBrains, Desktop app, Web, Slack, Chrome extension. Start on one, continue on another.

**ikbi today:** CLI REPL + HTTP API. No IDE integration. No messaging platform integration (that's the trio's job, not ikbi's).

### 16. Error Recovery Hints
**What CC does:** When a command fails, it suggests what went wrong. "The TypeScript compiler couldn't find module X. Did you forget to install dependencies?"

**ikbi today:** Tool failures return raw exit codes and output. The model can interpret them but the system doesn't help.

---

## WHAT'S ALREADY FIXED (don't redo these)

| Feature | Status |
|---------|--------|
| Cost visibility | ✅ Added (in API responses, needs REPL display) |
| Colored diffs | ✅ `colorizeDiff()` exists (needs REPL wiring) |
| Plan mode | ✅ Full plan mode with `/plan` in REPL |
| Context pressure | ✅ `context_percent` in API (needs REPL display) |
| Verification correctness | ✅ HARDENED ladder default |
| Retrieval | ✅ HARDENED index default |

---

## ESTIMATED EFFORT

| Priority | Items | Approximate Effort |
|----------|-------|-------------------|
| P1: Daily Driver (1-5) | Session resume, session mgmt, context bar, rollback, slash commands | 2-3 days |
| P2: Developer Comfort (6-10) | Project discovery, inline diffs, progress, memory, permissions | 2-3 days |
| P3: Polish (11-16) | Shell integration, caching, model swap, background, multi-platform, error hints | 2-3 days |

**Total to feel like a Claude Code replacement: ~1-2 weeks of focused work.**

The hard part — the engine, the verification, the governance — is done. What's left is the cockpit. Gauges, switches, and a steering wheel for a plane that already flies.

---

*Report generated by Bubbles, June 10, 2026*
