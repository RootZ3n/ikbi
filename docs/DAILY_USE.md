# ikbi — Daily Use Guide

Practical reference for running builds, inspecting results, and recovering from failures.

## Safe first tasks

Start with low-risk, targeted changes. ikbi's verifier gates promotion on a real check
pass, but the safest targets are repos with a fast, reliable test suite.

Good first tasks:

```sh
# Fix a specific failing test
ikbi build "fix the failing test in src/utils/calculate.ts" --repo /path/to/repo

# Add a missing type annotation the compiler flagged
ikbi build "fix the TypeScript error on line 42 of src/api/handler.ts" --repo /path/to/repo

# Update a stale dependency version in package.json
ikbi build "bump lodash to 4.17.21 in package.json" --repo /path/to/repo
```

Avoid broad, underspecified goals for first runs. `"refactor everything"` is harder to
verify and recover from than `"rename the processPayment function to handlePayment"`.

## Watching a build as it runs

Use `--verbose` to stream per-role progress to stdout:

```sh
ikbi build "fix the import error" --repo /path/to/repo --verbose
```

Output:

```
  → run started (workspace ws-a1b2c3)
  → scout … (reading)
  ✓ scout: success (planning)
  → builder … (editing)
    builder: 4 tool round(s), 2 file(s) written
  ✓ builder: success (editing)
  → critic … (reviewing)
  ✓ critic: success (reviewing)
  → verifier … (verifying)
    verify: pass [impact] (test ✓, build ✓)
  ✓ verifier: success (verifying)
  → integrator … (promoting)
  ✓ integrator: success (promoting)
  ✓ run complete (promoted=true)
```

Each phase label tells you what the role is doing:
- **reading** — scout reads the codebase to understand the problem
- **planning** — scout produces the build plan
- **editing** — builder writes the fix
- **reviewing** — critic checks the change for correctness
- **verifying** — verifier runs your checks (tests, typecheck, etc.)
- **promoting** — integrator merges the verified change

## Inspecting what ikbi did

### See the diff

```sh
# Show the git diff for a specific workspace
ikbi diff <workspace-id>

# The workspace ID is printed at the end of a build, or find it with:
ikbi workspace ls
```

The diff shows base..scratch — exactly what the builder changed — plus a summary line
like `Δ 2 files changed, +14/-3`.

### Read the receipts

```sh
ikbi receipts               # recent builds (most-recent last)
ikbi receipts --latest      # most recent build receipt
ikbi receipts --task <id>   # full trail for one task (all roles)
ikbi receipts --failures    # only failed builds
```

Each receipt records: what ran, which role, the outcome, the verification verdict,
cost, and the workspace ID. See [docs/RECEIPTS.md](RECEIPTS.md) for field details.

### Cost breakdown

```sh
# Add --cost to a build to see per-role cost at the end:
ikbi build "fix the bug" --repo /path/to/repo --cost

# Or query historical costs:
ikbi cost                   # last 7 days
ikbi cost --days 30         # last 30 days
ikbi cost --task <id>       # one task
```

## Undoing a promotion

If ikbi promoted a change you want to revert:

```sh
# Preview what undo will do (always shown before reverting):
ikbi undo --latest           # undo the most recent promotion

# Or target a specific build by receipt ID:
ikbi receipts --latest       # find the receipt ID
ikbi undo <receipt-id>

# Undo by commit SHA if you know it:
ikbi undo <commit-sha>
```

Undo is a CAS (compare-and-swap) reset: it refuses if the branch has moved on since
the promote (someone else pushed). It also records the undo as a new receipt with a
`corrects` pointer to the original, so the audit trail stays intact.

If undo is blocked because the branch has diverged:

```sh
# Check what's on the branch now:
git -C /path/to/repo log --oneline -5 origin/main

# If safe to reset, do it manually — or just apply another ikbi build on top:
ikbi build "revert the change from <receipt-id>" --repo /path/to/repo
```

## Configuring checks for different repos

ikbi auto-detects the check runner from `package.json` scripts. For non-JS repos or
custom runners, set `IKBI_CHECKS`:

```sh
# Python project:
export IKBI_CHECKS='[{"name":"test","command":"python3","args":["-m","pytest"]}]'

# Multiple checks (build then test):
export IKBI_CHECKS='[{"name":"build","command":"make"},{"name":"test","command":"make","args":["test"]}]'

# Go project:
export IKBI_CHECKS='[{"name":"test","command":"go","args":["test","./..."]}]'

# Then run the build:
ikbi build "fix the failing assertion" --repo /path/to/repo
```

`IKBI_CHECKS` is a JSON array of `{name, command, args?}` objects. Put it in your
`.env` so you don't have to export it every time.

You also need to allowlist the binaries the verifier can run:

```sh
# .env or environment:
IKBI_GOVERNED_EXEC_ALLOWLIST=python3,make,go   # comma-separated
```

Without the allowlist, the verifier's governed-exec sandbox will block the command
and the build will fail closed (RED) — not silently pass.

## Handling failed verification

When the verifier returns RED:

```sh
# See exactly what failed:
ikbi receipts --latest          # shows verdict + which checks failed

# See the change that failed:
ikbi diff <workspace-id>

# The workspace is retained — you can inspect it:
ikbi workspace ls               # find the retained workspace
```

Common causes and fixes:

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `RED: no checks configured` | Auto-detection failed | Set `IKBI_CHECKS` |
| `RED: governed-exec blocked` | Binary not in allowlist | Add to `IKBI_GOVERNED_EXEC_ALLOWLIST` |
| `RED: tests failed` | Builder introduced a regression | Inspect diff, re-run with more context in the goal |
| `RED: typecheck failed` | Type error in generated code | Add TypeScript specifics to the goal |
| Workspace stuck in `allocated` | Build was interrupted (Ctrl-C) | `ikbi workspace discard <id>` |

If a build consistently fails verification, try narrowing the goal or adding more
context:

```sh
# Too broad — hard to verify:
ikbi build "refactor the auth module" --repo /path

# More precise — easier to verify:
ikbi build "extract validateToken from auth.ts into a separate function; tests in auth.test.ts" --repo /path
```

## Cleaning workspaces

Workspaces accumulate — promoted ones hold the workspace record even after the
worktree is gone, and failed/interrupted builds leave retained worktrees on disk.

```sh
# List all workspaces:
ikbi workspace ls

# Discard a specific workspace (removes its worktree if still present):
ikbi workspace discard <workspace-id>

# Dry-run bulk clean (shows what would be removed):
ikbi workspace clean

# Apply the clean:
ikbi workspace clean --apply

# Force-sweep retained workspaces too (normally preserved):
ikbi workspace clean --apply --force

# Reclaim orphaned worktrees only (retained work is always preserved):
ikbi clean
```

The `ikbi workspace clean` command operates on terminal workspaces (promoted, failed,
discarded). Retained workspaces — builds interrupted with Ctrl-C — are preserved until
you explicitly `--force` or `discard` them.

## Common error messages

| Message | Meaning | Action |
| ------- | ------- | ------ |
| `IKBI_WORKER_MODEL_ENABLED is false` | Build master switch is off | Set `IKBI_WORKER_MODEL_ENABLED=true` |
| `IKBI_OPERATOR_TOKEN is required` | No operator identity configured | Set `IKBI_OPERATOR_TOKEN` (32+ chars) |
| `IKBI_WORKER_TOKEN is required` | No worker identity configured | Set `IKBI_WORKER_TOKEN` (32+ chars) |
| `trust preload rejected N doc(s)` | Trust state was tampered with | Delete `state/trust/` and restart |
| `gate denied: insufficient trust` | Worker trust tier too low | Run more builds to earn trust, or reset |
| `workspace <id> not found` | Stale ID after clean | Use `ikbi workspace ls` to find current IDs |
| `egress blocked: host not in allowlist` | Model call blocked by egress guard | Add the model API host to `IKBI_EGRESS_ALLOWLIST` |
| `governed-exec blocked: binary not in allowlist` | Verifier can't run your checks | Add binary to `IKBI_GOVERNED_EXEC_ALLOWLIST` |
| `--delegation: invalid envelope` | Malformed delegation JSON from Pehlichi | Check the JSON structure; required fields: `goal`, `targetRepo` |

## Tips

- **Use `--verbose` on first runs** in a new repo. You'll see exactly which checks the
  verifier finds and whether they pass before the build promotes anything.

- **Check `ikbi doctor` first** if a build fails early with a config error. It shows
  every missing piece and usually tells you exactly what to set.

- **Workspace IDs** appear in the build summary JSON at the end of every run. Copy and
  paste into `ikbi diff <id>` to review the change immediately.

- **The `.env` file** in the project root is auto-loaded by the CLI. Keep your
  `IKBI_*` tokens there so you don't have to export them every session.

- **SIGINT is safe.** Pressing Ctrl-C during a build retains the in-progress workspace
  (the partial work is preserved on disk). Inspect it with `ikbi workspace ls` and
  `ikbi diff <id>`. Ctrl-C a second time force-quits immediately.
