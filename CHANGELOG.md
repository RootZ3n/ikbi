# Changelog

All notable changes to ikbi. Dates are UTC. ikbi uses explicit readiness labels
(`RC1_READY_FOR_JEFF`, `PUBLIC_RC_READY`, `PUBLIC_RELEASE_READY`) — see
[docs/RC1-RELEASE.md](docs/RC1-RELEASE.md).

## [0.1.0-rc.1] — Public RC candidate

Status: **PUBLIC_RC_READY** (candidate). The supported configuration is Linux + bubblewrap.

### Public-release hardening (this RC)

- **Self-contained repo.** `velum-ai` (the PII / injection-defense middleware, MIT, zero-dependency)
  is now **vendored** at `vendor/velum-ai` and referenced via `file:./vendor/velum-ai`. A fresh public
  clone installs, typechecks, builds, and tests **without any sibling repos** — the previous
  `velum-ai@file:../velum` requirement is gone.
- **Clean first run for a stranger.** `ikbi --version`, `ikbi <command> --help` (e.g. `build --help`,
  `memory --help`) now work on a cold shell with no trust keys set — previously they crashed with a
  raw "insecure default trust keys" stack. Help/version are read-only info and never required keys;
  the production guard still fires for a real `ikbi build`. (Fail-closed is unchanged.)
- **`ikbi doctor` PLATFORM & SANDBOX report.** doctor now tells you, on first run: supported OS,
  whether bubblewrap is present AND working (real no-op probe), sandbox mode, any dangerous
  trusted-local override, writability of state/receipts dirs, and a concrete prediction — will risky
  code run sandboxed, fail closed, or run via an override. Available in text and `--json`.
- **Public smoke suite.** `pnpm public:smoke` (`scripts/public-smoke.sh`) — a fast, API-key-free
  sanity + safety check (toolchain, typecheck/build, sandbox security regressions, cold-shell doctor,
  sandbox posture, a tiny TS build fixture, receipts subsystem).
- **labmem made truly optional.** The shared-memory recall integration degrades gracefully when
  labmem is absent; its positive test now skips (instead of erroring) on a clone without labmem.
  labmem is not bundled (private data + no public license).
- **Public docs.** New/updated `README.md`, `docs/INSTALL.md`, `SECURITY.md`, `SUPPORT.md`,
  `docs/KNOWN-LIMITATIONS.md`, `docs/RC1-RELEASE.md`, and this changelog.

### Security (the RC1 hardening that preceded the public work)

- **F1 governed-exec workspace escape — FIXED.** Risky subprocesses (interpreters, package scripts,
  toolchains, write tools) run inside a Linux bubblewrap sandbox: only the worktree is writable, the
  rest of the host is read-only, network is denied unless policy allows. A helper-script write via
  `../../x` or an absolute path can no longer escape the worktree. Sandbox unavailable ⇒ fail closed.
- **Dependency-install postinstall escape — FIXED.** Dependency installs run sandboxed; package
  lifecycle scripts are off by default (`--ignore-scripts`); script-enabled installs without a sandbox
  fail closed. The store/cache is bound writable; the rest of the host stays read-only.
- **Egress default-deny** with per-IP validation before connect (DNS-rebind TOCTOU residual
  documented in SECURITY.md).
- **Fail-closed trust:** cold/unknown trust → floor; forged MAC-protected trust state rejected;
  default keys refuse to start.

### Verification & evidence

- **Verification ladder** is the production default (stub detection, no-vacuous-green, scope stamps);
  **index retrieval** is the production default.
- **Gauntlet v2** hostile scorer fixes; **proving-ground** harness (`scripts/proving-ground/`) with an
  honest classifier and isolated state/receipts.
- **501-run proof:** PASS 166 / PARTIAL 19 / SAFE_FAIL 292 / FAIL 24 / INCOMPLETE 0 / **UNSAFE_FAIL 0**;
  all hard gates clean across 750+ sandboxed runs plus gauntlet/calibration/burn-in; 58/58 promotions
  receipt-backed. See [docs/RC1-RELEASE.md](docs/RC1-RELEASE.md) to reproduce.

### Known limitations

See [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md): non-Linux/no-bwrap fail-closed behavior,
package-script defaults, subprocess-network gap, Go/Godot toolchain caveats, API throttling, and the
public RC boundaries.
