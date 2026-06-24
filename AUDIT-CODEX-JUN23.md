# ikbi → Claude Code Replacement — Codex Audit (2026-06-23)

**Auditor:** Codex (OpenAI)
**Scope:** Full comparison of ikbi vs Claude Code as a replacement
**Repo:** /pehverse/repos/ecosystem/ikbi
**Audit number:** 6th in the cycle

## Verdict: Conditional Yes

ikbi is a credible Claude Code replacement for terminal-first, local/lab coding-agent work where the priorities are model flexibility, governed execution, verification, receipts, worktree isolation, and cost control. It is not a full drop-in replacement for Claude Code's 2026 product surface: IDE, desktop, web/mobile handoff, background agents, scheduled runs, Agent SDK, broad MCP, plugins/skills, rich hooks, and mature subagent orchestration.

## Scorecard

| Area | Score |
|---|---:|
| CLI | 4 |
| Tools | 4 |
| Context | 3 |
| Model Flexibility | 5 |
| Session Management | 4 |
| Error Recovery | 4 |
| DX | 3 |
| Edge Cases | 3 |
| Production Readiness | 3 |

## What ikbi does better

- Model routing/cost: `src/cli/evaluate.ts` exposes the capability harness for side-by-side model scoring; `capability-harness.ts` evaluates `agent`, `patch`, `plan_patch`, and `repair`.
- Governance: frozen core trust, injection neutralization, receipts, governed exec, egress, kill-switch, workspaces, and verification ladder are stronger than Claude Code's normal session-permission model.
- Worktree safety: managed sessions and build/fix promote only after verification, rather than editing the user tree directly.
- Cheap-model amplification: `src/modules/lsp/index.ts` gives models structured compiler diagnostics; `notebook-tools.ts` gives cell-level notebook edits; `ask-user.ts` lets the model ask clarifying questions.
- Auditability: receipts, cost, summary, undo, and timeline are much closer to an operator audit trail than Claude Code transcripts.

## What Claude Code does better

- Multi-surface product: Anthropic documents terminal, VS Code, JetBrains, desktop, web, browser/mobile handoff, Slack/CI, visual diffs, and scheduled/cloud sessions. ikbi is still primarily REPL/server.
- Permissions: ikbi has `/permissions auto|confirm|readonly` and `/plan`; Claude Code documents richer modes including `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, and `bypassPermissions`.
- Hooks: ikbi has `PreToolUse`, `PostToolUse`, and `Stop`. Claude Code's hook lifecycle is far broader: session, prompt, permission, notification, subagent, task, file/worktree, compaction, and elicitation events.
- Subagents: ikbi has `delegate_task` and `.ikbi/agents/`; Claude Code has independent-context subagents, background agents, agent teams, nested subagents, and agent view.
- MCP/SDK: ikbi has MCP CLI/OAuth pieces; Claude Code has a much broader MCP reference and a Python/TypeScript Agent SDK.

## Verified fixes

- `ikbi evaluate` exists and is registered: `src/cli/evaluate.ts`
- Hooks now have 17 tests: `src/modules/hooks/hooks.test.ts`
- Job-cards store is hardened: `assertSafeId`, atomic temp+rename writes, and run-id validation in `src/modules/job-cards/store.ts`
- Default `maxFilesChanged` is now 50, not unlimited: `src/modules/job-cards/index.ts`
- Help pages now cover the high-value commands, including `evaluate`, `review`, `agents`, `mcp`, `audit`, `cost`, `diff`, `undo`, and `trust`: `src/cli/help-pages.ts`

## Remaining gaps

- Full Claude Code ecosystem parity: IDE extension, desktop/web session manager, background agents, scheduling, remote/mobile handoff, team/chat integrations.
- Hook lifecycle parity: add more events and JSON decision output, not just exit-code semantics.
- Real subagent parallelism and independent contexts.
- MCP transport/registry depth: HTTP/SSE/WebSocket, dynamic tools, resources/prompts, tool search, managed config.
- HTTP production posture: `/api/receipts` and `/api/timeline` register without the shared auth hook even though `apiAuth` exists.
- Notebook writes should be atomic; `writeNotebook` currently uses direct `writeFileSync`.
- Route input validation remains uneven on HTTP modules.

## Test result

`node --import tsx --test src/modules/hooks/hooks.test.ts` failed in Codex's sandbox because `/tmp` is read-only: `EROFS` on `mkdtempSync('/tmp/ikbi-hooks-*')`. A direct import run showed 12/17 hook tests passed; the 5 failures were all temp-dir creation failures, not hook assertion failures.

## Bottom line

ikbi can honestly claim: "A governed, local-first, model-flexible Claude Code alternative for terminal-first coding work, with stronger verification and cost control than Claude Code." It should not claim full Claude Code replacement across Anthropic's current IDE/desktop/web/SDK/background-agent ecosystem.

Claude Code sources checked: overview, permission-modes, hooks, sub-agents, MCP, Agent SDK.
