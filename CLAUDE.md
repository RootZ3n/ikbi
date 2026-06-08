# ikbi — Build/Repair Engine

## What This Is
ikbi (Choctaw: "to build") is the lab's coding agent. It's designed to be a Claude Code replacement that works with cheap/local models. The architecture gives cheap models every advantage: evidence-based verification, governed execution, competitive mode.

## Architecture
- **14 modules**, TypeScript, Node.js 22+
- **Core modules:** provider (model invocation), injection (security), trust (earned autonomy), identity, workspace (git worktrees), events, receipt, substrate
- **Action modules:** worker-model (scout/builder/critic/verifier/integrator), batch-planner, agent-router, cognition-layer, mcp-model-loop, gate-wall, governed-exec, subagent-spawning, egress, cache, self-observation, capability-recovery, drift-prevention, lab-context-memory, kill-switch, dependency-install
- **CLI:** `node dist/cli/index.js` (built with `pnpm build`)
- **Server:** Fastify on port 18796
- **Tests:** `pnpm test` (717 tests, all passing)
- **Build:** `pnpm build` (TypeScript compilation)

## Key Directories
- `src/core/` — frozen core (provider, injection, trust, identity, workspace, events, receipt, substrate, contracts)
- `src/modules/` — 14 modules (each has index.ts, config.ts, contract.ts, events.ts, implementation.ts)
- `src/cli/` — CLI entry, registry, doctor
- `src/server/` — Fastify HTTP server
- `tui/` — Ink/React terminal UI (TO BE CREATED)

## Current State
The BUILDER (src/modules/worker-model/builder.ts) has only 5 tools:
- read_file, write_file, list_dir, run_checks, done

It NEEDS more tools to match Claude Code. The trio (Pehlichi/Ptah/Luna) already has a full tool suite at `/pehverse/bridges/shared/agent-tools/` with 31 tools.

## What To Build

### Part 1: Builder Tool Expansion
Port these tools from `/pehverse/bridges/shared/agent-tools/` into `src/modules/worker-model/builder-tools/`:
1. `terminal.ts` — shell command execution (THE most important tool)
2. `search-files.ts` — grep/rg codebase search
3. `patch.ts` — surgical file edits (find-and-replace)

Add these to the builder's TOOLS array in builder.ts.

### Part 2: TUI (Ink/React)
Create `tui/` directory with:
- `tui/src/app.tsx` — Main TUI app (Ink/React)
- `tui/src/entry.tsx` — Entry point
- `tui/src/lib/skin.ts` — Skin loader (reads skin.yaml)
- `tui/src/lib/personality.ts` — Personality loader (reads personality/*.yaml)
- `tui/src/lib/chat.ts` — Chat session (conversation state, API calls)
- `tui/src/lib/agent-chat.ts` — Agent chat with tool-calling loop
- `tui/src/harness.ts` — Test harness
- `skin.yaml` — Visual theme (colors, banner, spinner)
- `personality/ikbi.yaml` — ikbi personality

### Part 3: HTTP Chat Endpoint
Add a `/chat` POST endpoint to the Fastify server for persistent conversation sessions.

## Constraints
- **NO shared dependencies with the trio** — ikbi is standalone
- **NO frozen-core changes** — build in modules only
- **ikbi's own modules are the integration point** — use the existing module pattern
- **Tests must pass** — `pnpm test` after every change
- **TypeScript strict mode** — `pnpm build` must succeed
- **Do NOT modify existing tests** — only add new ones
- **Do NOT change the provider system** — it works
- **Do NOT change the trust system** — it works
- **Do NOT add new npm dependencies without checking existing ones first**

## ikbi's Identity
ikbi is a BUILD ENGINE, not a squirrel or an alien. It's the disciplined engineer:
- Methodical, evidence-based, precise
- Speaks in clear technical language
- Uses build metaphors (foundation, scaffolding, blueprint)
- Color theme: amber/gold (construction/engineering)
- ASCII art: geometric/architectural, not cute

## Existing Dependencies
```json
{
  "dependencies": { "fastify": "...", "pino": "..." },
  "devDependencies": { "@types/node": "...", "tsx": "...", "typescript": "..." }
}
```

For the TUI, you'll need to add: ink, react, ink-text-input, js-yaml, @types/react, @types/js-yaml, @types/ink

## How To Run
```bash
cd /pehverse/repos/ikbi
pnpm build                    # compile TypeScript
pnpm test                     # run all 717 tests
node dist/cli/index.js        # run CLI
node dist/cli/index.js doctor # pre-flight check
```

## CRITICAL CONSTRAINTS — READ LAST
- **Do NOT create a shared core package** — ikbi is standalone
- **Do NOT modify the provider system** — it works
- **Do NOT modify the trust system** — it works  
- **Do NOT change existing tests** — only add new ones
- **Do NOT add dependencies beyond what's listed above** without checking
- **STOP after completing the 3 parts above** — do not add extra features
- **If a test fails, fix it before moving on** — do not leave broken tests
