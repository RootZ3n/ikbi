> **⚠️ LAB-ONLY PRODUCT — AUTHENTICATION IS YOUR RESPONSIBILITY**
>
> This tool is designed for **local/lab use only**. It binds to localhost by default
> and is meant to run behind Tailscale, a VPN, or on a private network.
>
> **If you expose any service to the public internet, YOU are responsible for
> securing it.** No authentication, rate-limiting, or access control will be added
> to this product. That is not a bug — it is a design decision.
>
> Expose at your own risk.

# ikbi

A governed AI coding agent that makes cheap and local models trustworthy.

```bash
npm install ikbi
```

## What is this?

ikbi is a Claude Code alternative that works with **cheap and local models** — not just frontier APIs. It's a build/repair engine that sandboxes, verifies, and governs everything the AI does, so a weaker model can be trusted to write real code.

**Key ideas:**
- **Sandboxed execution** — code runs inside a Linux bubblewrap sandbox (only the worktree is writable, network denied by default).
- **Evidence-based verification** — a build only promotes when real checks pass (typecheck + tests), with stub-detection and no false-green protection.
- **Governed execution** — every shell command goes through an allowlist + gate-wall + receipts. Every model output is neutralized before re-entering the loop.
- **Earned trust** — capability is granted, not assumed. Unknown agents start at the floor.
- **Auditable receipts** — every governed action and promotion is recorded.
- **Any model, natively** — cheap/local models (DeepSeek, MiMo, GLM, local Ollama) run through the OpenAI-compatible client; frontier models run through **native adapters** — Anthropic via the real `/messages` API with `tool_use` blocks and **prompt caching**. Point a model id at the right provider and it drives the loop.

It runs as a long-running **service** (localhost/Tailscale) or as a **CLI**.

**The interactive REPL is a full agentic loop.** `ikbi repl` runs tools the way a modern coding agent does: read-only tools **execute in parallel** within a turn (writes stay serialized and governed), the conversation **auto-compacts** when the context window fills, and the `terminal` tool keeps a **persistent working directory** (`cd` sticks across commands, confined to the worktree). With a frontier model set as the driver, the loop is the harness — not the bottleneck.

## What is Peh?

[Peh](https://github.com/RootZ3n/peh) is an open-source AI ecosystem — a family of tools for building, running, and governing AI agents. ikbi is one piece of that ecosystem. Other siblings:

| Project | What it does |
|---|---|
| [velum](https://github.com/RootZ3n/velum) | AI runtime / orchestration layer |
| [kokuli](https://github.com/RootZ3n/kokuli) | Model routing and provider abstraction |
| [nusika](https://github.com/RootZ3n/nusika) | Evaluation and benchmarking |
| [luak](https://github.com/RootZ3n/luak) | Sandbox and execution governance |

---

**Status:** `PUBLIC_RC_READY` (candidate) — see [Release status](#release-status).
The supported configuration is **Linux with bubblewrap**. Other platforms run in a reduced,
fail-closed mode (see [What ikbi is not](#what-ikbi-is-not)).

## What ikbi is

ikbi (Choctaw: *"to build"*) is a governed AI coding agent — a Claude-Code-style build/repair
engine designed so that **cheap or local models can be trusted to write code**. Rather than
assuming a frontier model's judgment, ikbi gives a weaker model every structural advantage:

- **Evidence-based verification** — a build is promoted only when a verification *ladder* goes
  green (real checks: typecheck + tests), with stub-detection and no-vacuous-green protection.
- **Governed execution** — every shell command routes through an allowlist + gate-wall + receipts;
  every model tool-result re-enters the loop only through a neutralization chokepoint.
- **OS-level sandboxing** — project code and dependency installs run inside a Linux **bubblewrap**
  sandbox: only the worktree is writable, the rest of the host is read-only, network is denied by
  default. If the sandbox is unavailable, risky execution **fails closed**.
- **Earned trust** — capability is granted, not assumed; trust state is MAC-protected and starts
  at the floor for an unknown agent.
- **Receipts** — every governed action and every promotion is recorded in an auditable trail.

It runs both as a long-running localhost/Tailscale **service** and as a **CLI**.

## What ikbi is *not*

- **Not a hosted/multi-tenant product.** One trust domain per process. No built-in auth.
- **Not validated for risky execution off Linux.** bubblewrap is Linux-only; on macOS / Windows /
  WSL-without-userns the OS sandbox is unavailable, so risky project code **fails closed**.
  Inspection and read-only commands still work everywhere. See
  [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).
- **Not a replacement for reviewing your diffs.** Promotion is fail-closed and receipted, but you
  own the result.

## Supported platforms

| Platform | Risky build/exec | Inspection / doctor / read-only |
|---|---|---|
| **Linux + bubblewrap + user namespaces** | ✅ supported (sandboxed) | ✅ |
| Linux without bubblewrap | ⚠️ fails closed (install bubblewrap) | ✅ |
| macOS / Windows / WSL (no userns) | ❌ not validated; fails closed | ✅ |

Requirements: **Node.js 22+**, **pnpm**, **git**, and (for builds) **bubblewrap** on Linux.

## Quickstart

```bash
git clone https://github.com/RootZ3n/ikbi.git
cd ikbi
pnpm install           # self-contained — no sibling repos required
pnpm build             # compile to dist/  (also typechecks)
pnpm public:smoke      # fast, API-key-free sanity + safety check

node dist/cli/index.js doctor    # first-run health + sandbox report
node dist/cli/index.js doctor --check-providers --json  # local-only provider/model readiness
node dist/cli/index.js self-test --json                   # deterministic local workflow test (provider-free by default)
```

Then configure a model provider (see [docs/INSTALL.md](docs/INSTALL.md)) and run the canonical external-agent workflow:

```bash
node dist/cli/index.js run --spec task.json --repo /path/to/your/repo
node dist/cli/index.js run --spec task.json --repo /path/to/your/repo --json
node dist/cli/index.js inspect <run-id> --json
```

The short operator guide is [docs/AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md). It is the
authoritative onboarding path for an unfamiliar external agent; the legacy `build` command remains
available for advanced/operator use.

> On Linux without bubblewrap, install it first: `sudo apt install bubblewrap`
> (Debian/Ubuntu) or `sudo dnf install bubblewrap` (Fedora/Rocky). Without it, `doctor`
> will tell you risky builds fail closed.

## The surfaces

- **`ikbi build "<goal>" --repo <path>`** — **the governed v2 build engine** (the daily driver):
  build in an isolated workspace, deterministically verify the exact candidate tree, semantically
  review it, adjudicate a lawful disposition, and promote an **eligible** candidate to the target
  branch by a clean-ref compare-and-swap (a dirty source checkout is never silently committed).
  `--strategy single|shadow|tournament` chooses one, two, or a bounded set of candidates (more
  candidates ⇒ more model spend; exactly one lawful winner is promoted). `--json` for the full
  session receipt; `ikbi doctor --v2` checks daily-driver readiness (no paid calls).
  - _During the v2 qualification window the frozen v1 pipeline remains available as an explicit
    emergency fallback under `ikbi legacy build "<goal>"` — never the default, never entered by
    accident; it is slated for removal after the final independent audits._
- **`ikbi run --spec <file>`** — the canonical preflighted external-agent path. It resolves the
  repository and task, performs local provider/host/state checks before allocation or invocation,
  then delegates to the same authoritative worker/orchestrator path and returns one terminal result.
- **`ikbi self-test` / `ikbi inspect <run-id>`** — deterministic local readiness test and bounded
  inspection of the existing run receipts/workspace evidence.
- **`ikbi repl`** — interactive, multi-turn, tool-calling session (the closest analog to Claude
  Code's REPL).
- **`ikbi fix <repo>`** — diagnose a failing check and repair it narrowly (or correctly refuse);
  never promotes.
- **`ikbi doctor` / `capabilities` / `models` / `receipts` / `cost` / `diff` / `undo` /
  `workspace*` / `clean` / `audit`** — operator + inspection commands.

## Safety model (the short version)

ikbi's governing principle is **fail-closed**: the safe state is the default and capability is
granted, not assumed.

- Project code & dependency installs are **OS-sandboxed** (bubblewrap); unavailable ⇒ risky work
  is **refused** (no unsafe default; an explicit, loudly-receipted `*_TRUSTED_LOCAL` override
  exists only for a trusted single-operator box).
- Package lifecycle scripts are **off by default** (`--ignore-scripts`).
- Network egress is **default-deny** (allowlist; every resolved IP validated before connect).
- Trust state is **MAC-protected**; default keys **refuse to start** unless you opt into dev keys.
- Every governed action is **receipted**.

Full detail: **[SECURITY.md](SECURITY.md)** · threat model & what is/ isn't protected.

## Documentation

| Doc | What it covers |
|---|---|
| [docs/AGENT-QUICKSTART.md](docs/AGENT-QUICKSTART.md) | Concise external-agent installation, run, recovery, JSON, and evidence guide |
| [docs/INSTALL.md](docs/INSTALL.md) | Prereqs, bubblewrap setup, provider/API setup, first build, troubleshooting |
| [SECURITY.md](SECURITY.md) | Sandbox model, governed-exec, dependency-install sandbox, trusted-local warning, receipts, threat model, residuals |
| [docs/RC1-RELEASE.md](docs/RC1-RELEASE.md) | Evidence summary, hard gates, the 501-run proof, how to reproduce key checks |
| [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md) | Non-Linux / no-bwrap behavior, toolchain caveats, network/registry, public RC boundaries |
| [SUPPORT.md](SUPPORT.md) | Supported/unsupported platforms, what to report, what's out of scope |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |
| [docs/MANUAL.md](docs/MANUAL.md) | The full operator manual |

## Release status

ikbi uses explicit status labels so readiness is never asserted by vibes:

- **`RC1_READY_FOR_JEFF`** — personal, trusted, single-operator Linux+bubblewrap use. ✅ met.
- **`PUBLIC_RC_READY`** — a stranger can clone, install (no sibling repos), run doctor, run the
  public smoke, and do a small safe build; supported-Linux ugly-machine matrix passes; no-bwrap
  fail-closed proven; known limitations documented. ← **current candidate.**
- **`PUBLIC_RELEASE_READY`** — versioned artifact + release notes + non-Jeff onboarding validated.
  Not yet.

See [docs/RC1-RELEASE.md](docs/RC1-RELEASE.md) for the evidence behind these labels.

## License

MIT © Jeffrey Miller. See [LICENSE](LICENSE). Bundled `vendor/velum-ai` is MIT (its own LICENSE
is included).
