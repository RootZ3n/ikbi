# ikbi — a governed build/repair engine for cheap & local models

> **⚠️ LAB-ONLY DEFAULT — AUTHENTICATION IS YOUR RESPONSIBILITY**
>
> ikbi is designed for **local / lab use**. It binds to `localhost` by default and is meant
> to run behind Tailscale, a VPN, or a private network. **If you expose any service to the
> public internet, YOU are responsible for securing it** — there is no built-in auth, rate
> limiting, or access control, and that is a design decision, not a bug. Expose at your own risk.

**Status:** `PUBLIC_RC_READY` (candidate) — see [Release status](#release-status).
The supported configuration is **Linux with bubblewrap**. Other platforms run in a reduced,
fail-closed mode (see [What ikbi is not](#what-ikbi-is-not)).

---

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
```

Then configure a model provider (see [docs/INSTALL.md](docs/INSTALL.md)) and run your first build:

```bash
node dist/cli/index.js build "add a unit test for parseConfig" --repo /path/to/your/repo
```

> On Linux without bubblewrap, install it first: `sudo apt install bubblewrap`
> (Debian/Ubuntu) or `sudo dnf install bubblewrap` (Fedora/Rocky). Without it, `doctor`
> will tell you risky builds fail closed.

## The surfaces

- **`ikbi build "<goal>" --repo <path>`** — the golden batch path: a 5-role pipeline
  (scout → builder → critic → verifier → integrator) in an isolated git worktree; promotes only
  on a ladder-verified pass.
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
