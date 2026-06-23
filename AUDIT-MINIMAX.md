# ikbi → Claude Code Replacement Audit (MiniMax M3)

> Audit of `/pehverse/repos/ecosystem/ikbi` — a governed AI coding agent built as a
> Claude Code replacement that targets cheap/local models. This file judges ikbi
> against the *Claude Code surface*, not against benchmarks of raw capability.

## TL;DR

ikbi is **architecturally more interesting than Claude Code in every place where
trust/safety/injection-defense matter**, and **substantially behind Claude Code in
every place where day-to-day developer ergonomics matter**.

The frozen core (provider, injection, trust, identity, workspace, events, receipt,
substrate, config, contracts) is the right shape for a "safe Claude Code." The
governance modules (gate-wall, deterministic-judge, verification-ladder, kill-switch,
capability-*, drift-prevention, governed-exec) are unusually thorough for an OSS
agent. The trust-by-earning, MAC-protected tier system and the neutralization
chokepoint are not features any current Claude Code competitor ships.

But the **daily-driver surface** — `ikbi repl` — is still a CLI loop with slash
commands. There is no plan mode, no real session memory, no hooks, no parallel
subagent fan-out, no IDE integration, no background tasks, and the TUI package is
explicitly described as "not the primary surface." For a tool claiming to *replace*
Claude Code, that gap is the entire product story.

**Verdict:** as a *governed run-time for cheap models*, ikbi is ahead of the curve.
As a *Claude Code replacement* a developer would actually adopt for daily work, it
needs a focused UX-and-extensibility sprint before parity.

---

## Architecture Gaps (the engine)

These are places where the *internal machinery* doesn't yet match Claude Code's
runtime, even setting UX aside.

### 1. No plan-mode / interactive plan approval
Claude Code's plan mode is a first-class state: the agent explores read-only, emits
an `ExitPlanMode` tool call, the user edits/approves, then execution begins with
tracked permission grants. ikbi has `step-planner` and `batch-planner` modules but
the planner output flows directly into execution — there is no equivalent of an
`ExitPlanMode` gate where the user can amend the plan before any write happens.

This is the single biggest functional gap. Every serious coding agent in 2024–2025
treats plan-then-confirm as table stakes; without it, `ikbi build` is a black box
that either promotes or refuses.

### 2. No session-persistent memory
Claude Code persists across sessions: CLAUDE.md, project memory, conversation
resumability, learned conventions. ikbi has `lab-context-memory` and `cache`
modules but the conversation state in `ikbi repl` appears to be in-memory per
process. There is no analog of "remember this about this codebase" that survives
across `repl` invocations or `build` runs.

### 3. No hooks / extensibility surface
Claude Code exposes hooks (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`,
`SessionStart`, etc.) so users can wire in CI, lint guards, custom logging,
notifications, slash commands, and subagents. ikbi's extension story is
`mcp-model-loop` and the frozen core's capability system — both are *internal*
mechanisms, not *user-facing* extension points. A developer who wants to "run
`prettier` after every Edit" or "block writes to `*.test.ts`" cannot do so today
without patching the engine.

### 4. No subagent fan-out / parallel task execution
Claude Code's `Task` tool spawns subagents that run in parallel with isolated
contexts and report back. ikbi has `delegate_task` as a tool in the builder/chat
set, but the delegation appears to be sequential and the subagent's context is
not aggressively trimmed. For non-trivial features this is the difference
between "I'll parallelize this" and "I'll wait 4 minutes for one agent to do
it sequentially."

### 5. Background / long-running tasks
Claude Code supports backgrounded bash (Ctrl-B), `!` prefix, and detached agents
that survive a session. ikbi has no equivalent — every action blocks the REPL.
For a tool that promotes only on `run_checks` green, a 3-minute typecheck forces
the user to stare at the screen.

### 6. MCP integration breadth
Claude Code's MCP story is rich: stdio + HTTP transports, OAuth, dynamic tool
discovery, per-tool allowlisting. ikbi has `mcp-model-loop` but the surface area
looks narrower — there is no obvious MCP server registry, no OAuth flow, no
HTTP transport. In a world where MCP is becoming "the API for tools," this
constrains what ikbi can plug into.

### 7. Tool result budget / streaming
Claude Code streams tool results, has aggressive truncation with "output too
large, N bytes, first/last shown" UX, and a smart summarizer. ikbi's injection
chokepoint neutralizes results but the UX of "what to show the model when a
100MB log comes back" is not visibly solved — the user-facing consequence is
that builders either see walls of text or context blow-ups.

### 8. Agent SDK / programmatic API
Claude Code ships an `Agent SDK` so other tools can embed it. ikbi has a server
(`/agent` `/chat` `/capabilities`) and a CLI, but no documented programmatic
surface. If a third party wants to "use ikbi inside my own IDE," the entry
point is undocumented.

### 9. Vision / multimodal in the loop
Claude Code can read images dropped into chat. `vision_analyze` exists in the
tool list but its integration into the builder/chat loops is not visible —
screenshots and design references are not first-class inputs.

### 10. Web/desktop client parity
The `ui/` static SPA is described as one of three surfaces; the `tui/` is
explicitly "not the primary surface"; `ikbi repl` is the daily driver. There is
no desktop app, no browser extension, no IDE plugin. Claude Code has VS Code
and JetBrains extensions; Cursor and Windsurf ship their own. ikbi's surface
strategy is REPL-first which is a smaller addressable audience.

---

## Experience Gaps (the surface)

These are the things a developer using `ikbi repl` for an hour will notice
missing.

- **No plan mode.** (See above.) Every `build` is a black box.
- **No `/permissions` interactive UI.** The capability system is governed but
  the user can't tweak it live.
- **No `/resume` of arbitrary past sessions.** Session resume is mentioned but
  the UX of "show me my last 5 sessions and pick one" is not in the slash
  command list.
- **No `/init` / `/remember`.** No way to seed project memory.
- **No `/mcp` management slash command.**
- **No `@` file/agent mention syntax.** Claude Code's `@file.ts` and `@agent`
  mentions are a major UX accelerator.
- **No `/diff` of pending changes mid-task.** `ikbi diff` is a top-level
  command, not a slash command during execution.
- **No diff visualization inline.** When the builder proposes an edit, the
  user sees a description, not a colored diff.
- **No parallel-tool UX.** When the builder calls 4 tools in one turn, the REPL
  shows them sequentially.
- **No token/cost display in REPL.** Cost reporting is a separate `cost`
  command, not live.
- **No "thinking" streaming indicator.** MiniMax M3 streaming behavior is
  invisible to the user.
- **No interrupt / steer mid-tool.** While the builder is mid-`terminal`, the
  user can't redirect it.
- **No compact / context-pressure UX.** Claude Code tells you when context is
  filling; ikbi presumably truncates silently via the chokepoint.

---

## What ikbi Already Does BETTER

This is the part the audit tends to underweight. ikbi's design choices in these
areas are ahead of where Claude Code currently sits.

### A. Prompt-injection defense is real, not aspirational
The **neutralization chokepoint** (`src/core/injection`) is the single most
important architectural decision in the codebase. *Every* tool result re-enters
the model only after being neutralized. Claude Code's injection posture is
mostly "be careful what you put in tool results"; ikbi treats it as a hard
gate. For an agent that operates on cheap/local models with weaker
instruction-following, this is the right tradeoff and most competitors don't
make it.

### B. Trust is earned, not assumed
The `trust` module in the frozen core implements **MAC-protected trust tiers**
that an agent must earn through verified work. Claude Code's permission system
is one-shot and per-tool; ikbi's is cumulative and capability-bearing. This
lets ikbi grant a builder `terminal.exec` only after it has demonstrated
correctness — Claude Code cannot do that.

### C. Receipts are first-class
Every meaningful action emits a **receipt** (`src/core/receipt`). The `audit`,
`receipts`, and `undo` CLI commands expose this. Claude Code has no
audit/receipt trail users can inspect after the fact — its transcript is the
record. ikbi's receipts are tamper-evident and queryable, which is what you
want when a cheap model does something wrong at 3am.

### D. Governed exec is allowlisted, not advisory
`governed-exec` + `gate-wall` + `egress` enforce an allowlist on what the
terminal tool can run. The agent cannot `rm -rf` or `curl | sh` without
capability elevation. This is closer to a sandboxed build system than to a
chatbot with a shell.

### E. Verification ladder promotes, not just "passes"
The `verification-ladder` + `deterministic-judge` + `run_checks` chain means
promotion to the user's branch only happens after multi-stage verification.
Claude Code's "did it pass the tests?" is whatever the agent says it did; ikbi
has a structural answer that doesn't trust the model.

### F. Frozen core with module-only extensions
The discipline of "changes to `src/core/` only with care" + "engine modules
live in `src/modules/`" is the kind of separation that lets the project grow
without becoming Claude Code's "everything is in the prompt" situation. The
seams are real, not aspirational.

### G. Worktree isolation is structural, not a flag
Every `build` and `fix` runs in a managed worktree. Promotion is the only way
changes reach the user's tree. Claude Code edits in-place. For an agent that
might be wrong, this is the safer default.

### H. The CLI registry pattern is clean
`src/cli/` with command registration is more discoverable than the implicit
slash-command set Claude Code grew organically. ikbi can document every
command's contract; Claude Code's slash commands have surfaced ad-hoc.

### I. `project-index` + `project-retrieval` is a real retrieval system
991 lines of indexer + 262 lines of retriever is a non-trivial code-search
substrate. Claude Code's retrieval is essentially grep + ReAct. For a cheap
model that can't hold a 200k-line repo in its head, having an explicit index
is the right architectural choice.

### J. `lab-context-memory` is the seed of real memory
The fact that this module exists at all means ikbi is thinking about
cross-session memory architecturally, even if the current UX doesn't expose it.

### K. `capability-*` modules
The capability system being broken into multiple modules (`capability-*`)
suggests real thought about least-privilege per tool category, not a single
`--dangerously-skip-permissions` flag.

### L. Drift prevention / self-observation
`drift-prevention` + `self-observation` are the modules you wish every coding
agent had. They imply ikbi watches its own behavior over time for degradation,
not just within a single session.

---

## The 5 Things to Fix First

If ikbi has one quarter to close the gap to "developer would actually switch from
Claude Code," these are the five things, ordered by leverage.

### 1. **Add plan mode + interactive plan approval**
- New state machine: `PLAN_PROPOSED` → user edits/approves → `EXECUTE`.
- Wire it into both `ikbi build` and `ikbi repl` as a slash command + auto-trigger
  for non-trivial tasks.
- Surface a diff preview per planned file change before execution.
- This single feature converts ikbi from "black-box batch tool" to "agent I trust
  with a 2-hour refactor." Without it, the verification ladder is doing extra work
  on plans the user never saw.

### 2. **Add a hooks / extension surface**
- `~/.ikbi/hooks/` with `PreToolUse`, `PostToolUse`, `Stop`, `SessionStart` JSON
  dispatch.
- Slash-command registration (`/my-command`) loaded from disk.
- MCP server registry with stdio + HTTP + OAuth.
- This single feature unlocks CI integration, custom slash commands, and the entire
  MCP ecosystem. It is also the cheapest path to "embed ikbi in another tool."

### 3. **Make session memory real and visible**
- Persist conversation + memory across `repl` invocations.
- Add `/remember`, `/forget`, `/memory` slash commands.
- CLAUDE.md equivalent loaded automatically; project-memory stored under
  `.ikbi/memory/`.
- Without memory, every `repl` is a stranger. With memory, ikbi becomes a teammate.

### 4. **Parallel tool execution + subagent fan-out**
- Allow builder/chat turns to issue multiple tool calls in parallel where the
  dependency DAG permits.
- Make `delegate_task` spawn a properly-isolated subagent with its own context
  budget, and let the parent receive a compressed report.
- This is the difference between 30s and 5min on a typical feature build.

### 5. **IDE / VS Code extension (thin)**
- A minimal VS Code extension that wraps `ikbi repl` in a side panel with
  `@file` mentions, inline diffs, and one-click promotion.
- This is the on-ramp to adoption for the largest single segment of Claude Code
  users. The TUI and `ui/` SPA are nice; an IDE extension is where the time is
  spent.

**Bonus sixth, if budget allows:** kill the "TUI is not the primary surface"
caveat by either investing in it or removing the package. Half-built surfaces
hurt adoption more than missing surfaces.

---

## Verdict

ikbi is the most thoughtfully governed OSS coding agent I have seen at this
size. Its frozen core, injection chokepoint, trust tiers, receipts, governed
exec, verification ladder, and worktree isolation form a coherent safety story
that Claude Code — which is fundamentally a single-process CLI with a prompt —
does not match.

The gap to "Claude Code replacement a developer would adopt daily" is not in
the engine. It is in:

1. **Plan mode** (functional gap, biggest leverage)
2. **Hooks / extensibility** (functional gap, ecosystem unlock)
3. **Real session memory** (UX gap, retention unlock)
4. **Parallel execution + subagents** (performance gap, speed unlock)
5. **IDE integration** (distribution gap, adoption unlock)

None of these require touching the frozen core. All of them are modules +
UX work. That is the cheapest possible path to parity, and it is the path
that preserves what makes ikbi better than the thing it is trying to replace.