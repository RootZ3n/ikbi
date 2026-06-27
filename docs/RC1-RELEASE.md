# ikbi — RC1 Release & Operator Guide

Status label: **RC1_READY_FOR_JEFF** (personal, trusted, single-operator use) · **PUBLIC_RC_NOT_YET**.

Do not read this as "ready for everyone." Read the [Known Limitations](#known-limitations) and the
[label definitions](#release-labels) before relying on it.

---

## 1. Sandbox requirements

ikbi executes project-owned code (interpreters, test runners, build tools, **and dependency
installs**). That code is confined at the **OS level** with Linux **bubblewrap** (`bwrap`).

### What you need
- **Linux + bubblewrap** (`bwrap`), with **user namespaces enabled** (the default on Fedora/Ubuntu).
  Install: `sudo dnf install bubblewrap` (Fedora/Rocky) or `sudo apt install bubblewrap` (Debian/Ubuntu).
- ikbi probes the sandbox at runtime (`detectSandbox()` actually runs a no-op under the real policy),
  so "available" means "works on THIS host," not merely "the binary exists."

### What the sandbox guarantees
For every **risky** command (interpreters `node`/`python3`/…, package scripts, toolchains, write
tools) and for **dependency install**:
- **Only the worktree** (and, for installs, the package **store/cache** + an ephemeral `/tmp`) is
  **writable**. The entire rest of the host — real `$HOME`, `~/.ikbi`, `/pehverse`, repo parents,
  `/etc`, any absolute path — is bound **read-only**. A write to them fails hard (EROFS); a relative
  `../../x` from the worktree resolves into that read-only area ⇒ also EROFS; an absolute `/tmp/x`
  goes to a private tmpfs that vanishes on exit.
- **Network is denied** (`--unshare-net`) except where policy allows (a package install reaching the
  allowlisted registry).
- Inline eval (`node -e`, `python3 -c`) stays blocked; that is separate from the sandbox.

### What happens when `bwrap` is UNAVAILABLE
- **Risky governed-exec commands FAIL CLOSED** — ikbi refuses to run project code without OS
  confinement, with a clear diagnostic. There is **no unsafe default**.
- **Dependency install**: with package scripts **disabled** (the default, `--ignore-scripts`) no
  untrusted code runs, so install **proceeds** (and is receipted as `sandbox=unavailable`). With
  scripts **enabled** and no sandbox, install **FAILS CLOSED**.
- **Override (dangerous, default-OFF):** `IKBI_GOVERNED_EXEC_TRUSTED_LOCAL=true` /
  `IKBI_DEPENDENCY_INSTALL_TRUSTED_LOCAL=true` run risky work UNSANDBOXED. Every such run is loudly
  receipted. Use ONLY on a trusted single-operator box you fully control; never for untrusted goals.

### Non-Linux behavior
bubblewrap is Linux-only. On macOS/Windows/WSL-without-userns the sandbox is unavailable ⇒ risky
commands fail closed (script-disabled installs still work). ikbi is **not** validated for non-Linux
risky execution; treat non-Linux as unsupported for RC1.

### Relevant env
| Var | Default | Meaning |
|---|---|---|
| `IKBI_GOVERNED_EXEC_SANDBOX` | `auto` | `auto`\|`off`\|`required`. `off` is dev/tests only. |
| `IKBI_GOVERNED_EXEC_TRUSTED_LOCAL` | `false` | Run risky cmds unsandboxed if no bwrap (dangerous). |
| `IKBI_DEPENDENCY_INSTALL_ALLOW_SCRIPTS` | `false` | Run package lifecycle scripts (postinstall). Sandboxed when on. |
| `IKBI_DEPENDENCY_INSTALL_SANDBOX` | `auto` | `auto`\|`off`\|`required`. |
| `IKBI_DEPENDENCY_INSTALL_TRUSTED_LOCAL` | `false` | Run script-enabled installs unsandboxed if no bwrap (dangerous). |

---

## 2. Known limitations

Be honest with yourself about these before trusting a run.

- **Dependency store is read-only inside the sandbox (except the store/cache bind).** A *frozen*
  install hardlinks from the operator's package store; if a needed package is **not** already in the
  store on a cold machine, the in-sandbox fetch writes to the bound store/cache. Store *poisoning* by
  a postinstall is bounded: scripts are off by default (no postinstall runs), and the store is
  integrity-checked. The builder's *in-loop* `pnpm add` of brand-new packages can fail under the
  read-only host policy — primary dep provisioning is the (now sandboxed) `dependency-install` path.
- **Package scripts are OFF by default (`--ignore-scripts`).** Packages that rely on a postinstall to
  build native bindings may be incomplete. The JS ecosystem mostly ships **prebuilt** platform
  bindings (esbuild/rolldown/etc.), so test runners (vitest/jest/pytest) work; a package that *must*
  compile on install needs `IKBI_DEPENDENCY_INSTALL_ALLOW_SCRIPTS=true` (then sandboxed).
- **Subprocess network is not egress-guarded.** The sandbox denies network for risky commands and
  allows it only for installs (to the allowlisted registry); but a package manager's own traffic does
  not pass through ikbi's in-process egress guard. Compensating controls: registry allowlist +
  lockfile-frozen + receipts. Documented gap, not pretend coverage.
- **Go is environment-broken on the reference host** (`GOROOT` unset / trimmed binary). Go builds
  fail closed as `ENVIRONMENT_MISSING` — correct fail-closed, not an ikbi bug; fix the host Go install
  to use Go.
- **Godot** verification needs a headless Godot + a test framework wired into `IKBI_CHECKS`; absent
  that, Godot targets fail closed (unverifiable). Godot 4.6 is present on the reference host but no
  headless test harness is configured.
- **API throttling (429) degrades the *pass rate*, not the safety gates.** Under heavy concurrent
  model load the provider rate-limits; builds then stall/`no_progress` and fail **closed** (SAFE_FAIL),
  never unsafe. Run the gauntlet/proof sequentially or off-peak for a representative pass rate.
- **Adversarial / denied goals burn the builder's round/budget** before failing closed (set
  `IKBI_WORKER_MODEL_TOTAL_BUDGET_MS` to bound it). Safe, but slow.
- **Public/shared use is NOT validated**: onboarding, install on heterogeneous machines, support
  boundaries, and multi-tenant isolation are open. See PUBLIC_RC_NOT_YET.

---

## 3. RC1 operator guide

### Run classes — what to let ikbi do

| Class | Examples | Stance |
|---|---|---|
| **Safe unattended** | `ikbi build`/`fix` on YOUR repos with clean trees; `audit`/`review`/`detect`/`doctor`/`models`/`receipts` (read-only) | Let it run. Promotion is fail-closed (verified + receipted) and code execution is OS-sandboxed. |
| **Supervised** | builds needing `ALLOW_SCRIPTS=true`; brand-new dependency additions; long/expensive runs; new languages/toolchains | Watch it; review the diff (`ikbi diff <ws>`) and receipts before trusting the result. |
| **Human-only** | running ikbi against **untrusted/delegated** goals or repos; anything with the `TRUSTED_LOCAL` override on; non-Linux risky execution; public/multi-tenant | Don't. The sandbox + script-disable assume a trusted operator writing their own goals. |

### How to operate
- **Inspect a run:** `ikbi receipts --task <id>` (full trail) · `ikbi receipts --latest` · `ikbi diff <workspace-id>` · `ikbi cost`.
- **Sandbox/install evidence:** receipts carry `sandbox` (`bwrap`/`none`/`unavailable`), `scriptPolicy`
  (`ignore-scripts`/`scripts-allowed`), `networkPolicy`, and writable mounts. Confirm `sandbox=bwrap`
  on risky execs and installs.
- **Clean worktrees:** `ikbi workspace ls` · `ikbi clean` (reclaim terminal/orphaned) · `ikbi clean --force`
  (sweep all, incl. retained) · `ikbi workspace discard <id>`.
- **Undo a promotion:** `ikbi undo <receipt-id|--latest>` (shows the diff first).
- **Re-run the proving ground:** `node scripts/proving-ground/runner.mjs --suite hostile --stop-on-unsafe`
  · `--plan calibration|burnin` · `--only <id>` · `--list`. Hostile escape probes should classify
  **SAFE_FAIL** (resisted), never UNSAFE.
- **Hostile gauntlet:** `scripts/gauntlet-v2.sh` (12 scenarios; hard gate UNSAFE_FAIL 0 / INCOMPLETE 0).

### What STOPS a run (fail-closed, by design)
no parent identity · binary not on the allowlist · gate-wall deny · **sandbox unavailable for risky
code** · script-enabled install without a sandbox · no recognizable manifest / no `IKBI_CHECKS` ·
dirty target repo (refuses to clobber uncommitted work) · no_progress / budget exceeded · a verifier
that can't go green · anti-cheat / script-integrity tripping before promotion.

---

## Release labels

- **NOT_READY** — any hard gate fails (UNSAFE_FAIL, INCOMPLETE, workspace escape, hidden mutation,
  promoted test-weakening, promoted false success, missing receipt on a promoted mutation, Toolpack/
  memory-governance bypass, dirty-repo damage, dependency-install escape).
- **DAILY_DRIVER_CANDIDATE** — F1 fixed, dependency-install risk addressed, 200+ sandboxed runs, hard
  gates clean, limitations documented.
- **RC1_READY_FOR_JEFF** — dependency-install fixed/fail-closed, clean full gauntlet, 500-run proof,
  hard gates clean, ugly-machine smoke, docs updated. **For Jeff's personal, trusted, Linux+bwrap use.**
- **PUBLIC_RC_NOT_YET** — even when RC1 is ready for Jeff, public release needs install/onboarding
  docs, ugly-machine testing across distros, support boundaries, versioned releases, and broader
  user testing. ikbi is here.
