# Support

ikbi is an open release candidate maintained by one author. This document sets expectations so
reports are actionable and you know what is in scope.

## Supported platforms

| Platform | Status |
|---|---|
| **Linux + bubblewrap + user namespaces** | **Supported** — full build/repair, sandboxed. |
| Linux without bubblewrap | Partial — inspection works; risky builds fail closed (install bubblewrap). |
| macOS / Windows / WSL (no user namespaces) | **Unsupported for builds** — inspection/read-only only; risky code fails closed. |

Runtime: **Node.js 22+**, **pnpm**, **git**.

## What to report

Helpful bug reports include:

- Output of `node dist/cli/index.js doctor` (it leaks no secrets — keys are shown as set/unset).
- OS + `node --version`, `pnpm --version`, `bwrap --version`.
- Exact command, the goal/repo shape, and what you expected vs. saw.
- Relevant receipts (`ikbi receipts --latest` / `--task <id>`) — they carry the sandbox/script/network
  policy actually applied.
- Whether `pnpm public:smoke` passes on your machine.

Good things to report:

- A fresh clone that won't `pnpm install` / `pnpm build` / `pnpm test` on a supported platform.
- `public:smoke` failures on Linux+bubblewrap.
- A risky command that is **not** sandboxed when bubblewrap is available (a containment escape).
- A promotion that is not receipted, a verifier that passes a vacuous/stubbed result, or a
  test-weakening that gets promoted.
- doctor reporting a sandbox as working when it is not (or vice-versa).
- Crashes that leak a raw stack trace to a normal user.

## Out of scope

- **Risky execution on unsupported platforms** (non-Linux, or Linux without working user namespaces).
  ikbi *intends* to fail closed there; a report that "builds don't run without bubblewrap" is
  expected behavior, not a bug.
- **Exposing ikbi to the public internet.** There is no built-in auth/rate-limiting by design; securing
  a public exposure is the operator's responsibility.
- **Multi-tenant / multi-trust-domain** operation in a single process.
- **Feature requests for managed hosting, GUI installers, or platform support** beyond Linux+bwrap.
- The behavior of the **trusted-local override** (`*_TRUSTED_LOCAL=true`) — it deliberately runs risky
  work unsandboxed; that is documented and loudly receipted, not a vulnerability.

## Security issues

**Do not open a public issue for a security vulnerability.** Report it privately to the maintainer
(see the repository's GitHub page / `SECURITY.md`). Include a reproduction and the relevant receipts.
A sandbox-containment escape, a promotion-gate bypass, an egress-guard bypass, or trust-state forgery
are the highest-severity classes — see [SECURITY.md](SECURITY.md) for the threat model.
