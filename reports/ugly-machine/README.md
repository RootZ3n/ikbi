# Ugly-machine matrix — public RC

Goal: prove a fresh public clone (the committed tree, **no sibling repos**) installs and behaves
correctly across distros, and that the no-bwrap path fails closed. Reproduce:
`bash scripts/ugly-machine-debian.sh`.

| Environment | Install (no `../velum`) | typecheck/build | doctor sandbox report | Risky-exec behavior | Sandbox tests |
|---|---|---|---|---|---|
| **Fedora host** (bwrap 0.11.0, userns ON) | ✅ | ✅ | reports SANDBOXED | runs **sandboxed** | F1 21/21 pass; full suite 2868 pass |
| **Debian 12 container, NO bwrap** | ✅ vendored velum resolves | ✅ | reports FAILS CLOSED | **fails closed** (refused) | 31 pass / 5 skip (real-escape skips; fail-closed paths run) |
| **Debian 12 container, bwrap 0.8.0, userns restricted** | ✅ | ✅ | reports "bwrap present but user namespaces disabled" | **fails closed despite the binary** | 5 pass / 4 skip |

Key findings:

- **Self-contained**: on Debian with no `../velum` sibling, `pnpm install --frozen-lockfile` resolves
  `velum-ai` from the in-repo `vendor/velum-ai`; typecheck + build + tests pass.
- **No-bwrap fail-closed**: `ikbi doctor` clearly reports risky code FAILS CLOSED; script-disabled
  installs still proceed; `ikbi --version` works on a cold shell.
- **Probe, not presence**: with bubblewrap *installed* but unable to create user namespaces (a common
  rootless-container restriction), ikbi's real no-op probe fails and risky code STILL fails closed —
  it never runs unsandboxed just because the binary exists. doctor names the cause (user namespaces).
- **No host escape**: no escape artifacts were created by any test in any environment.

Real bubblewrap *containment* (the F1 escape-prevention assertions) is exercised on the Fedora host,
where user namespaces work (bwrap 0.11.0). The Debian container could not run nested user namespaces
(rootless podman), which is itself a useful negative test of the fail-closed path.

Per-run logs: `debian-bookworm-*.log`.
