# Security posture

ikbi's governing principle is **fail-closed**: the safe state is the default, and
capability is granted rather than assumed. Concretely:

- **Cold trust cache → floor.** An agent with no durable trust state starts at the
  lowest tier, not a convenient default.
- **Unknown agent → floor.** An unrecognized caller is treated as least-trusted.
- **Missing operator identity → deny.** Operator-gated actions fail closed when no
  operator identity is established.
- **Forged trust state → reject.** Trust documents are MAC-protected; a hand-edited
  or forged doc is rejected at load, so an agent holding a write primitive cannot
  self-promote.
- **Default keys → refuse to start.** The service will not start on the insecure
  built-in trust HMAC key or token-hash pepper unless `IKBI_ALLOW_INSECURE_DEV_KEYS=true`
  is set explicitly for development (the refusal fires at config load, before the
  trust and identity modules construct).
- **Network egress → default-deny.** No host is reachable unless it is on the egress
  allowlist, and every resolved IP is validated against internal ranges before connect.

This document records the **known residuals** — risks that are understood, bounded,
and tracked, so they are documented choices rather than folklore.

## DNS-rebinding TOCTOU in the egress guard

**Status:** mitigated, with a known residual race.

The egress guard (`src/modules/egress/guard.ts`) resolves a target hostname,
validates that **every** returned IP is non-internal (not loopback / link-local /
ULA / metadata / private), and only then hands the request to the transport. This
defeats the static-internal-IP case and the single-answer rebind case.

**Residual:** the transport re-resolves DNS at connect time, so an attacker who
re-points the name to an internal IP in the window between our validation and the
transport's connect could still reach internal space — the classic
resolve-then-connect TOCTOU race.

**Planned fix:** pin the connection to the validated IP via a custom
dispatcher/lookup. This is pending the transport surface exposing it: the minimal
`FetchLike` seam ikbi uses (`{ method, headers, body, signal }` only — no
dispatcher) does not expose connection pinning, and rewriting the URL to an IP
literal would break TLS SNI and certificate validation. Validating every resolved
IP is the strongest mitigation available within the current surface; the residual
is the re-resolution race, and IP pinning is the follow-up once the transport allows
it.

## TUI / external clients are governed via `/chat` (SG-8)

**Status:** governed by construction — documented so it is not assumed.

The terminal UI (the standalone `tui/` package) does **not** execute tools itself and
does **not** import ikbi's internals. Its tool-calling path
(`tui/src/lib/agent-chat.ts`) is a thin HTTP client to ikbi's `POST /chat` endpoint;
the actual model+tool loop runs **server-side** inside ikbi's `ChatSession`
(`src/modules/chat/session.ts`), which is governed by the **same** trust/identity
machinery as the CLI:

- a **governed parent context** is resolved from the operator/worker token
  (`resolveParentCtx`); absent one, the `terminal` / `run_checks` tools **fail closed**;
- the `terminal` tool routes through **governed-exec** (allowlist + gate-wall + receipts),
  exactly as in the worker builder;
- every tool RESULT re-enters the conversation only through the **neutralization
  chokepoint** (`neutralizeUntrusted` + `toUntrustedMessage`);
- all file/search tools are **worktree-confined** (`confinePath`).

So a TUI tool call is governed identically to a CLI tool call — because it *is* an ikbi
server-side tool call. The TUI's other path (`tui/src/lib/chat.ts`) is a direct, **tool-less**
conversation with the model provider: it has no execution surface to govern. There is no
ungoverned "bridge tools" surface in this repo; the `/chat` route is the single governed
boundary every external client crosses.

## Single trust domain per process

**Status:** intentional architectural assumption — not a limitation to be fixed.

ikbi is one lab's governance core: one trust configuration, one operator, one key
set per process. The singleton config model reflects this directly. Running
multiple isolated trust domains (multi-tenant governance) inside a single process is
explicitly **out of scope** and is **not a supported configuration**. Isolation
between trust domains is achieved by running separate processes, each with its own
keys, operator, and state root.
