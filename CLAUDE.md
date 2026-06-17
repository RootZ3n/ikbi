# ikbi — Build/Repair Engine

## What This Is
ikbi (Choctaw: "to build") is a governed AI coding agent designed to be a Claude Code
replacement that works with cheap/local models. The architecture gives cheap models every
advantage: evidence-based verification, governed execution, earned trust, and an optional
competitive mode. It runs both as a long-running localhost/Tailscale service and as a CLI.

## Architecture
- **TypeScript, Node.js 22+**, ESM. `pnpm` workspace.
- **Frozen core** (`src/core/`): provider (model invocation), injection (neutralization
  chokepoint), trust (earned tiers, MAC-protected), identity, workspace (git worktrees),
  events, receipt, substrate (atomic writes + locking), config, contracts.
- **Engine modules** (`src/modules/`): worker-model (scout/builder/critic/verifier/integrator),
  chat (the `ikbi repl` + `/chat` session loop), agent-router, batch-planner, step-planner,
  cognition-layer, mcp-model-loop, gate-wall, governed-exec, egress, escalation, cache,
  self-observation, capability-* , drift-prevention, lab-context-memory, kill-switch,
  dependency-install, deterministic-judge, verification-ladder, project-index/retrieval,
  context-packets, model-evaluation, check-triage.
- **CLI** (`src/cli/`): `node dist/cli/index.js <command>`. Built with `pnpm build`.
- **Server** (`src/server/`): Fastify on port 18796 (`/health` `/ready` `/agent`
  `/capabilities` `/chat`).
- **TUI** (`tui/`): a standalone Ink/React client package (talks to `/chat`; not the primary
  surface — `ikbi repl` is the rich interactive daily-driver).
- **Web UI** (`ui/`): a static SPA served at `/`.

## Surfaces (what to use)
- `ikbi build "<goal>" --repo <path>` — the golden batch path: 5-role pipeline in an
  isolated worktree, promotes only on ladder-verified pass.
- `ikbi repl` — interactive, multi-turn, tool-calling session (managed worktree, slash
  commands, resume, permission prompts). The closest analog to Claude Code's REPL.
- `ikbi fix <repo>` — diagnose a failing check and repair it narrowly (or correctly
  refuse); never promotes. Includes a fix-retry loop with verification feedback and
  dual-model escalation.
- `ikbi doctor` / `capabilities` / `models` / `providers` / `receipts` / `cost` / `diff` /
  `undo` / `workspace*` / `clean` / `audit` — operator + inspection commands.

## Tooling (builder & chat each expose 22 tools)
read_file, write_file, list_dir, patch, multi_edit, terminal, search_files, glob, git tools,
web_search/extract, vision_analyze, delegate_task, brain tools, scout_detail, run_checks, done.
The builder gates `done` on a green `run_checks`. Every tool RESULT re-enters the model only through
the neutralization chokepoint; all file/search/exec tools are worktree-confined; terminal routes
through governed-exec (allowlist + gate-wall + receipts).

## How To Run
```bash
cd /pehverse/repos/ikbi
pnpm install
pnpm build                     # tsc -> dist/  (also typechecks *.test.ts)
pnpm test                      # node:test runner — 2199 tests, all passing
node dist/cli/index.js doctor  # pre-flight check
node dist/cli/index.js repl    # interactive session
```
Tests use `node:test` (NOT vitest). `pnpm build` typechecks test files too, so a type error
in a `*.test.ts` fails the build.

## Constraints — READ THESE
- **No shared dependencies / no shared core package** — ikbi is standalone.
- **Frozen core is sensitive** — change `src/core/` only with care and tests; prefer modules.
- **Tests must pass** — run `pnpm test` after changes; `pnpm build` must succeed (strict mode).
- **Do NOT modify existing tests to make them pass** — fix the code, or add new tests. Only
  change a test when the contract it pins genuinely, intentionally changed.
- **Check existing deps before adding new ones.** Runtime deps: fastify, @fastify/static, pino.
- **Fail-closed is the design** — never make a dangerous thing the default. Trust/capability is
  granted, not assumed.
