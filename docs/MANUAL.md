# ikbi User Manual

> ikbi (Choctaw: *"to build"*) is a governed AI coding agent built to be a Claude Code
> replacement that gets real work out of cheap/local models. It gives weak models every
> advantage: evidence-based verification, governed execution, earned trust, and an optional
> competitive mode. It runs as a long-running localhost/Tailscale service **and** as a CLI.
>
> Version: `0.1.0` · Receipt contract: `1.0.0` · Trust contract: `1.0.0`

This is the single source of truth for using ikbi. It covers every command, every
configuration variable, every user-facing error, and the architecture that makes the
guarantees real.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Commands](#commands)
   - [ikbi build](#ikbi-build) · [ikbi fix](#ikbi-fix) · [ikbi repl](#ikbi-repl)
   - [ikbi audit](#ikbi-audit) · [ikbi doctor](#ikbi-doctor) · [ikbi trust](#ikbi-trust)
   - [ikbi memory](#ikbi-memory) · [ikbi workspace](#ikbi-workspace) · [ikbi receipts](#ikbi-receipts)
   - [ikbi diff](#ikbi-diff) · [ikbi undo](#ikbi-undo) · [ikbi clean](#ikbi-clean)
   - [ikbi batch](#ikbi-batch) · [ikbi cost / summary](#ikbi-cost--ikbi-summary) · [ikbi kill](#ikbi-kill--unkill--kill-status)
   - [Inspection commands](#inspection-commands-doctor-capabilities-models-providers-repos)
3. [Configuration](#configuration)
4. [Architecture Overview](#architecture-overview)
5. [Troubleshooting](#troubleshooting)
6. [Receipts Reference](#receipts-reference)

---

## Quick Start

### Installation

```bash
cd /path/to/ikbi
pnpm install
pnpm build                      # tsc -> dist/ (also typechecks *.test.ts)
node dist/cli/index.js doctor   # pre-flight check
```

Optionally install a global launcher so `ikbi` works from anywhere:

```bash
node dist/cli/index.js setup    # installs ~/.local/bin/ikbi, prints any PATH steps
```

The rest of this manual writes commands as `ikbi <command>`. Without the launcher, use
`node dist/cli/index.js <command>`.

**Minimum configuration for a build.** ikbi is fail-closed: it does nothing dangerous by
default. Before your first build you need four secrets and one switch. Put these in
`~/.ikbi/env` (user-global) — **not** in a project `.env`; ikbi refuses to read trust
credentials from a target repo's directory so a repo can never carry them.

```bash
# ~/.ikbi/env
IKBI_OPERATOR_TOKEN=<32+ url-safe chars>     # operator identity
IKBI_WORKER_TOKEN=<32+ url-safe chars>       # worker identity (without it, builds fail closed)
IKBI_TRUST_HMAC_KEY=<strong random>          # MAC key for trust state
IKBI_IDENTITY_TOKEN_SALT=<strong random>     # token-hash pepper
IKBI_WORKER_MODEL_ENABLED=true               # master switch — builds are off until this is on
IKBI_MIMO_API_KEY=<your key>                 # at least one provider key (see Configuration)
```

For local development only, you may set `IKBI_ALLOW_INSECURE_DEV_KEYS=true` to start with
default keys (the process otherwise refuses to start when the HMAC key or token salt is
missing). **Never do this in production.** Confirm everything is wired with `ikbi doctor`.

### First build

```bash
ikbi build "fix the failing test" --repo /path/to/repo --verbose
```

A 5-role pipeline (scout → builder → critic → verifier → integrator) runs in an isolated
git worktree. Changes promote to your branch **only** if the verification ladder passes.
Add `--cost` for a per-role cost breakdown.

### First fix

```bash
ikbi fix /path/to/repo --check "pnpm test"
```

Fix mode is diagnosis-first and **never promotes**. It reproduces the failing check,
classifies the root cause, makes the smallest possible patch, re-runs the check, and runs
an anti-cheat pass — then prints a receipt telling you exactly what it did (or why it
correctly refused).

### First REPL session

```bash
ikbi repl
```

An interactive, multi-turn, tool-calling session in a managed worktree. Type a goal, watch
streamed output and tool activity, then `/diff` to review and `/apply` to verify-and-promote.
`/help` lists every slash command. `Ctrl-C` interrupts; `ikbi repl --continue` resumes.

---

## Commands

The CLI uses a command-registry pattern: built-in commands (`version`, `models`,
`providers`, `doctor`, `capabilities`, `help`) take precedence; everything else is
registered by modules at import time. Anything that isn't a recognized command is treated
as a **goal** and routed to the cognition layer, which decides the right path (build / batch
/ chat) and auto-dispatches it (unless `--no-run`).

---

### ikbi build

Run the governed 5-role build pipeline toward a goal, in an isolated worktree. Promotes
only on a ladder-verified pass.

**Usage**

```
ikbi build <goal...> [--repo <path>] [--verbose] [--cost] [--yes]
                     [--json] [--no-memory] [--memory-diff]
```

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `<goal...>` | — | The objective, as prose (required) |
| `--repo <path>` | cwd | Target repository |
| `--verbose`, `-v` | off | Stream per-role progress, tool activity, verification events |
| `--cost` | off | Print a per-role cost breakdown after the build |
| `--yes`, `-y` | off | Skip the interactive Socratic-interview prompt; proceed with the goal as written |
| `--json` | off | Emit only machine-readable JSON to stdout (diagnostics → stderr) |
| `--no-memory` | off | Skip loading project memory (CLAUDE.md, `.ikbi/`, AGENTS.md) |
| `--memory-diff` | off | Show which project memory *would* be used, then exit (dry-run) |

**What happens (the 5 roles)**

1. **scout** — read-only; produces a plan and the relevant file set (via the project index/retrieval).
2. **builder** — makes edits inside the worktree (22 tools; `done` is gated on a green `run_checks`).
3. **critic** — reviews the change for quality/correctness.
4. **verifier** — runs typecheck/tests through the verification ladder (impact-scoped → full).
5. **integrator** — promotes to your branch **only** if everything is green and promotable.

**Workspace lifecycle.** Each build allocates a worktree off your repo on a scratch branch.
On a green, promotable result the integrator merges to your base branch. A green-but-not-
promotable build is discarded. A **failed** build's worktree is *retained* (the only copy
of its uncommitted work) so you can inspect it — see [`ikbi workspace`](#ikbi-workspace).

**Promote / undo.** Promotion is governed (see [Architecture](#architecture-overview)); a
trusted worker auto-commits on a verification pass, lower tiers are gated. Revert any
promotion with [`ikbi undo`](#ikbi-undo).

**Outcome states:** `success`, `partial`, `rejected`, `failed`.

**Example**

```bash
ikbi build "add a --json flag to the export command" --repo ./app --verbose --cost
```

**Expected output (abridged JSON summary)**

```json
{
  "taskId": "build-1718000000000",
  "outcome": "success",
  "promoted": true,
  "roles": ["scout", "builder", "critic", "verifier", "integrator"],
  "cost_usd": 0.0123,
  "verification": "ladder",
  "retrieval": "index"
}
```

> **Gate verified builds behind a human prompt:** set `IKBI_REQUIRE_APPROVAL=true`.

---

### ikbi fix

Diagnose a failing check and repair it narrowly — or *correctly refuse*. Fix mode **never
promotes**; it leaves a patch and a receipt for you to review.

**Usage**

```
ikbi fix <repo> [--check "<cmd>"] [--allow-test-edits] [--allow-config-edits]
                [--diagnose-only] [--max-files N] [--json]
```

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `<repo>` | cwd | Target repo (first non-flag token) |
| `--check "<cmd>"` | auto-detected | The failing check to reproduce (whitespace-tokenized). Auto-detect: Node→`pnpm`/`npm`/`yarn test`, Rust→`cargo test`, Go→`go test`, Python→`pytest`, Godot→`godot --headless` |
| `--allow-test-edits` | off | Permit editing test files (tests are ground truth by default) |
| `--allow-config-edits` | off | Permit editing test-discovery/config files |
| `--diagnose-only` | off | Stages 1–4 only (classify, no edits) |
| `--max-files N` | 5 | Cap on files the fix may modify |
| `--json` | off | Emit the `FixReceipt` as JSON |

**Diagnosis-first pipeline.** Fix runs a 12-stage pipeline: reproduce the failure → triage
the output → classify the root cause → plan → patch (smallest change) → re-run the targeted
check → re-run the full check (count regressions) → **anti-cheat** → emit receipt. If
stages 1–4 conclude the right move is *not to touch code*, it stops there with a
`CORRECT_REFUSAL`.

**Anti-cheat system.** Before any fix is reported as real, an anti-cheat pass proves the fix
didn't game the check. It rejects: weakening tests (fewer assertions/specificity/tests),
removing validators, claiming success while checks still error, touching files outside the
diagnosis scope, bypassing test-discovery/coverage/CI config, and wrapping failures in
`try/except: pass`. Any violation forces `UNSAFE_FAIL` (halt, nothing kept).

**Dual-model escalation.** When the fix-retry loop is enabled, a cheap model (e.g.
`deepseek-v4-flash`) takes the first attempts; if it keeps failing, the loop escalates to a
stronger model (e.g. `deepseek-v4-pro`) before giving up. The receipt's `attempts` field
reports how many re-prompts ran. (See `IKBI_ESCALATION_*` in [Configuration](#configuration).)

**`--check` flag.** Override auto-detection to pin the exact failing command, e.g.
`--check "pytest tests/test_api.py::test_auth"`. The command runs through governed-exec, so
its binary must be on the allowlist (see Troubleshooting).

**Results** (a refusal is a **success**, not a failure):

| Result | Meaning |
|--------|---------|
| `FIXED_NARROWLY` | Diagnosis correct, minimal patch applied, checks pass, anti-cheat clean |
| `CORRECT_REFUSAL` | The right answer was "I should not edit code here" — refused (success) |
| `SAFE_FAIL` | Tried, could not fix, but did not cheat (no changes kept) |
| `UNSAFE_FAIL` | **Anti-cheat violation** — the fix tried to cheat; halted, nothing kept |
| `NEEDS_HUMAN` | Diagnosis or risk requires human judgment |
| `TOOL_LIMITATION` | The verifier could not run/parse the tests — not a project failure |
| `ENVIRONMENT_MISSING` | A required tool/verifier is not installed |
| `UNRESOLVED` | Could not determine the root cause |

**Example**

```bash
ikbi fix ./service --check "pnpm test" --max-files 3
```

**Expected output (operator-readable receipt)**

```
fix FIXED_NARROWLY — diagnosis correct, minimal patch applied, checks pass, anti-cheat clean

  repo:        /path/to/service
  check:       pnpm test
  head:        a1b2c3d
  reproduced:  exit 1 — 1 failing test
  diagnosis:   implementation_bug (confidence 0.92)
               off-by-one in pagination offset
  affected:    src/paginate.ts
  patched:     src/paginate.ts
  targeted:    PASS
  full check:  PASS (0 regression(s))
  anti-cheat:  PASS
     ✓ no_test_weakening: assert count unchanged
     ✓ no_forbidden_files: only diagnosed file touched
  promoted:    no (fix mode never promotes without approval)
```

---

### ikbi repl

Interactive, multi-turn, tool-calling session — the closest analog to Claude Code's REPL.
Runs in a managed worktree by default; `/apply` verifies (ladder) then promotes.

**Usage**

```
ikbi repl [--continue | --resume <id>] [--scratch] [--force] [--max-sessions <n>]
```

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `--continue`, `-c` | — | Resume the most-recent persisted session |
| `--resume <id>` | — | Resume a specific session by id |
| `--scratch` | off | Scratch session — non-promotable, live-direct edits; copy work out manually |
| `--force` | off | Break a stale/foreign session lock on save |
| `--max-sessions <n>` | `IKBI_MAX_SESSIONS` | Override the session-prune cap |

**Lifecycle modes**

- **managed-workspace** (default) — isolated worktree; `/apply` runs the ladder, then promotes on pass.
- **scratch** (`--scratch`) — non-promotable; you copy changes out by hand.
- **explicit** (`IKBI_CHAT_WORKDIR` set) — live-direct edits to a pinned directory.
- **repo** — live-direct edits to the repo itself.

**Slash commands** (inside the REPL)

| Command | Action |
|---------|--------|
| `/help` | List all commands |
| `/plan` | Switch to read-only PLAN mode (analyze, change nothing) |
| `/agent` | Switch to AGENT mode (full tool suite; changes applied) |
| `/status` | Session info (id, repo, workspace, base ref, pending changes, lifecycle) |
| `/diff` | Show pending changes (managed: workspace vs base; else `git diff`) |
| `/apply [msg]` · `/promote` | Verify (ladder) then apply changes to the target repo (managed only) |
| `/discard` | Managed: remove the workspace. Else: roll back tracked edits |
| `/model [name]` | Show the current model, or switch models |
| `/cost` | Token usage + estimated USD |
| `/memory [add <text>\|edit\|clear]` | Show/edit persistent standing instructions |
| `/permissions [auto\|confirm\|readonly]` | Show or set the tool permission mode |
| `/rollback [N]` | Undo the last N file changes (default 1) |
| `/compact` | Compress the conversation to relieve context pressure |
| `/sessions` · `/label <name>` · `/delete <id>` | Manage persisted sessions |
| `/reset` | Start a fresh session (confirms first) |
| `/exit`, `/quit` | Leave the REPL |

**Session resume.** Sessions persist (default under `~/.ikbi/sessions/`). `ikbi repl
--continue` resumes the latest; `--resume <id>` targets one; `/sessions` lists them (`*`
marks current). Use `/label` to name a session and `/delete` to remove one.

**Permission prompts.** Tool permission mode is one of `auto` (run tools without asking),
`confirm` (prompt before each mutating tool), or `readonly` (no mutations). Set it with
`/permissions <mode>`. In `confirm` mode you approve each write/exec as it's proposed.

**Ctrl-C interrupt.** A single `Ctrl-C` interrupts the current turn (and, mid-build, marks
live workspaces as retained so work survives). A second `Ctrl-C` force-exits (code 130).

**Example**

```bash
ikbi repl --continue
> /plan
> how is auth wired in this service?
> /agent
> add rate-limiting to the login route
> /diff
> /apply "feat: rate-limit login"
```

---

### ikbi audit

Read-only diagnostic snapshot of a repo — its type, active workspaces, and receipt history.
Optionally runs the scout across multiple models and compares them. Changes nothing.

**Usage**

```
ikbi audit <repo> [--compare m1,m2] [--structured]
```

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `<repo>` | — | Path to the repo (required) |
| `--compare m1,m2` | — | Run the scout with multiple models; report agreements, disagreements, coverage |
| `--structured` | off | Emit the multi-model comparison as JSON |

**What it inspects**

- **Repo identity** — type (Node.js / Rust / Go / Python / Godot / unknown), package
  manager, detected test command, TypeScript presence, lockfile.
- **Workspace status** — active workspaces for this repo.
- **Receipt history** — total receipts, last build, last verification result.
- **Multi-model comparison** (with `--compare`) — where models agree/disagree on the plan.

**Example**

```bash
ikbi audit ./app
ikbi audit ./app --compare mimo-v2.5,deepseek-v4-pro --structured
```

---

### ikbi doctor

Report bootstrap config — what's set, what's missing for a build — and optionally repair
common gaps.

**Usage**

```
ikbi doctor [--fix] [--force]
```

**Flags**

| Flag | Default | Meaning |
|------|---------|---------|
| `--fix` | off | Repair common gaps (create/repair only — no deletions) |
| `--force`, `-f` | off | With `--fix`, enable **destructive** repairs: reclaim stale workspaces **and** age-bounded reclaim of terminal workspaces past the retention window |

**What it checks** (grouped report)

- **REQUIRED FOR A BUILD** — operator token, worker token, `IKBI_WORKER_MODEL_ENABLED`, governed-exec allowlist, provider resolution.
- **SECURITY** — trust HMAC key, token salt (states: SET / WARNED / BLOCKED).
- **SAFETY POSTURE** — verification mode (ladder vs legacy), retrieval mode (index vs legacy 40-file scan).
- **PRODUCT SURFACES** — lifecycle classification (core / experimental / dormant).
- **EGRESS** — allowlist configuration.
- **MODEL CONFIG** — role models (driver, builder, critic, competitive).
- **STATE** — state root, trust dir, roster file, workspace root.

**Examples**

```bash
ikbi doctor                 # read-only status
ikbi doctor --fix           # repair gaps, no deletions
ikbi doctor --fix --force   # also reclaim stale + aged workspaces
```

---

### ikbi trust

Operator trust grant / promote / status — the cold-start on-ramp. A fresh worker resolves
to the `untrusted` floor (fail-closed); granting trust is the operator-authorized, durable,
MAC-protected override.

**Usage**

```
ikbi trust grant <agentId> <tier>
ikbi trust promote [<agentId>] [--yes]
ikbi trust status <agentId>
```

**Subcommands & flags**

| Form | Meaning |
|------|---------|
| `trust grant <agentId> <tier>` | Grant a durable tier (operator-gated, logged) |
| `trust promote [<agentId>] [--yes]` | Shortcut: grant the worker the agent ceiling (`trusted`) with operator confirmation. `--yes`/`-y` skips the prompt (non-interactive/CI only) |
| `trust status <agentId>` | Read-only tier lookup |

**Trust tiers** (lower rank = more trust; `untrusted` is the floor, `operator` the apex):

| Tier | Rank | Posture |
|------|------|---------|
| `operator` | 0 | Apex; the human operator. Not grantable to agents |
| `trusted` | 1 | Agent ceiling; full autonomy — auto-commit on verification pass |
| `verified` | 2 | Requires human approval at promote |
| `probation` | 3 | Requires approval + risk gate |
| `untrusted` | 4 | Floor; cold-start, fail-closed |

Trust is *earned*: a streak of promotable successes (default 20, spanning ≥2 distinct
operations) promotes one tier; failures or an injection attempt demote immediately. An
injection flag is non-recoverable until an operator reset. See [Architecture](#architecture-overview).

**Examples**

```bash
ikbi trust status worker
ikbi trust grant worker trusted
ikbi trust promote --yes        # auto-grant the configured worker to "trusted"
```

**Expected output**

```
trust granted: worker → trusted (durable, MAC-protected)
worker: tier=trusted (default=untrusted, injectionFlagged=false)
```

---

### ikbi memory

Review and manage memory-governance proposals. Writes to governed surfaces (CLAUDE.md,
`.ikbi/` files, brain pages) don't take effect directly — they become operator-reviewed
proposals you approve or reject here.

**Usage**

```
ikbi memory [proposals [--all] | approve <id> | reject <id> | reject-all | stats]
```

**Subcommands**

| Form | Action |
|------|--------|
| `memory` · `memory proposals` | List pending proposals (default) |
| `memory proposals --all` | List all proposals (pending + approved + rejected) |
| `memory approve <id>` | Approve a proposal (applies it to the target surface) |
| `memory reject <id>` | Reject (discard) a proposal |
| `memory reject-all` | Reject all pending proposals |
| `memory stats` | Counts by status (pending / approved / rejected / total) |

**Governed paths.** Three surface kinds are governed: `instruction_file` (top-level files
like CLAUDE.md), `project_file` (files under `.ikbi/`), and `brain_page` (brain slugs, via
the gbrain bridge). The checks are pure and deterministic — no model call decides what's
governed.

**Examples**

```bash
ikbi memory                       # pending proposals
ikbi memory approve prop-abc-123
ikbi memory stats
```

---

### ikbi workspace

List, discard, or bulk-clean build workspaces. (`ikbi workspaces` — plural — is a sibling
with `list` / `inspect <id>` / `clean` and `--apply`/`--force`.)

**Usage**

```
ikbi workspace ls
ikbi workspace discard <id>
ikbi workspace clean [--dry-run] [--retained] [--stale=N] [--force]
```

**Subcommands & flags**

| Form | Action |
|------|--------|
| `workspace ls` (`list`) | List workspaces (id, state, path); flags `[RETAINED]` work |
| `workspace discard <id>` (`rm`) | Remove ONE workspace (worktree dir + scratch branch) |
| `workspace clean` | Bulk-remove terminal workspaces — **dry-run by default** |

`clean` flags: `--dry-run`/`-n` (preview, default), `--retained` (only retained/failed),
`--stale=<days>` (older than N days), `--force`/`-f` (include retained work in the sweep).

**Workspace lifecycle.** States you'll see: `allocating` → `allocated` (in progress) →
`promoting` → `promoted` (live on your branch) **or** `discarded` (not promoted) **or**
`failed` (retained for inspection — holds the only copy of uncommitted work).

> **Retained-work safety.** A failed build's worktree is the only copy of its uncommitted
> work. `clean` and `ikbi clean` **preserve** it by default and report the count; `--force`
> opts into sweeping it.

**Examples**

```bash
ikbi workspace ls
ikbi diff <id>                  # inspect before discarding
ikbi workspace discard abc-123
ikbi workspace clean --stale=7  # preview removing workspaces older than 7 days
ikbi workspace clean --force    # also remove retained failed work
```

---

### ikbi receipts

Show the receipt history — a read-only, append-only operational log of every governed
operation.

**Usage**

```
ikbi receipts [verify] [--task <id>] [--latest] [--failures] [--limit <n>]
```

**Flags**

| Flag | Meaning |
|------|---------|
| (none) | Recent receipts, most-recent last |
| `verify` | Check integrity — seq numbers sequential, no gaps |
| `--task <id>` | Full trail of one run (all roles, verification, promote) |
| `--latest` | Only the single most-recent receipt |
| `--failures` | Filter to failed receipts |
| `--limit <n>` | Cap to N most-recent |

**Receipt format & contract version.** Every receipt is `contractVersion: "1.0.0"` and
carries `id`, `seq`, `timestamp`, `identity`, `operation`, `outcome`, `changes`, and
optional `metadata` / `requestId` / `project`. See [Receipts Reference](#receipts-reference)
for full field docs.

**Examples**

```bash
ikbi receipts --limit 5
ikbi receipts --task build-1718000000000
ikbi receipts --failures --limit 10
ikbi receipts verify
```

---

### ikbi diff

Print a workspace's git diff (base..scratch) plus a change summary.

**Usage**

```
ikbi diff <workspace-id>
```

No flags (`--help`/`-h` shows usage). Find workspace ids with `ikbi workspace ls`.

**Output:** a unified diff, a summary line (`Δ N files changed, +I/-D`), per-file line
counts, and the workspace state.

**Example**

```bash
ikbi workspace ls
ikbi diff abc-123-def
```

---

### ikbi undo

Revert a promoted change. Shows a preview + diff before reverting (SG-3).

**Usage**

```
ikbi undo <receipt-id | commit | --latest>
```

| Argument | Meaning |
|----------|---------|
| `<receipt-id>` | Receipt id of a promote operation |
| `<commit>` | Promoted commit SHA |
| `--latest` | Revert the most-recent revertible promotion |

**Safety:** refuses if the branch moved on since promotion, or if the checked-out tree is
dirty. Undo can resolve a revertible promote from either a receipt **or** the durable
workspace registry (recovers the `PROMOTED_BUT_RECEIPT_FAILED` case).

**Example**

```bash
ikbi undo --latest
ikbi undo build-1718000000000
```

---

### ikbi clean

Reclaim orphaned worktrees from terminal workspaces. Retained failed-build work is preserved
unless `--force`.

**Usage**

```
ikbi clean [--force]
```

`--force`/`-f` sweeps retained work too. Output: a summary of reclaimed worktrees, space
freed, and the count of preserved retained workspaces.

---

### ikbi batch

Decompose a large goal into dependency-ordered subtasks and build each through the same
governed worker pipeline as `ikbi build`.

**Usage**

```
ikbi batch <goal...> [--repo <path>]
```

Outcome states: `completed` (all passed), `partial`, `rejected`, `stopped`, `failed`.
Caps at `IKBI_BATCH_PLANNER_MAX_SUBTASKS` (default 12).

**Example**

```bash
ikbi batch "add a config loader, a CLI command for it, and tests" --repo ./app
```

---

### ikbi cost / ikbi summary

Cost reporting and a compact build overview, both built from receipts.

```
ikbi cost [--days <n>] [--task <id>]     # per-task / per-model cost; default last 7 days
ikbi summary [--days <n>]                # builds, success rate, total cost; default last 24h
```

`ikbi cost --task <id>` gives a per-model breakdown and total for one task.

---

### ikbi kill / unkill / kill-status

Operator kill-switch. Durable across restarts; honored at startup. Both `kill` and `unkill`
require a valid `IKBI_OPERATOR_TOKEN`.

```
ikbi kill [--hard] [--agent <id> | --run <id>] [--note <text>]
ikbi unkill
ikbi kill-status
```

`--hard` is immediate (soft is graceful); `--agent`/`--run` scope to one target (default: all);
`--note` logs a reason.

```bash
ikbi kill --hard --agent worker --note "runaway build"
ikbi unkill
ikbi kill-status
```

---

### Inspection commands (doctor, capabilities, models, providers, repos)

| Command | Output |
|---------|--------|
| `ikbi version` | The ikbi version string |
| `ikbi models` | The model roster (id, role, cost, provider chain) |
| `ikbi providers` | Registered provider ids, one per line |
| `ikbi capabilities` | Builder + chat tool inventory (and parity); product-surface lifecycle |
| `ikbi repos` | Registered Pehverse repos (from `state/repos.json`) |
| `ikbi help`, `--help`, `-h` | Usage + all registered commands |

---

## Configuration

Config is loaded **once** at startup through `loadConfig()` (`src/core/config.ts`) into a
frozen singleton; modules read their own `IKBI_<MODULE>_*` slice, never `process.env`
directly.

### .env file locations

- `~/.ikbi/env` (user-global) — **put your secrets here.**
- The ikbi install-root `.env` (system-wide).
- `<repo>/.env` — read for non-secret values, but ikbi **refuses** to load the four secret
  keys (`IKBI_OPERATOR_TOKEN`, `IKBI_WORKER_TOKEN`, `IKBI_TRUST_HMAC_KEY`,
  `IKBI_IDENTITY_TOKEN_SALT`) from a project directory, so a target repo can never carry
  trust credentials.
- `.env.example` is a fully-commented template.

### Security & identity (production-critical)

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_OPERATOR_TOKEN` | *(unset)* | Operator identity token (32+ chars; hashed at load, never stored raw) |
| `IKBI_OPERATOR_AGENT_ID` | `operator` | Agent id for the bootstrapped operator |
| `IKBI_WORKER_TOKEN` | *(unset)* | Worker identity token. **Unset → builds fail closed** |
| `IKBI_WORKER_AGENT_ID` | `worker` | Agent id for the bootstrapped worker |
| `IKBI_WORKER_TRUST_TIER` | `trusted` | Worker's default tier floor (orchestrator clamps to ceiling) |
| `IKBI_TRUST_HMAC_KEY` | *(unset\*)* | HMAC key protecting trust-state integrity |
| `IKBI_IDENTITY_TOKEN_SALT` | *(unset\*)* | Global pepper for the token-hash KDF |
| `IKBI_ALLOW_INSECURE_DEV_KEYS` | `false` | When false (prod), the process **refuses to start** if the HMAC key or token salt is missing. Dev-only opt-in |
| `IKBI_IDENTITY_REGISTRY` | `<stateRoot>/agents.json` | Agent registry (who may claim which role) |

\* Required unless `IKBI_ALLOW_INSECURE_DEV_KEYS=true`.

### Server & runtime

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_PORT` | `18796` | TCP port |
| `IKBI_BIND_HOST` | `127.0.0.1` | Bind interface (loopback) |
| `IKBI_ALLOW_PUBLIC_BIND` | `false` | Required to bind a non-loopback interface |
| `IKBI_ENV` | `development` | Runtime tag (falls back to `NODE_ENV`) |
| `IKBI_LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `IKBI_STATE_ROOT` | `~/.ikbi/state` | Root for all runtime state |

### Provider configuration

Providers are configured per-provider with an API-key var and an overridable base URL. At
least one key is needed for live model calls. The roster (models + cost table + routing)
lives in `IKBI_PROVIDER_CONFIG` (default `<stateRoot>/providers.json`).

| Provider | API key var | Default base URL (override: `IKBI_<P>_BASE_URL`) |
|----------|-------------|---------------------------------|
| MiMo | `IKBI_MIMO_API_KEY` | `https://api.xiaomimimo.com/v1` |
| OpenRouter | `IKBI_OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` (also `IKBI_OPENROUTER_REFERER`, `IKBI_OPENROUTER_TITLE`) |
| DeepSeek | `IKBI_DEEPSEEK_API_KEY` | `https://api.deepseek.com/v1` |
| MiniMax | `IKBI_MINIMAX_API_KEY` | `https://api.minimax.chat/v1` |
| OpenAI | `IKBI_OPENAI_API_KEY` | `https://api.openai.com/v1` |
| Anthropic | `IKBI_ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1` |
| Ollama (local) | *(keyless)* | `http://127.0.0.1:11434/v1` |
| Google/Gemini | `IKBI_GOOGLE_API_KEY` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Groq | `IKBI_GROQ_API_KEY` | `https://api.groq.com/openai/v1` |
| Mistral | `IKBI_MISTRAL_API_KEY` | `https://api.mistral.ai/v1` |
| Together | `IKBI_TOGETHER_API_KEY` | `https://api.together.xyz/v1` |

**Provider resilience:** `IKBI_PROVIDER_TIMEOUT_MS` (60000), `IKBI_CIRCUIT_FAILURE_THRESHOLD`
(5), `IKBI_CIRCUIT_COOLDOWN_MS` (30000), `IKBI_CIRCUIT_HALF_OPEN_TRIALS` (1),
`IKBI_PROVIDER_MAX_RETRIES` (2), `IKBI_PROVIDER_RETRY_BASE_MS` (300),
`IKBI_PROVIDER_RETRY_MAX_MS` (5000).

### Model configuration (roles, dual-model, escalation)

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_MODEL_DRIVER` | `mimo-v2.5` | Scout/driver role model |
| `IKBI_MODEL_BUILDER` | (falls back to driver) | Builder role model |
| `IKBI_MODEL_CRITIC` | `deepseek-v4-pro` | Critic role model |
| `IKBI_COMPETITIVE_MODELS` | *(unset)* | Comma-separated candidates for competitive mode |

**Escalation (cheap → strong).** When enabled, attempts start on a cheap "worker" tier and
escalate by score:

| Variable | Default |
|----------|---------|
| `IKBI_ESCALATION_ENABLED` | `true` |
| `IKBI_ESCALATION_WORKER_MODELS` | `deepseek-v4-flash,mimo-v2.5,minimax-m3` |
| `IKBI_ESCALATION_MID_MODELS` | `deepseek-v4-pro,mimo-v2.5-pro` |
| `IKBI_ESCALATION_FRONTIER_MODELS` | `gpt-5.5,opus-4.8` |
| `IKBI_ESCALATION_WORKER_TO_MID_THRESHOLD` | `50` |
| `IKBI_ESCALATION_MID_TO_FRONTIER_THRESHOLD` | `70` |
| `IKBI_ESCALATION_MAX_ESCALATIONS` | `2` |

Signal weights tune the escalation score: `IKBI_ESCALATION_WEIGHT_*` for
`SCHEMA_FAILURES` (15), `RETRY_COUNT` (10), `SCOUT_SCORE` (10), `CONTEXT_PRESSURE` (5),
`CRITIC_REJECTED` (20), `VERIFICATION_FAILED` (25), `REJECTED_TOOL_CALLS` (10),
`BENCHMARK_PASS_RATE` (5).

### Egress allowlist

Default-deny SSRF guard. When `IKBI_EGRESS_ALLOWLIST` is **unset**, a built-in default
applies so web tools and model calls work out of the box; **setting it REPLACES the default
entirely** — you must include your provider hosts or model calls fail closed.

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_EGRESS_ALLOWLIST` | see below | Permitted hosts (exact, case-insensitive). Setting it replaces the default |
| `IKBI_EGRESS_ALLOW_LOCAL` | *(empty)* | Opt-in internal endpoints as `ip:port` — **IP-literals only** (a hostname could re-open SSRF; rejected loudly at load). Must *also* be host-allowlisted |

Default allowlist: `html.duckduckgo.com`, `docs.python.org`, `developer.mozilla.org`,
`stackoverflow.com`, `api.xiaomimimo.com`, `api.deepseek.com`, `openrouter.ai`.

For a local Ollama: `IKBI_EGRESS_ALLOWLIST=127.0.0.1` and
`IKBI_EGRESS_ALLOW_LOCAL=127.0.0.1:11434`.

### Governed-exec allowlist

The command allowlist for the verifier/terminal. Unlike egress, it is **additive** — your
entries extend the defaults, never replace them.

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_GOVERNED_EXEC_ENABLED` | `true` | When false, every command denies fail-closed (not a bypass) |
| `IKBI_GOVERNED_EXEC_ALLOWLIST` | *(additive)* | Extra binaries the verifier/terminal may run |
| `IKBI_GOVERNED_EXEC_EXEC_TIMEOUT_MS` | `30000` | Per-command wall-clock cap |
| `IKBI_GOVERNED_EXEC_MAX_BUFFER` | `8388608` (8 MB) | Max captured stdout/stderr |
| `IKBI_GOVERNED_EXEC_NETWORK_TIMEOUT_MS` | `30000` | Network op timeout |

Built-in default binaries (never replaced): `git`, `ls`, `head`, `tail`, `wc`, `find`,
`grep`, `echo`, `npm`, `npx`, `pnpm`, `yarn`. `cat` is intentionally excluded (it can dump
`.env`/secrets — opt in explicitly if you must). Package managers are allowed, but
`<mgr> run …` and code-eval flags (`node -e`, `--eval`) stay policy-denied even when the
binary is allowlisted. To work on a Rust/Go/Python repo, add e.g.
`IKBI_GOVERNED_EXEC_ALLOWLIST=cargo,go,python3`.

### Verification & retrieval posture

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_VERIFY` | `ladder` | `ladder` (hardened, impact-scoped → full) or `legacy` |
| `IKBI_RETRIEVAL` | `index` | `index` (hardened) or `legacy` (40-file scan) |
| `IKBI_CHECKS` | *(auto)* | JSON array of `{name, command, args?}` overriding auto-detected checks |
| `IKBI_VERIFICATION_LADDER_MAX_IMPACT_HOPS` | `3` | Reverse-import dependent depth |
| `IKBI_VERIFICATION_LADDER_MAX_IMPACT_FILES` | `2000` | Cap on collected dependents |
| `IKBI_VERIFICATION_LADDER_MAX_CROSS_PACKAGE` | `0` | Cross-package importers before escalating to full |
| `IKBI_VERIFICATION_LADDER_TRUST_TRIVIAL_SCRIPTS` | `false` | Trust stub scripts (echo/true/exit 0) as real checks |

### Worker-model (build orchestrator)

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_WORKER_MODEL_ENABLED` | `false` | **Master switch — builds are off until on** |
| `IKBI_WORKER_MODEL_ROLE_TIMEOUT_MS` | `300000` (5 m) | Per-role wall-clock budget (bump for from-scratch builds) |
| `IKBI_WORKER_MODEL_TOTAL_BUDGET_MS` | `1800000` (30 m) | Whole-pipeline ceiling (0 disables) |
| `IKBI_WORKER_MODEL_MAX_CONCURRENT_RUNS` | `1` | Concurrent run cap |
| `IKBI_WORKER_MODEL_COMPETITIVE` | `false` | Competitive (multi-candidate) mode |
| `IKBI_WORKER_MODEL_COMPETITIVE_N` | `2` | Candidate count (bounded [2,4]) |
| `IKBI_WORKER_MODEL_RETAIN_FAILED_WORKSPACES` | `true` | Keep failed worktrees for inspection |
| `IKBI_WORKER_MODEL_PENALIZE_TIMEOUTS` | `false` | Count a timeout as trust-penalizing |
| `IKBI_WORKER_MODEL_FIX_LOOP` | `false` | Iterative fix loop (builder retries on test failures) |
| `IKBI_WORKER_MODEL_CRITIC_FIX_LOOP` | `false` | Critic-driven fix loop |
| `IKBI_WORKER_MODEL_SKIP_CRITIC_ON_RED` | `true` | Skip critic on discard-bound (red + fixLoop off) builds |
| `IKBI_REQUIRE_APPROVAL` | off | `true`/`1`/`yes`/`on` gates verified builds behind a human prompt |
| `IKBI_BUILDER_MODE` | `agent` | `agent` or `patch` (Patchsmith) |
| `IKBI_CANDIDATE_MODELS` | *(empty)* | Tournament candidate list (enables tournament) |

### Trust system tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_TRUST_DIR` | `<stateRoot>/trust` | Durable per-agent trust state |
| `IKBI_TRUST_PROMOTE_STREAK` | `20` | Consecutive successes to promote one tier |
| `IKBI_TRUST_DEMOTE_STREAK` | `3` | Consecutive failures to demote one tier |
| `IKBI_TRUST_PROMOTE_MIN_DISTINCT_OPS` | `2` | Distinct operations a streak must span (anti-farming) |
| `IKBI_TRUST_AUTO_PROMOTE` | `false` | Opt-in auto-promote worker to `trusted` after N builds |
| `IKBI_TRUST_AUTO_PROMOTE_AFTER` | `3` | Builds before auto-promotion fires |

### State, workspaces, receipts, substrate

| Variable | Default | Purpose |
|----------|---------|---------|
| `IKBI_WORKSPACE_ROOT` | `<stateRoot>/workspaces` | Worktrees + registry |
| `IKBI_WORKSPACE_MAX` | `32` | Max concurrently-allocated workspaces |
| `IKBI_WORKSPACE_MAX_AGE_HOURS` | `168` (7 d) | Age before `doctor --fix --force` reclaims |
| `IKBI_RECEIPT_DIR` | `<stateRoot>/receipts` | Receipt log directory |
| `IKBI_RECEIPT_RETENTION_DAYS` | `30` | Receipts older than this are hard-deleted by prune |
| `IKBI_LOCK_TIMEOUT_MS` | `10000` | Lock acquisition timeout |
| `IKBI_LOCK_STALE_MS` | `30000` | Age at which a cross-process lock is stale |
| `IKBI_FSYNC` | `true` | fsync atomic writes (durability vs speed) |
| `IKBI_EVENT_MAX_QUEUE` | `1000` | Per-subscriber bounded queue |
| `IKBI_MAX_SESSIONS` | (built-in) | REPL session prune cap |
| `IKBI_CHAT_WORKDIR` | *(unset)* | Pin REPL to a live-direct workdir (opt-in) |

### Other module knobs (selected)

Injection scanner: `IKBI_INJECTION_MAX_SCAN_BYTES` (1000000),
`IKBI_INJECTION_MAX_CONTENT_BYTES` (5000000), `IKBI_INJECTION_EXCERPT_MAX` (160).
Dependency install: `IKBI_DEPENDENCY_INSTALL_ENABLED` (true),
`IKBI_DEPENDENCY_INSTALL_REGISTRY_ALLOWLIST` (`https://registry.npmjs.org/`),
`IKBI_DEPENDENCY_INSTALL_PACKAGE_MANAGER` (pnpm), `IKBI_DEPENDENCY_INSTALL_TIMEOUT_MS`
(300000). Cache: `IKBI_CACHE_ENABLED` (true), `IKBI_CACHE_TTL_MS` (300000). MCP model loop:
`IKBI_MCP_MODEL_LOOP_MAX_TOOL_ITERATIONS` (20), `IKBI_MCP_MODEL_LOOP_TIMEOUT_MS` (120000).
Kill switch: `IKBI_KILL_SWITCH_ENABLED` (true), `IKBI_KILL_SWITCH_DIR`
(`<stateRoot>/kill-switch`). Drift prevention: `IKBI_DRIFT_PREVENTION_POLICY`
(`reportOnly`). Batch: `IKBI_BATCH_PLANNER_MAX_SUBTASKS` (12).

---

## Architecture Overview

ikbi's safety is structural, not advisory. Five boundaries cooperate so that a cheap model
can be given real autonomy without becoming dangerous.

### Trust boundaries (`src/core/trust/`)

Five tiers, ranked: `operator` (0) → `trusted` (1, agent ceiling) → `verified` (2) →
`probation` (3) → `untrusted` (4, floor). A never-seen agent resolves to the **floor**
(fail-closed) — trust is never assumed. Durable trust state is **MAC-protected** with
HMAC-SHA256 (key kept separate from the state dir); a hand-edited tier is rejected at load.
Promotion requires a streak of promotable successes spanning ≥2 distinct operations;
failures or a single injection attempt demote immediately, and the injection flag is
non-recoverable until an operator reset. The starting tier comes from the agent registry,
not the caller — identity is runtime-validated and unforgeable.

### Gate wall (`src/modules/gate-wall/`)

A deterministic policy evaluator that turns a trust grant into an allow/deny verdict for
exec and promote actions. If gate-wall is disabled → deny. For exec, command policy is
checked first (a deny overrides tier). For low tiers requiring approval (untrusted/probation)
there is no human-approval queue yet, so the verdict is **fail-closed deny**. Every
evaluation is receipted (`gate.evaluate`) with a correlation `gateId`.

### Memory governor

Writes to governed surfaces — top-level instruction files (CLAUDE.md), `.ikbi/` project
files, and brain pages — don't apply directly. They become operator-reviewed **proposals**
(`ikbi memory`). The governed-path checks are pure and deterministic; approval runs the
apply function (file write or `gbrainBridge.putPage`).

### Egress guard (`src/modules/egress/`)

A two-layer SSRF defense in front of every network call: (1) a default-deny **host
allowlist** (exact match), and (2) **internal-IP rejection** — the host is resolved and
denied if any A/AAAA record is loopback, link-local, private, ULA, or cloud-metadata, unless
the exact `ip:port` was opted in via `IKBI_EGRESS_ALLOW_LOCAL`. Blocks publish an
`egress.blocked` event and raise a non-retriable network error (a policy block, not a health
blip). A residual DNS-rebinding TOCTOU window is documented; validating every resolved IP
defeats static rebinds.

### Injection scanner / neutralization chokepoint (`src/core/injection/`)

Every tool result re-enters the model **only** through this chokepoint. Untrusted content is
always **fenced** (wrapped with boundary markers) regardless of verdict — wrapping is the
real protection; scanning only informs logging, suspicion, and gating. The scanner
normalizes (NFKC fold, strip zero-width/bidi/BOM) and matches 12 linear (ReDoS-resistant)
pattern families (instruction-override, role-confusion, forged role/ChatML/Llama markers,
prompt-leak, fence forgery, encoded payloads, exfiltration). Verdicts: `detected` (block),
`suspicious` (review), `clean` (proceed). A detection during an operation flags the agent
for trust demotion.

### Anti-cheat system (fix mode)

In `ikbi fix`, before any repair is reported real, an anti-cheat pass proves the model
didn't game the check: no weakened tests (assert count / specificity / test count must not
drop), no removed validators, no false success while checks still error, no edits outside
the diagnosed scope, no test-discovery/coverage/CI bypass, no `try/except: pass` silencing.
Any violation forces `UNSAFE_FAIL`. In competitive build mode, a **deterministic judge**
scores candidates — hard-fail overrides (typecheck/tests/rejected tool calls) first, then
weighted families (tests, efficiency, diff size, files, convergence), with a stable
tie-break.

---

## Troubleshooting

### "approval required (tier <tier>) — refusing to write"

A low-trust agent (untrusted/probation) tried to write/promote, and the human-approval queue
isn't available, so the gate fails closed. **Fix:** grant or earn trust —
`ikbi trust status <agentId>`, then `ikbi trust promote --yes` (or
`ikbi trust grant <agentId> trusted`). Verify the worker token is set
(`IKBI_WORKER_TOKEN`).

### "egress blocked (not_allowlisted): host \"<host>\" is not in IKBI_EGRESS_ALLOWLIST"

The host isn't on the egress allowlist. Remember that **setting** `IKBI_EGRESS_ALLOWLIST`
replaces the built-in defaults. **Fix:** add the host (and re-add your provider hosts, e.g.
`api.deepseek.com`) to `IKBI_EGRESS_ALLOWLIST`. Related variants: `egress blocked (scheme)`
(use http/https), `egress blocked (internal_ip)` (add the exact `ip:port` to
`IKBI_EGRESS_ALLOW_LOCAL` — IP-literal only), `egress blocked (dns_failure)` (check
connectivity/hostname).

### "binary \"<cmd>\" is not on the allowlist" / "<cmd> not on the allowlist"

A command (often a `--check` binary like `python3`, `cargo`, `go`) isn't allowlisted for
governed-exec. **Fix:** add it to `IKBI_GOVERNED_EXEC_ALLOWLIST` (additive — defaults
remain). Note: `node -e`/`--eval` and `<mgr> run …` stay denied by policy even when the
binary is allowed; restructure to avoid code-eval.

### "verifier_environment_missing" → result `ENVIRONMENT_MISSING`

The tool needed to verify isn't installed (e.g. `pytest`, `godot`, `cargo`). This is not a
code failure. **Fix:** install the tool and ensure it's on the governed-exec allowlist, then
re-run.

### result `TOOL_LIMITATION`

The verifier can't run/parse the tests (e.g. a parser rejects valid syntax). ikbi correctly
declines to edit code. **Fix:** none required of your code; address the tooling, or pin a
working `--check`.

### "process refuses to start — missing IKBI_TRUST_HMAC_KEY / IKBI_IDENTITY_TOKEN_SALT"

Production fail-closed: those secrets are required. **Fix:** set strong random values in
`~/.ikbi/env`. For local dev only, `IKBI_ALLOW_INSECURE_DEV_KEYS=true` permits default keys
(never in production).

### Builds do nothing / "no worker identity"

`IKBI_WORKER_MODEL_ENABLED` is off, or `IKBI_WORKER_TOKEN` is unset. **Fix:** set both. Run
`ikbi doctor` — its REQUIRED FOR A BUILD section names every missing piece.

### Workspace cleanup

After interrupts or failures, worktrees accumulate. `ikbi workspace ls` shows them
(`[RETAINED]` = the only copy of failed work). Inspect with `ikbi diff <id>`; remove one
with `ikbi workspace discard <id>`; bulk-preview with `ikbi workspace clean` (dry-run by
default) or `ikbi clean`. Add `--force` to sweep retained work, `--stale=<days>` to bound by
age. `ikbi doctor --fix --force` reclaims aged/stale workspaces past the retention window.

---

## Receipts Reference

Receipts are an append-only, retention-bounded operational log written by the service and
read by the CLI (`ikbi receipts`). They are single-writer and ordered by a monotonic `seq`
(a high-water max, so backward clock skew can't reuse a number). The store is *not* a
tamper-evident ledger by design (single-operator, local engine); the prune path (time-based,
gap-free) is the only deletion.

### Contract v1.0.0 — fields

| Field | Type | Meaning |
|-------|------|---------|
| `contractVersion` | string | Always `"1.0.0"` |
| `id` | string | Globally unique (16-byte hex) |
| `seq` | number | Monotonic, 0-based, no gaps |
| `timestamp` | number | Creation time (ms epoch) |
| `identity` | object | WHO: `agentId`, `functionalRole?`, `trustTier?` (snapshot), `sessionId?`, `spawnedFrom?` |
| `operation` | string | WHAT: e.g. `worker.role.builder`, `gate.evaluate`, `govexec.run`, `trust.transition` |
| `requestSummary?` | object | Bounded request summary (no secrets/raw blobs) |
| `outcome` | object | `status` (`success`/`failure`/`partial`/`rejected`), `detail?`, `error?`, `code?` |
| `changes` | array | Reversibility hook — per change: `kind` (file/state/exec/network/config/other), `target`, `summary?`, `before?`, `after?`, `inverse?` (undo op + args). Empty for read-only ops |
| `metadata?` | object | Free-form correlation (no secrets) |
| `requestId?` | string | Correlation id (e.g. taskId) |
| `project?` | string | Workspace/project scope |
| `corrects?` | string | If this receipt corrects an earlier one, its id |

Bounds (validation rejects over-size, fail-loud): fields ≤512 chars, text ≤4096, change
target ≤1024, changes ≤10000, `requestSummary`+`metadata` ≤64 KB each.

### Receipts by operation kind

- **Build / worker** — `worker.role.{scout,builder,critic,verifier}`, `worker.run.summary`;
  `requestSummary` carries goal/repo/model/cost; `metadata` carries role metrics
  (toolRounds, diffLines, filesWritten, test results).
- **Fix** — `fix.*`; `metadata` carries the diagnosis category, confidence, affected files,
  and anti-cheat results across the 12-stage trail.
- **Trust transition** — `trust.transition`; `metadata` records direction (promote/demote),
  from/to tier, and reason (e.g. `injection_attempt`, `consecutive_successes>=20`). `changes`
  is empty (state, not file-backed).
- **Gate wall** — `gate.evaluate`; `outcome.detail` is `allow`/`deny`; `metadata` has tier,
  action, allow flag, reason, `gateId`.
- **Governed exec** — `govexec.run` / `govexec.fetch`; `requestSummary` has the command (no
  args) / method+host (no URL); `metadata` has exit code and bounded stdout/stderr tails.

### Querying

```bash
ikbi receipts                       # recent, most-recent last
ikbi receipts --task <id>           # full trail of one run (roles + verification + promote)
ikbi receipts --failures --limit 20 # only failures
ikbi receipts --latest              # single most-recent
ikbi receipts verify                # integrity: seq sequential, no gaps
```

Durability is controlled by `IKBI_FSYNC` (default true): with fsync on, the most recent
receipts survive a hard crash; turning it off trades that for speed.

---

*This manual reflects ikbi `0.1.0`. Run `ikbi doctor` after any configuration change, and
`ikbi capabilities` to see the live tool inventory and product-surface lifecycle.*
