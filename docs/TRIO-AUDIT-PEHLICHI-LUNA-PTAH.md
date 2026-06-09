# Trio Audit — Pehlichi, Loony-Luna, Mad-Ptah vs Hermes Agent

**Auditor:** Bubbles (DeepSeek v4 Pro, fresh pass)  
**Date:** 2026-06-09  
**Scope:** Side-by-side comparison of the three pehverse agents, then vs Hermes Agent  
**Method:** md5-verified core identity check, structural diff, tool inventory, architecture pattern comparison

---

## Executive Summary

**The three agents share an identical core runtime.** All 11 core files and all 12 agent-tools files are byte-for-byte identical (md5 verified). The architecture rule "each agent owns its own core — no shared lab-agent-core dependency" is correctly implemented via copy/paste of the core, and the copies have not drifted. Tests pass on all three (pehlichi: ✓, loony-luna: ✓, mad-ptah: ✓).

**However,** three structural inconsistencies exist between the agents, and when compared against Hermes Agent, the trio is missing several experience and architecture features.

---

## PART 1: TRIO SIDE-BY-SIDE

### 1.1 Core Identity Confirmation

All of these files are **byte-for-byte identical** across all three agents (md5 verified):

| Core File | pehlichi | loony-luna | mad-ptah |
|-----------|----------|------------|----------|
| `src/core/tools.ts` | ✓ | ✓ | ✓ |
| `src/core/loop.ts` | ✓ | ✓ | ✓ |
| `src/core/index.ts` | ✓ | ✓ | ✓ |
| `src/core/driver.ts` | ✓ | ✓ | ✓ |
| `src/core/workspace.ts` | ✓ | ✓ | ✓ |
| `src/core/prompt.ts` | ✓ | ✓ | ✓ |
| `src/core/agent-tools/index.ts` | ✓ | ✓ | ✓ |
| `src/core/context-compressor.ts` | ✓ | ✓ | ✓ |
| `src/core/checkpoint.ts` | ✓ | ✓ | ✓ |
| `src/core/events.ts` | ✓ | ✓ | ✓ |
| `src/core/bridge-adapter.ts` | ✓ | ✓ | ✓ |
| `src/core/profile.ts` | ✓ | ✓ | ✓ |
| `src/tools/bridge-tools.ts` | ✓ | ✓ | ✓ |

| Agent-Tools File | pehlichi | loony-luna | mad-ptah |
|------------------|----------|------------|----------|
| `browser-manager.ts` | ✓ | ✓ | ✓ |
| `browser-tools.ts` | ✓ | ✓ | ✓ |
| `circuit-breaker.ts` | ✓ | ✓ | ✓ |
| `clarify-tools.ts` | ✓ | ✓ | ✓ |
| `cron-tools.ts` | ✓ | ✓ | ✓ |
| `delegate-tools.ts` | ✓ | ✓ | ✓ |
| `enhanced-file-tools.ts` | ✓ | ✓ | ✓ |
| `error-classifier.ts` | ✓ | ✓ | ✓ |
| `execute-code-tools.ts` | ✓ | ✓ | ✓ |
| `input-sanitization.ts` | ✓ | ✓ | ✓ |
| `iteration-budget.ts` | ✓ | ✓ | ✓ |
| `lab-context-tools.ts` | ✓ | ✓ | ✓ |
| `memory-tools.ts` | ✓ | ✓ | ✓ |
| `openrouter-driver.ts` | ✓ | ✓ | ✓ |
| `prompt-injection.ts` | ✓ | ✓ | ✓ |
| `provider-chain.ts` | ✓ | ✓ | ✓ |
| `retry.ts` | ✓ | ✓ | ✓ |
| `schema-sanitizer.ts` | ✓ | ✓ | ✓ |
| `skill-tools.ts` | ✓ | ✓ | ✓ |
| `todo-tools.ts` | ✓ | ✓ | ✓ |
| `token-monitor.ts` | ✓ | ✓ | ✓ |
| `vision-tools.ts` | ✓ | ✓ | ✓ |
| `web-tools.ts` | ✓ | ✓ | ✓ |

**Verdict:** Core runtime is truly identical. No drift detected. The architecture rule is holding.

### 1.2 File Counts

| Agent | Source Files | Test Files | Sanity Files | 
|-------|-------------|------------|-------------|
| pehlichi | 57 | 7 (in test cmd) | 1 (`sanity-peh.ts`) |
| loony-luna | 56 | 7 (but only 6 in test cmd) | 0 files (script references dead path!) |
| mad-ptah | 59 | 6 (in test cmd) | 3 (`sanity.ts`, `sanity-mimo.ts`, `sanity-mimo-dual.ts`) |

### 1.3 Structural Inconsistencies Found

#### FINDING T1 [MEDIUM] — loony-luna missing sanity file but package.json references it

**What:** `package.json` has `"sanity:luna-wyrms": "node --import tsx src/sanity-luna-wyrms.ts"` but the file `src/sanity-luna-wyrms.ts` does NOT exist anywhere in the repo. No sanity file exists at all for Luna.

**Impact:** The script will fail at runtime. Luna has no smoke test.

#### FINDING T2 [MEDIUM] — loony-luna and mad-ptah skip profile.test.ts

**What:** pehlichi's test command includes `src/profile.test.ts`. Both loony-luna and mad-ptah have `src/profile.test.ts` present on disk but do NOT include it in their test runner command.

**Impact:** Profile logic is untested for Luna and Ptah. If a profile change breaks the test, pehlichi's CI would catch it but the other two wouldn't.

**Command comparison:**
- pehlichi: `... src/core/shadow.test.ts src/profile.test.ts` ← includes profile test
- loony-luna: `... src/core/shadow.test.ts` ← missing profile.test.ts
- mad-ptah: `... src/core/shadow.test.ts` ← missing profile.test.ts

#### FINDING T3 [LOW] — Profile definition location inconsistent

**What:** pehlichi defines `pehProfile` in `src/profile.ts`. mad-ptah defines `ptahProfile` in `src/profile.ts`. loony-luna defines `lunaProfile` in `src/profiles/luna.ts` — a different path pattern.

**Impact:** Not a bug, but inconsistency. If a tool/script expects `import { XProfile } from "./profile.js"`, Luna won't be found.

#### FINDING T4 [LOW] — loony-luna has extra dependency

**What:** loony-luna depends on `@pehverse/comfyui-bridge` (file: `../../bridges/comfyui`). pehlichi and mad-ptah don't have any bridge dependencies in package.json (though all three have bridge-tools.ts in core).

**Impact:** Luna's build will fail if the comfyui bridge isn't present. The other two agents build independently.

---

## PART 2: TRIO CORE TOOL INVENTORY

The core runtime provides a tool registration seam (`extraTools`) so each agent can add its own tools. The built-in set is minimal:

### Core Built-in Tools (from tools.ts)

| Tool | Description |
|------|-------------|
| `terminal` | Shell command — locked cwd=workspace, stripped env, capped output, timeout. Supports background mode |
| `process` | Manage background processes — list, poll, wait, kill, write |

### Agent-Tools (in src/core/agent-tools/, identical across all three)

| Module | What it provides |
|--------|-----------------|
| `browser-tools` | Browser automation (Playwright) |
| `clarify-tools` | User clarification questions |
| `cron-tools` | Scheduled task management |
| `delegate-tools` | Subagent task delegation |
| `enhanced-file-tools` | File read, write, search, patch |
| `execute-code-tools` | Sandboxed code execution |
| `lab-context-tools` | Cross-agent lab memory access |
| `memory-tools` | Persistent memory read/write/query |
| `skill-tools` | Skill loading and management |
| `todo-tools` | Task list tracking |
| `vision-tools` | Image analysis |
| `web-tools` | Web search and content extraction |

### Agent-Specific Tools (via extraTools seam)

| Agent | Extra Tools Defined In |
|-------|----------------------|
| pehlichi | `src/tools/bridge-tools.ts` (bridge tool specs for coordination) |
| loony-luna | `src/tools/bridge-tools.ts` (ComfyUI bridge specs) |
| mad-ptah | `src/tools/bridge-tools.ts` (bridge tool specs) |

Note: `src/tools/bridge-tools.ts` is IDENTICAL across all three (md5 verified). The bridge tool registration is the same; the profiles select different subsets via allowlists.

---

## PART 3: TRIO ARCHITECTURE vs HERMES AGENT

### 3.1 Architecture Patterns Comparison

| Architecture Feature | Trio Agents | Hermes Agent |
|---------------------|-------------|--------------|
| **Language** | TypeScript (Node.js 22+) | Python |
| **Runtime model** | Disposable per-run (profile + skillpack + goal) | Persistent session (conversation loop) |
| **Tool system** | `extraTools` seam + `toolNames` allowlist per run | Toolsets (24 toolsets: web, terminal, file, browser, etc.) |
| **Tool registration** | Static Map in `createToolRegistry()` | Central `registry.py` with `register()` pattern |
| **Provider model** | Multi-driver: MiMo, Ollama, llama.cpp, OpenRouter | Multi-provider: 20+ providers (OpenRouter, Anthropic, OpenAI, DeepSeek, etc.) |
| **Personality** | Profile (AgentProfile) + SkillPack | Personality system |
| **Skills** | SkillPack selected per-run, loaded from `lab-store/skills/` | Skill system with hub, curator, auto-install |
| **Memory** | `lab-memory` (shared durable store, cross-agent) | `~/.hermes/state.db` (SQLite + FTS5) + pluggable backends |
| **Session model** | Per-run, disposable | Persistent sessions with resume, export, session search |
| **Context compression** | Yes (context-compressor.ts) | Yes (configurable threshold/target_ratio) |
| **Subagent delegation** | Yes (delegate-tools.ts) | Yes (delegate_task, spawn, tmux) |
| **Cron/scheduling** | Yes (cron-tools.ts) | Yes (cron job scheduler with scripts, chaining) |
| **Workspace isolation** | Disposable workspace per run | Worktree mode (`-w` flag), checkpoints |
| **Checkpoints** | Yes (checkpoint.ts) | Yes (`/snapshot`, `/rollback`) |
| **Progress/events** | Events bus (events.ts) | Progress events + spinner + TUI |
| **Error handling** | Error classifier (error-classifier.ts) + retry | Error handling + circuit breaker patterns |
| **Input safety** | Prompt injection scanner + sanitizer | Secret redaction + PII redaction |

### 3.2 What Hermes Agent Has That The Trio Doesn't

| Feature | Hermes | Trio | Severity |
|---------|--------|------|----------|
| **Multi-platform gateway** | Telegram, Discord, Slack, Matrix, Signal, WhatsApp, SMS, Email, etc. | None (run via CLI/API only) | HIGH (for ops) |
| **Voice/STT/TTS** | Local faster-whisper, Groq, OpenAI, ElevenLabs, Edge TTS | None | MEDIUM |
| **MCP servers** | Native MCP client + server, auto-discovery | None | HIGH |
| **IDE integration** | VS Code, JetBrains, ACP server | None | MEDIUM |
| **Web interface** | Browser-based Claude Code on the Web | None | LOW |
| **Desktop app** | Native macOS/Windows app | None | LOW |
| **Slash commands** | 40+ in-session commands (/reset, /rollback, /model, /compact, etc.) | None (single-shot runs) | HIGH (experience) |
| **Credential pools** | Multi-key rotation, OAuth | None (env vars only) | MEDIUM |
| **Profiles per user** | Multiple independent Hermes configs | None (single profile per agent) | LOW |
| **Skill curator** | Auto-maintenance of agent-created skills | None (manual skill management) | MEDIUM |
| **Webhooks** | Inbound event-driven agent runs | None | LOW |
| **File checkpoints** | `/rollback` with filesystem snapshots | Workspace-level undo only | MEDIUM |
| **Context visibility** | Context usage %, token counts | Internal only, not displayed | HIGH (experience) |
| **Cost visibility** | Cost display after operations | Computed internally, not shown | HIGH (experience) |
| **Session search** | FTS5 full-text search across past conversations | None | MEDIUM |
| **Session export** | Export to JSONL | None | LOW |
| **Kanban** | Multi-agent work queue system | None (routing via pehlichi only) | MEDIUM |
| **Smart home** | Home Assistant integration | None | N/A for lab |
| **Spotify** | Music control | None | N/A for lab |

### 3.3 What The Trio Has That Hermes Agent Doesn't

| Feature | Trio | Hermes | Notes |
|---------|------|--------|-------|
| **Lab memory (cross-agent)** | Shared `lab-memory` store accessed by all three agents | Per-session memory only | Trio advantage |
| **Lab store** | Shared `lab-store` for skills, conventions | Skills in `~/.hermes/skills/` | Different model |
| **Bridge pattern** | Structured bridge-tools for inter-service communication | MCP servers | Different approach |
| **Disposable runs** | Every run is fresh — no persistent session state | Persistent sessions | Design choice |
| **PrimarySkill model** | Each run has a skillpack that defines HOW the agent works | Skills loaded as supplementary context | Trio's model is more opinionated |
| **Coordinator agent** | Pehlichi routes tasks to Luna/Ptah | No dedicated coordinator (single agent) | Trio advantage for multi-agent workflows |
| **Prompt injection scanner** | Active scanning for injection patterns | Secret/PII redaction only | Trio advantage |
| **Input sanitization** | Schema-based sanitizer per tool | None (raw tool args) | Trio advantage |

---

## PART 4: EXPERIENCE GAPS — TRIO vs HERMES

### 4.1 [HIGH] No interactive session mode

**Hermes:** Full TUI with prompt_toolkit, slash commands, spinners, cost display. Interactive chat with `/reset`, `/rollback`, `/model`, `/compact`.

**Trio:** Single-shot runs only. No interactive loop. Fire a command, get a result. No ability to iterate mid-session.

**Impact:** This is the biggest experience gap. Hermes feels like a conversation partner. The trio feels like a batch job. For development use, interactive iteration is essential.

### 4.2 [HIGH] No session management

**Hermes:** Sessions persist, can be resumed (`--continue`), exported, searched (FTS5), renamed, deleted, pruned.

**Trio:** Every run is disposable. No resume capability. No search across past runs.

**Impact:** If a build fails halfway through, you start over from scratch. No ability to say "continue where we left off."

### 4.3 [HIGH] No slash commands

**Hermes:** 40+ in-session commands. `/rollback` to undo a bad change. `/model` to swap models mid-session. `/compact` to compress context. `/cost` to see spending.

**Trio:** No in-run controls. Once a run starts, you wait until it completes or fails. No mid-run intervention except kill.

### 4.4 [MEDIUM] No MCP integration

**Hermes:** Native MCP client can connect to any MCP server (stdio or HTTP). Tools auto-discovered and exposed. Can also run AS an MCP server.

**Trio:** Bridge system for inter-service communication, but no MCP protocol support. Bridges are hardcoded per-service rather than protocol-based.

### 4.5 [MEDIUM] No multi-platform gateway

**Hermes:** Same agent accessible from 15+ messaging platforms. Start a task on Telegram, check results on Discord.

**Trio:** CLI/API only. No messaging platform integration. Agents can't be messaged directly.

### 4.6 [MEDIUM] No cost or context visibility

**Hermes:** Shows cost after operations, context usage as percentage. Users know how much they're spending and how close they are to limits.

**Trio:** Cost is computed by the provider chain but never displayed. Context compression is silent. Operating blind on both spending and capacity.

### 4.7 [LOW] No voice interface

**Hermes:** Voice-to-text (STT) and text-to-voice (TTS) with multiple providers. Voice memos on messaging platforms.

**Trio:** Text-only. No audio interface.

---

## PART 5: ARCHITECTURE PATTERNS — STRENGTHS AND WEAKNESSES

### Trio Strengths

1. **Clean separation** — Each agent owns its core. No shared runtime dependency. This is the RIGHT pattern and it's holding (verified identical but independent).

2. **Disposable runs** — Every run is fresh. No state leakage between sessions. This is safer for autonomous operation than persistent sessions.

3. **SkillPack model** — Separating "who the agent is" (profile) from "how the agent works" (skillpack) is architecturally elegant. Hermes conflates these.

4. **Coordinator pattern** — Pehlichi as router is a genuine multi-agent architecture. Hermes is single-agent.

5. **Input safety** — Prompt injection scanning + schema sanitization. Hermes only has secret redaction, no injection awareness.

6. **Lab memory** — Cross-agent durable memory is a real differentiator. Hermes memory is per-session.

### Trio Weaknesses

1. **No interactive mode** — Single-shot runs are too rigid for development workflows. Need a REPL/interactive mode (ikbi has this now via HB-5).

2. **No session resume** — Starting over from scratch for every run is wasteful for complex tasks.

3. **No protocol-based interop** — Bridges are hardcoded per-service. MCP would be a more flexible pattern.

4. **Tool registry is sparse** — Only 2 core tools (terminal, process). The rest come from agent-tools (which ARE identical). But compared to Hermes' 24 toolsets, it's thin.

5. **No credential management** — API keys in env vars only. No OAuth, no key rotation, no credential pools.

6. **No file checkpoints** — Can't rollback individual file changes within a run. Only whole-workspace undo.

---

## PART 6: RECOMMENDATIONS

### 🔴 Fix Now (bugs)

1. **T1 — Create loony-luna's missing sanity file** — Either create `src/sanity-luna-wyrms.ts` or remove the broken script from package.json. A script referencing a nonexistent file is a landmine.

2. **T2 — Add profile.test.ts to loony-luna and mad-ptah test commands** — Both agents have the test file on disk but don't run it. One-line fix in package.json.

### 🟡 Address Soon (architecture consistency)

3. **T3 — Standardize profile definition location** — Choose one pattern: either `src/profile.ts` (like pehlichi/mad-ptah) or `src/profiles/<name>.ts` (like loony-luna). Standardize across all three.

### 🟢 Invest In (experience improvement)

4. **Add interactive REPL to agents** — ikbi has `ikbi repl` (HB-5). The trio needs the same. A persistent conversation loop with slash commands would transform the experience.

5. **Add MCP protocol support** — Instead of hardcoded bridges, implement MCP client in the core. Would make new service integrations zero-code.

6. **Surface cost and context** — The data is computed internally. Display it. Users should see: cost per run, context usage %, token counts.

7. **Add session management** — Even basic resume support ("continue from run X") would be a massive experience improvement over the current disposable model.

8. **Add file-level checkpoints** — Snapshots at each tool call boundary for `/rollback`-style undo.

---

## Bottom Line

**The core runtime is identical and healthy.** The architecture rule "no shared runtime" is working — verified byte-for-byte across 35+ files. Tests pass on all three.

**The inconsistencies are minor:** a missing sanity file on Luna, a skipped profile test on Luna and Ptah, and an inconsistent profile file location. Easy fixes.

**Against Hermes Agent, the trio wins on architecture** (coordinator pattern, lab memory, input safety, disposable runs) **but loses badly on experience** (no interactive mode, no sessions, no slash commands, no cost visibility, no MCP, no gateway).

The gap is almost entirely surface-level. The engine is solid. The experience needs the same treatment ikbi got — colored diffs, context bars, cost display, interactive REPL, session resume.

---

*Report generated by Bubbles (DeepSeek v4 Pro, trio audit, 2026-06-09)*
