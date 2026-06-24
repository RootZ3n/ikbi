# ikbi RC-1 — Release-Candidate Status

This note summarizes what is stable, what is still experimental, the known limitations, and how to
report problems. It accompanies the RC-1 hardening pass (hook env scrubbing, stream-stall receipts,
content-filter warnings, `--min-score` validation, LSP cache cap, agent-directory cap, tokenizer
escapes, lazy fetch guard).

## Stable (use freely)

- **Build pipeline** — `ikbi build` (scout → builder → critic → verifier → integrator), promotes
  only on a ladder-verified pass, in an isolated worktree.
- **Interactive REPL** — `ikbi repl` (and bare `ikbi`): multi-turn tool-calling, slash commands,
  permission prompts, resume. Now warns on truncated/content-filtered/stalled model finishes.
- **Repair** — `ikbi fix <repo>`: narrow diagnose-and-repair with a verification-fed retry loop;
  never promotes.
- **Governance floors** — governed-exec (allowlist + gate-wall + receipts), workspace confinement,
  memory governor, earned trust tiers, network-egress SSRF guard (default-deny).
- **Hooks** — `.ikbi/hooks.json` PreToolUse / PostToolUse / Stop. Hook commands run with a
  **scrubbed environment** (no inherited API keys/tokens); opt in extra vars via `passEnv`
  (secret-like names refused) or literal `env` (see below).
- **Receipts** — append-only, attributed, MAC-protected; `ikbi receipts` / `cost` / `undo` / `diff`.

## Experimental (works, still maturing)

- **TUI** (`tui/`) and **Web UI** (`ui/`) — secondary surfaces; the REPL is the primary daily driver.
- **Custom agents** (`.ikbi/agents/*.yaml|json`), **MCP OAuth**, **LSP diagnostics rung**,
  **ikbi review**, **notebook_edit** — recently added; covered by tests, less battle-time.
- **Model ranking** (`ikbi models --rank --min-score`) — depends on a reachable Luak leaderboard.

## Known limitations

- **Egress DNS-rebinding TOCTOU** — the guard validates every resolved IP, then hands the URL to the
  transport, which re-resolves at connect time. Documented residual race (see `src/modules/egress/
  guard.ts`); full closure needs connection pinning the transport surface does not expose.
- **`--min-score` is 0–1** — Luak scores are normalized; `--min-score 70` is rejected (use `0.7`).
- **Hook env is minimal by default** — a hook needing a credential value must set it explicitly via
  the hook's literal `env` map (it is never sourced from ikbi's process environment).
- **Stalled streams are not auto-retried in chat** — a stall is surfaced + receipted and the partial
  call is never executed; re-send the request. (The build pipeline retries stalls bounded internally.)

## Passing env to a hook safely

```json
[
  {
    "type": "PostToolUse",
    "matcher": "write_file",
    "command": "notify-build.sh",
    "passEnv": ["MY_REGION", "CI"],          // forwarded from the process env (secret-like names refused)
    "env": { "WEBHOOK_URL": "https://..." }   // operator-authored literal values (the escape hatch)
  }
]
```

By default a hook sees only `PATH`/`HOME`/locale + the `IKBI_*` context vars. It never inherits
`*_KEY` / `*_TOKEN` / `*_SECRET` / `*_PASSWORD` / provider / OAuth / GitHub credentials.

## Reporting receipts / failures

- Reproduce, then capture the relevant receipts: `ikbi receipts --task <id>` (or `ikbi receipts`
  for recent), plus `ikbi cost` and `ikbi doctor` output.
- A stalled stream or flagged finish leaves a receipt — `worker.tool_call_stalled`,
  `chat.tool_call_stalled`, or `chat.finish_reason_flagged` — include it; its `metadata` carries the
  `finishReason`, model/provider, and (for stalls) redacted partial-arg byte counts (never values).
- File against the repo (`https://github.com/RootZ3n/ikbi`) with the receipts, the command, and the
  model roster in use (`ikbi models`).
