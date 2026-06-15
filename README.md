# ikbi

> Choctaw: *"to build"* — a governed AI build/repair engine for a lab of agents.

ikbi is a long-running system service that lets a lab of AI agents build and repair
code under **governance**: trust is earned, untrusted input is neutralized at a
chokepoint, work happens in isolated workspaces, and every change is judged before
it lands. It binds **localhost by default** so it is reachable over
[Tailscale](https://tailscale.com) (the tailnet rides the host interface) while
staying invisible to the public internet. It binds a public interface only if you
explicitly opt in.

The design premise is **fail-closed everywhere**: a cold trust cache floors to the
lowest tier, an unknown agent floors, a missing operator identity denies, and the
service refuses to start on insecure default keys. Nothing dangerous is the default;
trust and capability are granted, never assumed.

## What's inside

- **Trust layer** — earned tiers with deterministic promotions/demotions
  (consecutive-success streaks spanning distinct operations to resist farming).
  Trust state is MAC-protected and fail-closed: a hand-edited or forged trust doc
  is rejected at load, so an agent holding a write primitive cannot self-promote.
- **Injection boundary** — a scanner plus a fence-based neutralization chokepoint
  that wraps all untrusted content, with verified-absent nonces so the fence cannot
  be spoofed by the content it contains.
- **Workspace isolation** — confinement and disposable shadow workspaces (isolated
  git worktrees) so a build can't escape its sandbox or trample the host tree.
- **Deterministic judge** — the scout / builder / critic / verifier / integrator
  roles, each with bounded authority, that turn a request into a verified change.
- **Receipts** — a lean, retention-bounded operational log (attributed, ordered,
  durable) for troubleshooting — not a cryptographic ledger.
- **Competitive builds** — an optional head-to-head model shootout that races one
  candidate per configured model and picks the winner.
- **Cheap-model harness** — the `worker-model` orchestrator that drives small,
  inexpensive models through the governed roles to land verified fixes cold → working
  for a fraction of a cent.
- **1438 tests** covering the core, the modules, the CLI, and end-to-end acceptance.

## Requirements

- Node.js >= 22
- pnpm

## Quick start

```sh
pnpm install
pnpm build        # tsc -> dist/
```

**Run a build** (the primary use case):

```sh
# Minimum required env (add to .env or export):
IKBI_ALLOW_INSECURE_DEV_KEYS=true      # dev only — use real keys in production
IKBI_WORKER_MODEL_ENABLED=true
IKBI_OPERATOR_TOKEN=<32+ char token>
IKBI_WORKER_TOKEN=<32+ char token>
IKBI_GOVERNED_EXEC_ALLOWLIST=pnpm      # let the verifier run `pnpm test`
<YOUR_PROVIDER>_API_KEY=<key>           # e.g. ANTHROPIC_API_KEY

node dist/cli/index.js build "fix the failing test" --repo /path/to/repo
```

ikbi allocates an isolated git worktree, runs the 5-role pipeline (scout → builder →
critic → verifier → integrator), and promotes the change only when verification passes.
After the build, inspect what happened:

```sh
node dist/cli/index.js diff <workspace-id>     # git diff of the change
node dist/cli/index.js receipts --latest        # build receipt (what ran, verdict)
node dist/cli/index.js undo <receipt-id>        # revert if needed
```

Run `ikbi doctor` to see what's configured, what's missing, and how to fix each gap.

**Start the HTTP service** (if you need the `/chat` or `/capabilities` endpoints):

```sh
pnpm start        # node dist/index.js
curl localhost:18796/health   # {"status":"ok","service":"ikbi","version":"0.1.0"}
curl localhost:18796/ready    # {"status":"ready","ready":true}
```

Stop it with `Ctrl-C` (SIGINT) or `kill -TERM <pid>` — it drains and exits 0.

## CLI commands

| Command | What it does |
| ------- | ------------ |
| `ikbi build <goal...>` | Run the 5-role pipeline toward a goal; promotes on verify pass |
| `ikbi diff <workspace-id>` | Print a workspace's git diff (base..scratch) + change summary |
| `ikbi undo <receipt-id\|commit\|--latest>` | Revert a promoted change (previews diff before reverting) |
| `ikbi receipts` | Show receipt history — what ran, outcomes, costs |
| `ikbi workspace ls` | List build workspaces (state, branch, target repo) |
| `ikbi workspace discard <id>` | Drop a workspace that was retained or failed |
| `ikbi workspace clean` | Bulk-clean stale/terminal workspaces (dry-run by default) |
| `ikbi workspaces` | Alias — inspect and manage workspaces |
| `ikbi clean` | Reclaim orphaned git worktrees (retained work is preserved) |
| `ikbi cost` | Cost breakdown by task from the receipt log |
| `ikbi audit <repo>` | Read-only diagnostic snapshot of a repo |
| `ikbi doctor` | Report bootstrap config; `--fix` repairs common gaps |
| `ikbi capabilities` | Tool inventory + surface classification |
| `ikbi repos` | List registered repos (from state/repos.json) |
| `ikbi models` | List the model roster (id, role, cost, provider chain) |
| `ikbi providers` | List registered providers |

### Key flags for `ikbi build`

| Flag | Meaning |
| ---- | ------- |
| `--repo <path>` | Target repository (git worktree is allocated here) |
| `--verbose` | Stream per-role progress events to stdout as the build runs |
| `--cost` | Print a per-role cost breakdown table after the build |
| `--yes` | Skip the interactive confirmation prompt before promoting |
| `--delegation <json>` | Accept a delegation envelope from Pehlichi (see below) |
| `--no-memory` | Skip loading project memory (CLAUDE.md / AGENTS.md / .ikbi/) |
| `--memory-diff` | Show what project memory was loaded, then exit |

### Pehlichi integration (`--delegation`)

Pehlichi (the lab's lead agent) delegates builds to ikbi by passing a signed
`DelegationEnvelope` as JSON:

```sh
ikbi build --delegation '{"goal":"fix the test","targetRepo":"/path","delegatedBy":"pehlichi-1","taskId":"t-123"}'
```

The envelope's `goal` and `targetRepo` override any positional arguments. ikbi
validates the envelope fields before starting the pipeline.

### Custom verification (`IKBI_CHECKS`)

By default ikbi runs `pnpm test` and `pnpm typecheck` as the verifier's checks.
Override for non-JS repos or custom runners:

```sh
# Python project:
IKBI_CHECKS='[{"name":"test","command":"python3","args":["-m","pytest"]}]' \
  ikbi build "fix the import error" --repo /path/to/python-repo

# Multiple checks:
IKBI_CHECKS='[{"name":"build","command":"make"},{"name":"test","command":"make","args":["test"]}]' \
  ikbi build "add the new endpoint" --repo /path/to/c-repo
```

`IKBI_CHECKS` is a JSON array of `{name, command, args?}` objects. A malformed value
fails closed (RED) — the verifier will not promote on a misconfigured check set.

## Scripts

| Command          | What it does                              |
| ---------------- | ----------------------------------------- |
| `pnpm build`     | Type-check + compile TypeScript to `dist/`|
| `pnpm start`     | Run the built service                     |
| `pnpm dev`       | Run from source with watch (`tsx`)        |
| `pnpm typecheck` | Type-check only, no emit                  |
| `pnpm test`      | Run the test suite (`node --test`)        |

## Configuration

The bootstrap configuration is parsed in one place — [`src/core/config.ts`](src/core/config.ts) —
which is the **primary** config seam; most modules read their own `IKBI_*` slice through it.
A small number of paths read `process.env` **directly** by design, for per-request secrets and
runtime mode toggles that must be settable without a process restart: the `POST /chat` bearer token
(`IKBI_CHAT_TOKEN`), the chat workdir (`IKBI_CHAT_WORKDIR`), the verification/retrieval mode
overrides (`IKBI_VERIFY` / `IKBI_RETRIEVAL`), governed-exec, and a few worker-model/CLI seams. These
are the documented exceptions the architecture invariants allow — not a single-reader guarantee. All
knobs are `IKBI_*` prefixed. The CLI autoloads a project `.env` at
startup (a real environment variable always wins over a `.env` entry), so you can keep
your `IKBI_*` tokens in `.env`. The most important ones:

| Env var                       | Default       | Meaning                                                              |
| ----------------------------- | ------------- | ------------------------------------------------------------------- |
| `IKBI_OPERATOR_TOKEN`         | *(unset)*     | Bootstrap operator identity (hashed at load); grants trust          |
| `IKBI_WORKER_TOKEN`           | *(unset)*     | Bootstrap worker identity builds run under                          |
| `IKBI_TRUST_HMAC_KEY`         | *(required)*  | MAC key protecting trust-state integrity                            |
| `IKBI_IDENTITY_TOKEN_SALT`    | *(required)*  | Global pepper for the token-hash KDF                                |
| `IKBI_ALLOW_INSECURE_DEV_KEYS`| `false`       | Opt in to start on the built-in default trust keys (dev only)       |
| `IKBI_WORKER_MODEL_ENABLED`   | `false`       | Master switch — builds are disabled until this is on                |
| `IKBI_CHECKS`                 | *(auto)*      | JSON array of `{name,command,args?}` — override the verifier's check set |
| `IKBI_GOVERNED_EXEC_ALLOWLIST`| *(empty)*     | Binaries the verifier may run (needs `pnpm` for tsc/tests)          |
| `IKBI_EGRESS_ALLOWLIST`       | *(empty)*     | Default-deny network egress allowlist (hosts)                       |
| `IKBI_ALLOW_PUBLIC_BIND`      | `false`       | Required to bind a non-loopback (public) interface                  |
| `IKBI_PORT`                   | `18796`       | TCP port to bind                                                    |
| `IKBI_BIND_HOST`              | `127.0.0.1`   | Interface to bind                                                   |
| `IKBI_STATE_ROOT`             | `<cwd>/state` | Root directory for runtime state                                    |

Two settings are hard start-up gates — the service refuses to start otherwise:

- Binding a non-loopback host without `IKBI_ALLOW_PUBLIC_BIND=true`.
- Running on the insecure built-in trust HMAC key or token salt: set
  `IKBI_TRUST_HMAC_KEY` **and** `IKBI_IDENTITY_TOKEN_SALT`, or opt in explicitly
  with `IKBI_ALLOW_INSECURE_DEV_KEYS=true` for development.

See [`src/core/config.ts`](src/core/config.ts) for the full env surface (provider
endpoints, circuit breaker, trust streak tuning, receipt retention, injection
limits, lock timeouts, and the per-module knobs) and [SECURITY.md](SECURITY.md) for
the security posture and known residuals.

## Layout

```
src/
  core/      foundations: config, logging, trust, identity, injection,
             provider layer, receipts, substrate (atomic writes + locking),
             workspace primitive, events
  modules/   engine modules: worker-model orchestrator, deterministic-judge,
             governed-exec, egress guard, gate-wall, and more
  server/    Fastify HTTP service (health/lifecycle, agent discovery, chat)
  cli/       operator CLI (`doctor`, `capabilities`, `build`, `diff`, …)
  index.ts   entry point: start server, handle SIGTERM/SIGINT
deploy/
  ikbi.service   sample systemd unit (documented, not installed)
```

## Endpoints

| Method | Path            | Purpose                                                        |
| ------ | --------------- | -------------------------------------------------------------- |
| `GET`  | `/health`       | Liveness — `{ status: "ok", version }`                         |
| `GET`  | `/ready`        | Readiness — 200 when ready, 503 while starting                 |
| `GET`  | `/agent`        | Agent identity/discovery — id, role, model, tool count, status |
| `GET`  | `/capabilities` | Tool inventory (16) + feature flags + product posture (surface classification & lifecycle truth) |
| `POST` | `/chat`         | Conversational coding session (bounded tool-calling loop). **Ephemeral** — sessions are in-memory only and do not survive a server restart; use `ikbi repl --continue` for durable sessions |

## Product surfaces

Not every surface carries the same guarantees. The **CLI build path** (`ikbi build`/`diff`/
`workspace`/`undo`) is the golden path: it edits isolated, promotable git worktrees, gates success on
ladder verification, and gives explicit governed promote/undo.

The **interactive REPL** (`ikbi repl`) now shares the build path's *managed-workspace* lifecycle: a
repo-mode session allocates an isolated git worktree off your repo and edits **there**, never the
target directly. Review pending changes with `/diff`, then land them with an explicit `/apply` — which
runs the **same ladder verification `ikbi build` uses** (governed checks, script-integrity guard,
impact-scoped) and promotes **only on a pass**; a failed, blocked, or undeterminable verification
fails closed (no commit, no promote). The promote is governed and receipt-backed — undo later with
`ikbi undo` — and the verification verdict is recorded in the session. `/discard` drops the workspace
safely. `ikbi repl --scratch` keeps the old throwaway behavior and is clearly labelled
**non-promotable** (it cannot verify or apply).

The **HTTP `/chat`**, **batch**, **mcp**, **sub-agent**, and **bare-goal cognition** paths are
*experimental* (or *dormant*): HTTP chat sessions are ephemeral, in-memory, and non-managed (a
deliberate deferral). Each surface's honest classification and lifecycle truth is reported by `ikbi
doctor`, `ikbi capabilities`, the REPL `/status` command, and the HTTP `GET /capabilities` endpoint,
and is specified in [`docs/PRODUCT-SPINE.md`](docs/PRODUCT-SPINE.md) and
[`docs/ARCHITECTURE-INVARIANTS.md`](docs/ARCHITECTURE-INVARIANTS.md).

## Running under systemd

A sample unit lives at [`deploy/ikbi.service`](deploy/ikbi.service). It runs the
service, restarts on failure, sends `SIGTERM` for graceful shutdown, and logs to
the journal. It is documented but **not installed** — see the comments at the top
of the file.
