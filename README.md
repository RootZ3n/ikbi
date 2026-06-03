# ikbi

> Choctaw: *"to build"* — the build/repair engine for a lab of agents.

ikbi is a long-running system service. It binds **localhost by default** so it is
reachable over [Tailscale](https://tailscale.com) (the tailnet rides the host
interface) while staying invisible to the public internet. It only ever binds a
public interface if you explicitly opt in.

This repo is **Phase 0**: a clean, runnable service skeleton. No engine logic
yet — it starts, binds localhost, answers `/health` + `/ready`, logs structured
JSON, and shuts down cleanly on a signal.

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
curl localhost:18796/health   # {"status":"ok","service":"ikbi","version":"0.0.0"}
curl localhost:18796/ready    # {"status":"ready","ready":true}
```

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
Nothing else touches `process.env`. All knobs are `IKBI_*` prefixed.

| Env var                  | Default            | Meaning                                            |
| ------------------------ | ------------------ | -------------------------------------------------- |
| `IKBI_PORT`              | `18796`            | TCP port to bind                                   |
| `IKBI_BIND_HOST`         | `127.0.0.1`        | Interface to bind                                  |
| `IKBI_ALLOW_PUBLIC_BIND` | `false`            | Required to bind a non-loopback (public) interface |
| `IKBI_STATE_ROOT`        | `<cwd>/state`      | Root directory for runtime state                   |
| `IKBI_LOG_LEVEL`         | `info`             | pino log level                                     |
| `IKBI_ENV`               | `NODE_ENV` or `development` | Runtime environment label                  |

Binding a non-loopback host without `IKBI_ALLOW_PUBLIC_BIND=true` is a hard
error — the service refuses to start.

## Layout

```
src/
  core/      config + logging foundations (config.ts, log.ts)
  modules/   engine modules (stub — Phase 0)
  server/    Fastify HTTP service (health/lifecycle only)
  cli/        operator CLI (stub — Phase 0)
  index.ts   entry point: start server, handle SIGTERM/SIGINT
deploy/
  ikbi.service   sample systemd unit (documented, not installed)
```

## Endpoints (Phase 0)

| Method | Path      | Purpose                                         |
| ------ | --------- | ----------------------------------------------- |
| `GET`  | `/health` | Liveness — `{ status: "ok", version }`          |
| `GET`  | `/ready`  | Readiness — 200 when ready, 503 while starting  |

## Running under systemd

A sample unit lives at [`deploy/ikbi.service`](deploy/ikbi.service). It runs the
service, restarts on failure, sends `SIGTERM` for graceful shutdown, and logs to
the journal. It is documented but **not installed** — see the comments at the top
of the file.
