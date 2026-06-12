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
pnpm start        # node dist/index.js
```

Then:

```sh
curl localhost:18796/health   # {"status":"ok","service":"ikbi","version":"0.1.0"}
curl localhost:18796/ready    # {"status":"ready","ready":true}
```

Run `ikbi doctor` to see, in one command, what's configured, what's missing for a
build, and how to fix each gap (it needs no identity and no network — config only).

Stop it with `Ctrl-C` (SIGINT) or `kill -TERM <pid>` — it drains and exits 0.

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
