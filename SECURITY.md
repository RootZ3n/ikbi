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
- **Project code → OS-sandboxed (Linux bubblewrap).** Risky governed-exec commands
  (interpreters, package scripts, toolchains, write tools) and dependency installs run
  inside `bwrap`: only the worktree (+ the package store/cache + an ephemeral `/tmp`) is
  writable, the rest of the host is read-only, and network is denied unless policy allows.
  Package lifecycle scripts are off by default (`--ignore-scripts`). When the sandbox is
  unavailable, risky execution FAILS CLOSED (no unsafe default; explicit `*_TRUSTED_LOCAL`
  override only). See `docs/RC1-RELEASE.md` for requirements, limitations, and the operator guide.
- **Network egress → default-deny.** No host is reachable unless it is on the egress
  allowlist, and every resolved IP is validated against internal ranges before connect.
  The allowlist mechanism is default-deny; the *shipped default* is non-empty (the
  configured model-provider API hosts plus `developer.mozilla.org` / `stackoverflow.com`)
  so model calls work out of the box. Setting `IKBI_EGRESS_ALLOWLIST` **replaces** that
  default, so a custom list must still include your provider host(s).

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

---

## Threat model

ikbi's primary threat is the **code it runs on your behalf**: model-authored helper scripts,
project test suites, package lifecycle scripts, and toolchains — any of which may be buggy,
adversarial (a poisoned dependency / injected goal), or simply wrong. The design assumes the
*operator* is trusted and writing their own goals on a machine they control; it does **not** assume
the *executed code* is trustworthy.

**In scope (defended):**

- **Filesystem escape from a build.** Risky subprocesses run under bubblewrap with only the worktree
  writable and the entire host read-only — no escape via `..`, an absolute path, or a helper script
  (the F1 fix). See `docs/RC1-RELEASE.md` §1 and `src/modules/governed-exec/sandbox.ts`.
- **Dependency-install code execution.** Installs run sandboxed; lifecycle scripts off by default
  (`--ignore-scripts`); script-enabled installs without a sandbox fail closed.
- **Command surface.** Every shell command goes through governed-exec: a default-deny **allowlist** +
  **gate-wall** + **receipts**; `<mgr> run …` and code-eval flags (`-e`/`-c`) are policy-denied even
  for allowlisted binaries.
- **Prompt-injection / untrusted content.** Every tool RESULT re-enters the model only through the
  **neutralization chokepoint**; the bundled velum middleware adds PII masking + injection defense on
  the HTTP surface.
- **Network egress.** Default-deny allowlist; every resolved IP validated against internal ranges
  before connect (DNS-rebind TOCTOU residual documented above).
- **Trust forgery / self-promotion.** Trust state is MAC-protected and rejected if forged; unknown /
  cold trust starts at the floor; default keys refuse to start.
- **False promotion.** A build promotes only on a ladder-verified pass (stub detection,
  no-vacuous-green, scope stamps); every promotion is receipted; test-weakening and vacuous green are
  caught before promotion.

**Out of scope (NOT defended — your responsibility):**

- **Network exposure.** No built-in authentication, authorization, or rate-limiting. Binding ikbi to
  a public interface and securing it is entirely the operator's responsibility.
- **A malicious operator.** The operator is the trust root; ikbi defends the operator from the code
  it runs, not the machine from the operator.
- **Risky execution without the OS sandbox.** On non-Linux / no-userns hosts the sandbox is
  unavailable; ikbi fails closed rather than pretending to contain code.
- **Subprocess-initiated network during installs** is not routed through the in-process egress guard
  (compensated by registry allowlist + frozen lockfile + receipts). See KNOWN-LIMITATIONS.
- **Multi-tenant isolation** within one process (see above).

## The trusted-local override (read before using)

`IKBI_GOVERNED_EXEC_TRUSTED_LOCAL=true` and `IKBI_DEPENDENCY_INSTALL_TRUSTED_LOCAL=true` make ikbi run
risky work **UNSANDBOXED** when no bubblewrap is available, instead of failing closed. They are
**default-OFF**, and every such run is loudly receipted (`sandbox=unavailable`, risk-classified).
Use them **only** on a trusted single-operator box you fully control, for goals you wrote yourself —
**never** for untrusted/delegated goals or repos. `ikbi doctor` surfaces these overrides as warnings
when they are on. This is a deliberate escape hatch, not a vulnerability.

## Receipts

Every governed action (exec, install, fetch) and every promotion writes a **receipt** to
`<stateRoot>/receipts`. Receipts carry the `sandbox` backend (`bwrap`/`none`/`unavailable`), the
`scriptPolicy`, the `networkPolicy`, and the writable mounts actually applied — so you can audit, after
the fact, exactly how a piece of code was contained. Inspect with `ikbi receipts --latest` /
`--task <id>`. They are an operational log, not a tamper-proof ledger; protect the state directory
accordingly.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Report it privately to the maintainer
(see the repository's GitHub page). Include a reproduction and the relevant receipts. Highest-severity
classes: a sandbox-containment escape on a Linux+bwrap host, a promotion-gate bypass, an egress-guard
bypass, and trust-state forgery. See [SUPPORT.md](SUPPORT.md) for what is in/out of scope.
