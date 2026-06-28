# Known limitations

Be honest with yourself about these before relying on a run. None of them are hidden; each is a
documented, bounded choice. (Security *residuals* — understood risks in the protections themselves —
live in [SECURITY.md](../SECURITY.md). This file is about **capability** boundaries.)

## Platform

- **Non-Linux is not validated for risky execution.** bubblewrap is Linux-only. On macOS / Windows /
  WSL-without-user-namespaces the OS sandbox is unavailable, so risky project code (interpreters,
  toolchains, package scripts, write tools) **fails closed**. Inspection / read-only commands
  (`doctor`, `models`, `receipts`, `diff`, `capabilities`) work everywhere. Treat non-Linux as
  unsupported for builds.
- **Linux without bubblewrap → fail closed.** Risky governed-exec commands are refused with a clear
  diagnostic; there is no unsafe default. Dependency installs with lifecycle scripts **off** (the
  default) still proceed (receipted `sandbox=unavailable`); script-enabled installs fail closed.
- **User namespaces must be enabled.** `bwrap` being installed is not enough — ikbi runs a real
  no-op under the actual policy at probe time. If userns are disabled, `doctor` says so.

## Sandbox & dependencies

- **Package lifecycle scripts are OFF by default** (`--ignore-scripts`). Packages that build native
  bindings via a postinstall may be incomplete. Most of the JS ecosystem ships prebuilt platform
  bindings, so common test runners work; a package that *must* compile on install needs
  `IKBI_DEPENDENCY_INSTALL_ALLOW_SCRIPTS=true` (then sandboxed).
- **Dependency store is read-only inside the sandbox** except the bound store/cache. A frozen install
  hardlinks from the operator's store; brand-new packages not yet in the store are fetched into the
  bound store/cache. The builder's *in-loop* `pnpm add` of brand-new packages can fail under the
  read-only host policy — primary dependency provisioning is the (sandboxed) `dependency-install` path.
- **Subprocess network is not egress-guarded.** The sandbox denies network for risky commands and
  allows it only for installs (to the allowlisted registry); a package manager's own traffic does not
  pass through ikbi's in-process egress guard. Compensating controls: registry allowlist +
  frozen lockfile + receipts. Documented gap, not pretend coverage.

## Toolchains

- **Go** needs a healthy host Go install (`GOROOT` set, non-trimmed binary). A broken host Go makes
  builds fail closed as `ENVIRONMENT_MISSING` — correct fail-closed, not an ikbi bug.
- **Godot** verification needs a headless Godot + a test framework wired into `IKBI_CHECKS`; absent
  that, Godot targets fail closed (unverifiable).
- **Languages beyond TS/JS/Python** need their toolchain added to `IKBI_GOVERNED_EXEC_ALLOWLIST` and,
  for verification, a check wired via `IKBI_CHECKS`.

## Operational

- **API throttling (429) degrades the *pass rate*, not the safety gates.** Under heavy concurrent
  model load the provider rate-limits; builds then stall / `no_progress` and fail **closed**
  (SAFE_FAIL), never unsafe. Run proofs sequentially or off-peak for a representative pass rate.
- **Adversarial / denied goals burn the builder's round/budget** before failing closed. Bound it with
  `IKBI_WORKER_MODEL_TOTAL_BUDGET_MS`. Safe, but can be slow.
- **One trust domain per process.** Multi-tenant governance (multiple isolated trust domains in one
  process) is explicitly out of scope. Isolate by running separate processes with separate keys/state.

## Optional integrations

- **labmem (lab-wide shared memory) is optional and external.** It is **not** bundled (its tree
  carries private data and ships no public license). Without it, the recall surface degrades
  gracefully (`LabmemUnavailable`); ikbi is fully functional. Point `LABMEM_ROOT` at a built labmem
  checkout to enable it.

## Public RC boundaries

ikbi is a **public RC candidate**, not a finished general-availability product. Not yet validated:

- Onboarding / install across the full matrix of heterogeneous machines and distros (the supported
  Linux+bwrap path is exercised; broad cross-distro coverage is partial — see
  [RC1-RELEASE.md](RC1-RELEASE.md)).
- Long-term support guarantees, semver stability of internal modules, and migration tooling.
- Non-Jeff production operation at scale.

See [SUPPORT.md](../SUPPORT.md) for what is in/out of scope to report.
