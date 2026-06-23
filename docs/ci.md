# ikbi in CI

ikbi is built to run unattended. The same governed build/repair engine you drive
interactively (`ikbi repl`) runs headless in a pipeline, promotes only on a
ladder-verified pass, and emits machine-readable output for your scripts to act on.

This guide shows real pipeline configs and the flags that matter in automation.

## The headless contract

The CI-facing command is `ikbi build`:

```bash
ikbi build "<goal>" --headless --quiet --json
```

| Flag | Why it matters in CI |
| --- | --- |
| `--headless` | Non-interactive: never prompts, never opens the REPL. Required in CI. |
| `--quiet` | Suppresses progress chatter; only the final result is written. |
| `--json` | Emits a single machine-readable JSON object to stdout (parse this). |
| `--max-budget-usd <n>` | Hard spend ceiling — the run aborts rather than exceed it. |
| `--repo <path>` | Target repo (defaults to the working directory). |
| `--from-pr <n>` | Seed the goal from a GitHub pull request. |

ikbi exits non-zero when the build does not promote (verification failed, budget
exceeded, or a refusal), so a plain `ikbi build ...` already gates a pipeline step.
Parse `--json` when you need detail.

> ikbi needs at least one provider API key. In CI, set it as a secret —
> `IKBI_ANTHROPIC_API_KEY`, `IKBI_DEEPSEEK_API_KEY`, `IKBI_OPENROUTER_API_KEY`, … —
> never commit it. Run `ikbi doctor` as a pre-flight to confirm configuration.

## GitHub Actions

```yaml
# .github/workflows/ikbi.yml
name: ikbi build
on:
  workflow_dispatch:
    inputs:
      goal:
        description: "What should ikbi build/repair?"
        required: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install ikbi
        run: |
          pnpm install --frozen-lockfile
          pnpm build

      - name: Pre-flight
        env:
          IKBI_ANTHROPIC_API_KEY: ${{ secrets.IKBI_ANTHROPIC_API_KEY }}
        run: node dist/cli/index.js doctor

      - name: Build
        id: ikbi
        env:
          IKBI_ANTHROPIC_API_KEY: ${{ secrets.IKBI_ANTHROPIC_API_KEY }}
        run: |
          node dist/cli/index.js build "${{ inputs.goal }}" \
            --headless --quiet --json --max-budget-usd 2.00 \
            | tee result.json

      - name: Upload result
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ikbi-result
          path: result.json
```

### PR-triggered repair with `--from-pr`

```yaml
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  repair:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: pnpm install --frozen-lockfile && pnpm build
      - name: Repair from the PR
        env:
          IKBI_ANTHROPIC_API_KEY: ${{ secrets.IKBI_ANTHROPIC_API_KEY }}
        run: |
          node dist/cli/index.js build "address the review feedback" \
            --from-pr ${{ github.event.pull_request.number }} \
            --headless --quiet --json --max-budget-usd 1.00
```

## GitLab CI

```yaml
# .gitlab-ci.yml
stages: [build]

ikbi:
  stage: build
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "web"   # manual run with a BUILD_GOAL variable
  variables:
    BUILD_GOAL: "fix the failing tests"
  before_script:
    - corepack enable
    - pnpm install --frozen-lockfile
    - pnpm build
    - node dist/cli/index.js doctor
  script:
    - |
      node dist/cli/index.js build "$BUILD_GOAL" \
        --headless --quiet --json --max-budget-usd 2.00 \
        | tee result.json
  artifacts:
    when: always
    paths: [result.json]
  # IKBI_ANTHROPIC_API_KEY is set as a masked, protected CI/CD variable in
  # Settings → CI/CD → Variables (never inline it here).
```

## Parsing `--json` output

`--json` writes one JSON object to stdout. A robust script reads the exit code
first (non-zero = did not promote), then inspects the payload for detail:

```bash
set -euo pipefail

if node dist/cli/index.js build "$GOAL" --headless --quiet --json > result.json; then
  echo "ikbi promoted a change"
else
  echo "ikbi did not promote (see result.json)"
fi

# Pull fields out with jq:
jq -r '.outcome'        result.json   # e.g. promoted | refused | failed
jq -r '.costUsd // 0'   result.json   # spend for this run
jq -r '.workspace // ""' result.json  # retained workspace id, if any
```

Keep stdout clean for the parser: `--quiet` routes status/diagnostic lines to
stderr (and logs are silent by default unless you pass `--verbose`/`--debug` or
set `IKBI_LOG_LEVEL`), so `> result.json` captures only the JSON object.

## Controlling cost

- `--max-budget-usd <n>` is a hard ceiling: ikbi aborts before exceeding it, so a
  runaway loop can never surprise your bill. Set it on every CI invocation.
- Pick a cheaper model profile for CI. `ikbi models --recommend` lists blessed
  Budget / Balanced / Max-Quality / Local profiles; set `IKBI_BUILDER_MODEL` and
  `IKBI_CRITIC_MODEL` in the job environment, or run `ikbi models --set-recommend <n>`
  in a setup step.
- Inspect spend after the fact with `ikbi cost`, or read `.costUsd` from `--json`.

## Common pitfalls

| Symptom | Cause | Fix |
| --- | --- | --- |
| `No API key found …` | No provider key in the job env | Set `IKBI_<PROVIDER>_API_KEY` as a CI secret; verify with `ikbi doctor`. |
| The job hangs | Missing `--headless` (it opened the REPL waiting on stdin) | Always pass `--headless` in CI. |
| `result.json` won't parse | Progress text mixed into stdout | Add `--quiet`; don't add `--verbose`/`--debug`. |
| Build never promotes | Verification ladder failed | Read `--json` (`.outcome`, `.failure`); inspect the retained workspace with `ikbi workspace ls` / `ikbi diff <id>`. |
| Surprise spend | No budget ceiling | Add `--max-budget-usd <n>`. |
| `ikbi: command not found` | Not installed on PATH | Invoke `node dist/cli/index.js …`, or run `ikbi setup` to install a launcher. |

## See also

- `ikbi help build` — the full flag reference for the build command.
- `ikbi doctor` — pre-flight configuration check (run it first in CI).
- `ikbi models --recommend` — pick a cost/quality profile for the pipeline.
