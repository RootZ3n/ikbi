# ikbi external-agent quickstart

> **WHICH ENGINE — read this first.**
>
> `ikbi build` is the **canonical v2 engine** and the proven production path. It is what the
> Pehverse Trio's `delegate_implementation` calls, and what produced every governed candidate
> in the lab's evidence.
>
> `ikbi run --spec` is the **LEGACY v1 engine**. The binary says so itself. Most of this
> document still describes it, and it is retained for the v1 path only.
>
> `ikbi inspect <run-id>` is likewise **v1** and returns `not_found` for a v2 run id. v2
> evidence lives in the build session JSON plus `~/.ikbi/state/receipts/receipts.ndjson`
> (`identity.agentId: "ikbi-v2"`, operations `run.summary` and `workspace.promote`).
>
> A v2 build in one line — mutation scope is required and there is no default:
>
> ```bash
> ikbi build "<goal>" --repo <path> --allow-path <file> --profile deepseek --json
> ```
>
> Verification checks travel in `IKBI_CHECKS` as a JSON array of
> `{name, command, args, cwd?}`. Exit 0 alone is not success: ikbi itself requires
> `status: completed`, `verification.status: passed` and `promotion.status: promoted`.
> `--local-mode off|assist|auto` selects Bokahli participation; its advice is data and never
> authority.

This is the shortest supported path for an unfamiliar agent to build one task.
Use the canonical `run` command; it owns local preflight and then delegates to
ikbi's existing authoritative worker/orchestrator pipeline.

## 1. Install and check the host

From an ikbi checkout, use `node dist/cli/index.js` as the invocation shown
below. An installed package exposes the same command as `ikbi` (replace that
prefix in the examples):

```bash
pnpm install
pnpm build
node dist/cli/index.js self-test --json
node dist/cli/index.js doctor --json
node dist/cli/index.js doctor --check-providers --json
```

Real builds are supported on Linux with working bubblewrap and unprivileged
user namespaces. Node 22+, pnpm, and Git are required. If the sandbox is not
available, risky execution fails closed. `self-test` is deterministic and makes
no provider call by default; its provider-readiness section is informational
and does not make a local self-test fail just because credentials are absent.
`self-test --provider-smoke` is an explicit, bounded provider request and may
incur cost, so use it only when that call is authorized.

## 2. Configure credentials and models

Configuration precedence is: explicit process environment, then the effective
ikbi `.env` sources (`~/.ikbi/env` and the install-root `.env`), then safe
defaults. A target repository `.env` may provide non-secret project settings,
but ikbi refuses identity and trust secrets there.

For a real build, configure strong values for `IKBI_OPERATOR_TOKEN`,
`IKBI_WORKER_TOKEN`, `IKBI_TRUST_HMAC_KEY`, and
`IKBI_IDENTITY_TOKEN_SALT`; set `IKBI_WORKER_MODEL_ENABLED=true`; assign the
driver, builder, and critic models; and configure the matching provider route
and credential. `doctor --check-providers --json` reports effective sources,
roles, roster membership, and credential presence without revealing values or
contacting a provider. Fix every blocking issue before retrying. If a local
installation intentionally uses ikbi-generated development keys, the
development-only `IKBI_ALLOW_INSECURE_DEV_KEYS=true` switch must be explicit;
strong operator/worker tokens do not need it.

## 3. Write a task specification

Use a bounded JSON file. The smallest form is:

```json
{
  "taskId": "calculator-fix",
  "goal": "Fix the calculator defect and keep the tests passing",
  "repository": "/absolute/path/to/the/target-repository"
}
```

`repository` can be omitted when `--repo` is supplied or the current Git
repository is the target. Optional fields are `branch`, `checks` (one command
string or an array), `maxCostUsd`, `noTestsPolicy`, and `rules`. The target must
have a named, clean Git branch; detached HEAD and dirty working trees are
refused. ikbi never stashes or edits the target repository during preflight.
Install the target repository's declared dependencies with its normal package
manager before requesting checks that need them; generated dependency folders
must be ignored by Git.

## 4. Run the task

```bash
node dist/cli/index.js run --spec task.json
node dist/cli/index.js run --spec task.json --json
```

Equivalent installed-binary form:

```bash
ikbi run --spec task.json --json
```

`--repo <path-or-registered-name>` overrides the repository in the spec. With
no override, ikbi uses the spec repository and then the current repository.
Preflight order is: spec, repository, production configuration, local provider
readiness, Git/HEAD state, verification configuration, host/sandbox
capabilities, state/receipt/workspace writability, kill/recovery state, and
workspace capacity. A block happens before workspace allocation and before any
paid provider invocation where possible; blocked JSON explicitly says whether
invocation or mutation started.

With `--json`, stdout contains exactly one terminal JSON document. Diagnostics
go to stderr. Do not parse human output. The stable process exit codes are:

| Code | Meaning |
|---:|---|
| 0 | completed, verified, and promoted |
| 10 | local preflight block or promotion refusal |
| 20 | execution or verification failure |
| 30 | cancellation |
| 40 | internal ikbi/evidence error |

Exit 0 is not merely process health: the result must say
`status: "completed"`, `verification.status: "passed"`, and
`promotion.status: "promoted"`. A verified candidate that cannot be promoted
is reported as blocked/refused with preserved workspace evidence. Autonomous
promotion remains quarantined by the existing governance default; treat
`RUN_PROMOTION_REFUSED` as a verified candidate awaiting operator review, not
as a reason to bypass the promotion authority.

## 5. Inspect and recover

Save the returned `runId`:

```bash
node dist/cli/index.js inspect <run-id>
node dist/cli/index.js inspect <run-id> --json
node dist/cli/index.js workspace ls
node dist/cli/index.js diff <workspace-id>
```

The result and inspection summary point to the existing run summary, workspace
and candidate, invocation receipts, mutation evidence, verification and
promotion receipts, the receipt log, and retained diagnostics when available.
Preflight blocks intentionally have no candidate or run receipt because no
candidate exists yet. Failed or cancelled runs may retain a workspace; inspect
it before discarding it. Follow the result's exact recovery instructions, then
retry only after the cause is corrected. Provider issues retain their nested
`PROVIDER_*` codes inside `RUN_PROVIDER_PREFLIGHT_BLOCKED`.

Use a fresh `taskId` when you need an isolated evidence trail. Reusing a task ID
intentionally shows the existing task-correlated receipt history, including
earlier attempts.

Common stable run codes include `RUN_SPEC_MISSING`, `RUN_SPEC_INVALID`,
`RUN_REPOSITORY_INVALID`, `RUN_REPOSITORY_STATE_UNSUPPORTED`,
`RUN_HOST_CAPABILITY_MISSING`, `RUN_STATE_ROOT_UNWRITABLE`,
`RUN_RECEIPT_STORE_UNWRITABLE`, `RUN_RECOVERY_REQUIRED`,
`RUN_PROVIDER_PREFLIGHT_BLOCKED`, `RUN_WORKSPACE_ALLOCATION_FAILED`,
`RUN_INVOCATION_FAILED`, `RUN_VERIFICATION_FAILED`,
`RUN_PROMOTION_REFUSED`, `RUN_CANCELLED`, and `RUN_INTERNAL_ERROR`.

## Ordinary-work boundaries

Agents on the **v2 path** use `build`, `self-test` and `doctor`, and read v2 evidence from
the session JSON and `receipts.ndjson`. Agents on the retained **v1 path** use `run`,
`self-test`, `doctor` and `inspect`.

CORRECTED 2026-09-09: this paragraph previously said "do not use `ikbi build` as a second
runner" and directed every agent to `run`. That was written when v1 was the only engine and
it is now backwards — `build` is the canonical engine and `run --spec` is the legacy one.
The instruction was actively steering new integrations onto the legacy path.

Do not directly mutate ikbi state/receipt files, manually delete a retained workspace, or
enable `*_TRUSTED_LOCAL` overrides to bypass a failed capability check. Use
`doctor --fix`, workspace discard, kill-switch recovery, and other mutating
operator commands only when the returned recovery action explicitly calls for
them and the operator has authorized that action.

For the full configuration and security model, see [INSTALL.md](INSTALL.md),
[SECURITY.md](../SECURITY.md), and [RELEASE-CONTRACT.md](RELEASE-CONTRACT.md).
