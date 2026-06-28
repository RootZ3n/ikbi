# Installing ikbi

ikbi is a governed build/repair engine. Its **supported configuration is Linux with bubblewrap**.
It installs and runs read-only/inspection commands on any platform, but *risky* project-code
execution (the build pipeline) requires the OS sandbox and **fails closed** without it.

---

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Node.js 22+** | runtime (ESM, modern APIs) | `node --version` |
| **pnpm** | package manager + verifier driver | `pnpm --version` (`npm i -g pnpm`) |
| **git** | ikbi isolates work in git worktrees | `git --version` |
| **bubblewrap** (Linux) | OS sandbox for risky code + installs | `bwrap --version` |
| **user namespaces** (Linux) | bubblewrap needs them to work | see §2 |

ikbi has only three runtime dependencies (`fastify`, `@fastify/static`, `pino`) plus a **vendored**
copy of `velum-ai` (PII/injection-defense middleware, bundled under `vendor/velum-ai`). There are
**no sibling-repo requirements** — a fresh clone installs standalone.

## 2. Linux + bubblewrap setup

Install bubblewrap:

```bash
sudo apt install bubblewrap     # Debian / Ubuntu
sudo dnf install bubblewrap     # Fedora / Rocky / RHEL
sudo pacman -S bubblewrap       # Arch
```

bubblewrap needs **unprivileged user namespaces**. They're on by default on Fedora and Ubuntu.
If `bwrap` is installed but ikbi reports the sandbox probe failed, enable them:

```bash
# Debian/some hardened kernels:
sudo sysctl -w kernel.unprivileged_userns_clone=1
# (persist in /etc/sysctl.d/ if needed)
```

ikbi does **not** trust the binary's mere presence — `ikbi doctor` actually runs a no-op under the
real sandbox policy, so "working" means "works on THIS host."

> **No bubblewrap?** ikbi still installs and runs `doctor`, `models`, `receipts`, etc. Risky builds
> fail closed with a clear message. Dependency installs with lifecycle scripts **off** (the default)
> still proceed. See [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).

## 3. Install

```bash
git clone https://github.com/RootZ3n/ikbi.git
cd ikbi
pnpm install            # frozen, self-contained
pnpm build              # tsc -> dist/  (also typechecks)
```

Verify the install and the safety model in one shot (no API keys needed):

```bash
pnpm public:smoke
```

## 4. Provider / API setup

ikbi works with many OpenAI-compatible providers and local models. Configuration is via env vars
(prefixed `IKBI_`). Copy the template and fill in what you need:

```bash
cp .env.example .env
```

- **Secrets go in `~/.ikbi/env` or the install-root `.env`, NOT a project `.env`.** ikbi *refuses*
  to load trust/identity secrets (`IKBI_TRUST_HMAC_KEY`, `IKBI_IDENTITY_TOKEN_SALT`,
  `IKBI_OPERATOR_TOKEN`, `IKBI_WORKER_TOKEN`) from a project-directory `.env`, so a target repo can
  never carry credentials.
- **Trust keys are required for real builds.** Set strong random `IKBI_TRUST_HMAC_KEY` and
  `IKBI_IDENTITY_TOKEN_SALT` (e.g. `openssl rand -hex 32`). Without them ikbi refuses to start a
  build (info commands like `doctor`/`--version` still work — they auto-use dev keys, scoped to
  read-only info only).
- **Enable builds:** `IKBI_WORKER_MODEL_ENABLED=true` (safe in a project `.env`).
- **Pick a provider.** Set the matching `IKBI_<PROVIDER>_API_KEY` (and base URL if non-default) and
  the role models (`IKBI_MODEL_DRIVER`, `IKBI_MODEL_BUILDER`, `IKBI_MODEL_CRITIC`). A local model
  via Ollama needs `IKBI_OLLAMA_BASE_URL` plus the egress allow-local entry (see below).
- **Egress is default-deny but ships non-empty** (provider hosts + MDN + Stack Overflow). Setting
  `IKBI_EGRESS_ALLOWLIST` **replaces** the default — include your provider host(s) or model calls
  fail closed. Local models also need `IKBI_EGRESS_ALLOW_LOCAL=127.0.0.1:11434`.

Minimal `.env` for a first build with, say, DeepSeek:

```bash
IKBI_WORKER_MODEL_ENABLED=true
IKBI_DEEPSEEK_API_KEY=sk-...
IKBI_MODEL_DRIVER=deepseek-v4-pro
IKBI_MODEL_BUILDER=deepseek-v4-pro
IKBI_MODEL_CRITIC=deepseek-v4-pro
# secrets below belong in ~/.ikbi/env, shown here only for illustration:
# IKBI_TRUST_HMAC_KEY=...   IKBI_IDENTITY_TOKEN_SALT=...
# IKBI_OPERATOR_TOKEN=...   IKBI_WORKER_TOKEN=...
```

`ikbi doctor --fix` can scaffold a `.env` template and create state dirs for you.

## 5. Doctor

```bash
node dist/cli/index.js doctor
```

`doctor` reports, with a one-line fix for each gap:
- **REQUIRED FOR A BUILD** — operator/worker tokens, worker-model enabled, provider role models
  resolve.
- **SECURITY** — trust key state.
- **SAFETY POSTURE** — verification (ladder) + retrieval (index) modes.
- **ENVIRONMENT** — node / pnpm / git / disk / detected project / LSP toolchains.
- **PLATFORM & SANDBOX** — OS, bubblewrap (real probe), sandbox mode, trusted-local override, and a
  concrete prediction: will risky code run sandboxed, fail closed, or run via an override.

## 6. First smoke build

With a provider configured:

```bash
node dist/cli/index.js build "add a one-line note to the README" --repo /path/to/a/git/repo
```

ikbi runs the 5-role pipeline in an isolated worktree and **promotes only on a ladder-verified
pass**. Inspect afterwards: `ikbi diff <workspace-id>`, `ikbi receipts --latest`, `ikbi cost`.
Undo a promotion with `ikbi undo --latest`.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Refusing to start with insecure default trust keys` on a build | Set `IKBI_TRUST_HMAC_KEY` + `IKBI_IDENTITY_TOKEN_SALT` (in `~/.ikbi/env`), or `IKBI_ALLOW_INSECURE_DEV_KEYS=true` for dev only. |
| Risky build refused: "sandbox is unavailable" | Install bubblewrap + enable user namespaces (§2). `doctor` confirms when it's working. |
| Model calls fail / time out | Egress allowlist replaced without your provider host, or no API key. Check `doctor` EGRESS + provider sections. |
| `pnpm install` wants to purge node_modules in CI | Set `CI=true` (pnpm's non-interactive default). |
| Go builds fail `ENVIRONMENT_MISSING` | Host Go toolchain is broken (`GOROOT`); fix your Go install. See KNOWN-LIMITATIONS. |
| Dependency that needs a postinstall is incomplete | Lifecycle scripts are off by default. Set `IKBI_DEPENDENCY_INSTALL_ALLOW_SCRIPTS=true` (runs sandboxed). |

More: [docs/MANUAL.md](MANUAL.md) · [SECURITY.md](../SECURITY.md) ·
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md).
