# ikbi Fresh-Pass Audit — Architecture & Experience Gaps vs Claude Code

**Auditor:** Bubbles (fresh-eyes pass #2, DeepSeek v4 Pro)  
**Date:** 2026-06-09  
**Repo:** `/pehverse/repos/ikbi`  
**ikbi state:** commit `8efd7ff`, 940/940 tests passing, 276 source files  
**Scope:** NEW gaps only — things previous audits did not catch. Architectural and experience gaps specifically requested by Zen.

---

## What's NEW in ikbi Since Last Audit

ikbi added 15 commits since the previous comparison. These are all solid additions:
- SG-10 Human-approval gate before promote
- SG-7 Worktree cleanup + `ikbi clean`
- SG-3 `ikbi undo` for reverting promotions
- SG-4 `ikbi receipts` operational log
- HB-5 `ikbi repl` interactive chat session
- SG-5 Structured build progress events + `--verbose`
- SG-2 `ikbi diff` surfacing
- SG-1 Governed exec stream command output live
- HB-6 .env autoload + doctor/help survives fresh shell
- Project memory loading from CLAUDE.md/AGENTS.md (audit Fix 4)

These close several prior gaps. The fresh audit below focuses on what's STILL missing.

---

## SECTION A: ARCHITECTURE GAPS

### A1 [HIGH] — No plan-then-execute mode

**What Claude Code does:** CC has three modes — Agent mode (full tool access), Edit mode (focused surgical edits), and Architect mode (read-only analysis that produces a plan, saved to a file, which the user then asks to execute). This is a fundamental workflow distinction. Architect mode is zero-risk — files are never touched. Users can iterate on the plan before a single byte is written.

**What ikbi has:** The cognition layer (`src/modules/cognition-layer/`) does bare-goal deliberation at the CLI entry point — it recommends which module to route to (agent-router, batch-planner, drift-prevention, worker-model). But this is a ONE-SHOT routing decision, not an in-session planning phase. The builder jumps straight into scout→build with no "let me analyze and present a plan first" step.

**Why this matters:** For complex tasks, CC users frequently do `architect mode → review plan → agent mode` to avoid wasteful edits. ikbi goes straight to building. The cognition layer has the right idea but is scoped to routing, not planning.

**Gap:** No way to say "analyze this codebase and tell me your plan before touching anything."

### A2 [HIGH] — No snapshot/rollback of file changes

**What Claude Code does:** CC has a `/rollback` command that backs out individual file changes using a filesystem snapshot system. Users can undo the last change, or roll back to a specific point.

**What ikbi has:** The kill-switch can halt operations at checkpoints. `ikbi undo` (SG-3) reverts a promotion (the whole build result). But there is no per-file or per-operation rollback. If the builder writes 5 files and only file 3 was wrong, there's no way to selectively roll back file 3.

**Why this matters:** CC's `/rollback` is one of its most-used features. ikbi's granularity is at the build/promotion level, not the individual tool-call level.

**Gap:** No intra-build selective rollback. The only undo is at the promotion (commit) level.

### A3 [MEDIUM] — No multi-file coordinated edit pattern

**What Claude Code does:** CC can present a unified diff across multiple files as one operation. "Here are the changes needed: in file A, lines 10-15 change to X; in file B, add function Y at line 80; in file C, remove class Z." The user reviews this as one coherent change set.

**What ikbi has:** Each `write_file`, `patch`, and `terminal` call is atomic and independent. The integrator reviews all files together at the end, but the builder makes each change one at a time. There's no "here's my plan across these N files" display.

**Why this matters:** Code changes often span multiple files. Reviewing them as one coherent diff (rather than sequential individual edits) catches cross-file inconsistencies.

**Gap:** Builder makes changes file-by-file. No cross-file unified diff presentation.

### A4 [MEDIUM] — No commit message generation

**What Claude Code does:** CC generates detailed, conventional-commit-formatted messages describing WHAT changed and WHY. "feat(auth): Add JWT refresh token rotation to prevent session hijacking — adds refresh token blacklisting in Redis, updates middleware to check blacklist on each request, and adds integration tests."

**What ikbi has:** The orchestrator can auto-commit via `workspaces.commit(handle, message)` but the message comes from... where? The integrator's rationale string is used as the commit message (see `orchestrator.ts:103`), which is a one-liner like "promote: builder wrote 3 file(s), no rejected tool calls, critic pass, verifier pass". Compare that to CC's detailed messages.

**Why this matters:** Git history is documentation. CC's commit messages are genuinely useful. ikbi's are mechanical.

**Gap:** No model-generated commit message. The existing message is the integrator's internal rationale, not a human-readable summary.

### A5 [MEDIUM] — No linting integration

**What Claude Code does:** CC can run linters (ESLint, ruff, clippy, etc.) and feed their output back into the loop. The model sees lint errors and fixes them before declaring done.

**What ikbi has:** The verifier runs `tsc --noEmit` and `pnpm test`. No linter awareness. The builder never sees style/convention errors.

**Why this matters:** For TypeScript/JavaScript projects, linting is a first-class concern. CC catches lint errors that ikbi's verifier would miss, since it only runs typecheck + tests.

**Gap:** No linter/formatter stage in the verify pipeline. Only typecheck + tests.

### A6 [LOW] — No PR creation

**What Claude Code does:** CC can `gh pr create` with the generated commit message and description.

**What ikbi has:** Git commit only. No PR workflow integration.

**Gap:** ikbi stops at commit. CC goes through to PR.

---

## SECTION B: EXPERIENCE GAPS

### B1 [HIGH] — No context window visibility

**What Claude Code does:** CC shows context usage as a percentage bar — "Context: 45%". The user knows how close they are to the limit. When it gets high, CC suggests `/compact`.

**What ikbi has:** The context manager (`context-manager.ts`) silently compresses at 0.5-0.7 thresholds depending on model context size. The compression is internal — no user-facing indicator that the context is filling up or that compression happened.

**Why this matters:** Operating blind on context usage is stressful. The user doesn't know if the next message will overflow. CC's context bar is universally praised.

**Gap:** Zero visibility into context window pressure. Compression is silent.

### B2 [HIGH] — No cost visibility

**What Claude Code does:** CC shows cost after each operation. "Cost: $0.042 this session ($1.23 today)".

**What ikbi has:** Cost is computed per-invocation in `core/provider/invoke.ts:152` (`computeCost(rate, result.usage)`) and stored on the response. But it's never displayed to the user. No CLI flag, no endpoint, no per-build cost summary.

**Why this matters:** One of ikbi's MAIN selling points is cost efficiency (6.5x cheaper than CC). But the user can't see the savings! CC proudly displays cost; ikbi buries it.

**Gap:** Cost is computed but invisible. No `--cost` flag or endpoint.

### B3 [MEDIUM] — No inline colored diffs

**What Claude Code does:** CC displays diffs with syntax highlighting, colored +/- markers, and line numbers — exactly like `git diff` with delta or diff-so-fancy.

**What ikbi has:** `git_diff` returns raw unified diff text. The `ikbi diff` CLI (SG-2) may surface this, but the builder's tool output is plain text diff, not formatted.

**Why this matters:** Reading raw unified diffs is mentally taxing compared to colored, highlighted diffs. This is an experience regression vs CC.

**Gap:** Diffs are raw text. No ANSI coloring, no syntax highlighting, no +/- decorations.

### B4 [MEDIUM] — No task checklist during build

**What Claude Code does:** CC maintains an implicit task list: "I need to: 1) Add the JWT refresh function, 2) Update the middleware, 3) Add tests, 4) Update docs." It checks items off as it goes. The user can see progress against the plan.

**What ikbi has:** The builder has a `done` tool with `selfCheck` and `satisfied` fields, but no running checklist. The `done` call is one-shot at the end — no incremental "here's what I've done so far, here's what's left."

**Why this matters:** For builds spanning 5-20 tool calls, the user has no idea which step the builder is on. CC's implied task tracking gives confidence.

**Gap:** No structured task decomposition or progress tracking within a build.

### B5 [MEDIUM] — No user interaction during builds

**What Claude Code does:** CC asks clarifying questions mid-build: "Should this be a POST or PUT endpoint?" or "I found two approaches — which do you prefer?"

**What ikbi has:** The human-approval gate (SG-10) pauses before promotion for user approval. But the builder cannot ask questions DURING the build loop. If it hits ambiguity, it must guess or fail.

**Why this matters:** For non-trivial tasks, ambiguity is common. CC resolves it; ikbi guesses.

**Gap:** No mid-loop user clarification. Human gate is only at the end (before promote).

### B6 [LOW] — No shell integration

**What Claude Code does:** CC installs shell aliases (`cc`), integrates with bashrc/zshrc, and can be invoked from anywhere. Users can pipe context in: `cat error.log | claude "what's wrong?"`

**What ikbi has:** ikbi is a systemd daemon. No `ikbi` command unless you're in the repo directory. No shell aliases, no stdin piping.

**Why this matters:** CC's shell integration makes it feel like a native command. ikbi feels like a service you have to explicitly target.

**Gap:** No shell integration or STDIN piping.

### B7 [LOW] — No progress indicators during long operations

**What Claude Code does:** CC shows a spinner with what it's doing: "Reading codebase..." "Analyzing dependencies..." "Writing files..." 

**What ikbi has:** Structured progress events (SG-5) are PUBLISHED to the event bus, but the user sees them only if running `--verbose`. The default output is silent until completion.

**Why this matters:** For builds that take 60+ seconds, silence is unnerving. The user doesn't know if the build is working or hung.

**Gap:** Progress events exist but are silent by default. No spinner or activity indicator.

### B8 [LOW] — No auto-discovery of project structure

**What Claude Code does:** CC auto-discovers the project structure on startup — "I see a TypeScript project with Express, Jest, and Prisma." It reads package.json, tsconfig.json, etc. automatically.

**What ikbi has:** The scout reads the repo structure as part of the build pipeline. But there's no "project overview" on session start. The `ikbi repl` starts with a blank slate until the first command.

**Why this matters:** CC's project greeting gives immediate confidence that it understands the codebase. ikbi's scout requires the build to start before anything is known.

**Gap:** No auto-discovery at session/REPL start. Scout only runs inside a build.

---

## SECTION C: FEATURES COMPARISON MATRIX (NEW ITEMS ONLY)

| Feature | CC | ikbi | Gap Severity |
|---------|----|------|-------------|
| Plan-then-execute (Architect mode) | yes | CLI routing only | **HIGH** |
| Snapshot / rollback per file | yes | Promotion-level undo only | **HIGH** |
| Context window visibility | yes % shown | internal only | **HIGH** |
| Cost visibility | yes displayed | computed but hidden | **HIGH** |
| Inline colored diffs | yes | raw text only | MEDIUM |
| Task checklist during build | yes implicit | done-only | MEDIUM |
| Mid-build user clarification | yes | pre-promote only | MEDIUM |
| Commit message generation | yes detailed | mechanical rationale only | MEDIUM |
| Multi-file coordinated edits | yes unified diff | file-by-file | MEDIUM |
| Linting integration | yes | typecheck+tests only | MEDIUM |
| PR creation | yes `gh pr` | none | LOW |
| Shell integration / aliases | yes | daemon only | LOW |
| Progress indicators | yes spinner | silent by default | LOW |
| Auto-discover project structure | yes on startup | scout-on-build only | LOW |

---

## SECTION D: PRIORITIZED RECOMMENDATIONS

### 🔴 This Week (architecture blocks)

1. **Add architect/plan mode to chat** — Extend the chat session with a `mode: "plan"` parameter. In plan mode, read-only tools only. The model analyzes and writes a plan to a file. The user reviews, then invokes agent mode. This mirrors CC's architect→agent workflow and builds on the existing cognition layer.

2. **Surface cost** — Add `--cost` flag and `cost_usd` to build output. The data is already computed in `invoke.ts:152`. Just needs display plumbing. ikbi's #1 advantage is cost — SHOW IT.

### 🟡 This Month (experience quality)

3. **Show context pressure** — Expose context window usage as a percentage. The context manager already knows the window size and compression thresholds. Add a `context_percent` field to progress events.

4. **Colored diffs** — Pipe git diff output through a simple ANSI colorizer. The `chalk` dependency already exists in the TUI (`tui/node_modules/.pnpm/chalk@5.6.2/`). ~20 lines of code.

5. **Task checklist** — After the scout runs, generate a structured task list from the findings. Display as checkboxes. Builder marks them complete with each `done` attempt.

### 🟢 Nice to Have

6. **Linter integration** — Add `eslint` / `prettier --check` as optional verifier checks. Configurable via env var `IKBI_LINT_COMMAND`.
7. **Mid-build clarification** — Add a `clarify` tool to the builder toolset. Builder can ask one question, user answers inline. Bounded to 1 question per build.
8. **Shell integration** — A one-line install script: `curl -s ... | bash` that puts `ikbi` on PATH.
9. **PR creation** — `ikbi pr-create` command wrapping `gh pr create` with the build's commit.

---

## SECTION E: WHAT'S ALREADY GOOD (don't touch)

ikbi's architecture is genuinely impressive in areas where CC is weak:
- **Worktree isolation** — CC runs in-repo. ikbi uses disposable git worktrees. This is architecturally superior.
- **5-role pipeline with gated completion** — Scout→Builder→Critic→Verifier→Integrator with `done` gated on `run_checks` green. CC's single model does everything; ikbi's multi-role design catches errors CC misses.
- **Competitive builds** — Race N models. CC can't do this at all.
- **Injection neutralization** — Mandatory chokepoint. CC has no equivalent.
- **Governed exec with binary allowlist** — CC uses user-permission model. ikbi's is safer for autonomous use.
- **Receipt store + operational log** — CC has session history. ikbi has durable, bounded, attributed receipts.
- **Cost is 6.5x lower than CC** — The architecture was designed for cheap models and it delivers.

---

## Bottom Line

ikbi is a better *engine* than Claude Code. The governance, isolation, and pipeline architecture is genuinely superior. But CC is a better *experience* — plans, rollbacks, colored diffs, cost visibility, context bars, task checklists, shell integration. These are ALL surface-level features, not architectural changes.

The top 4 gaps are each under 100 lines of code and already have data infrastructure in place:
- Cost visibility (data computed, not displayed)
- Context pressure (thresholds exist, not shown)
- Colored diffs (chalk is in the TUI deps)
- Architect mode (cognition layer is halfway there)

**Recommendation:** Ship these four first. They close the experience gap without touching architecture.

---

*Report generated by Bubbles (DeepSeek v4 Pro, fresh-pass audit #2, 2026-06-09)*
