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
- **716 tests** covering the core, the modules, and the CLI.

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

All configuration is read in exactly one place — [`src/core/config.ts`](src/core/config.ts).
Nothing else touches `process.env`; modules read their own `IKBI_*` slice through the
config seam. All knobs are `IKBI_*` prefixed. The most important ones:

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
  server/    Fastify HTTP service (health + lifecycle)
  cli/       operator CLI (incl. `doctor`)
  index.ts   entry point: start server, handle SIGTERM/SIGINT
deploy/
  ikbi.service   sample systemd unit (documented, not installed)
```

## Endpoints

| Method | Path      | Purpose                                         |
| ------ | --------- | ----------------------------------------------- |
| `GET`  | `/health` | Liveness — `{ status: "ok", version }`          |
| `GET`  | `/ready`  | Readiness — 200 when ready, 503 while starting  |

## Running under systemd

A sample unit lives at [`deploy/ikbi.service`](deploy/ikbi.service). It runs the
service, restarts on failure, sends `SIGTERM` for graceful shutdown, and logs to
the journal. It is documented but **not installed** — see the comments at the top
of the file.
