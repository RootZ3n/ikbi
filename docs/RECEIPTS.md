# ikbi — Receipt System

Receipts are ikbi's durable operational log. Every build, role result, promote, and undo
is recorded as a receipt. They exist for troubleshooting and audit — not as a
cryptographic ledger.

## What receipts are

A receipt answers: *what ran, by whom, with what outcome, and what changed?*

Every receipt is:

- **Attributed** — carries the identity (`agentId`) of who performed the operation
- **Ordered** — has a monotonic `seq` number and an append-only log position
- **Durable** — written to disk before the operation is considered complete
- **Retention-bounded** — oldest receipts are pruned when the log exceeds the configured
  limit (`IKBI_RECEIPT_RETENTION_MAX`, default 1000)

Receipts are operational data. They are NOT a cryptographic audit trail — they can be
pruned, they are append-only (corrections are new records), and the most recent receipts
may not survive a hard crash (the log is not fsync'd on every write by default).

## How to view receipts

```sh
# Recent receipts (most-recent last, default limit 20):
ikbi receipts

# Most recent build receipt:
ikbi receipts --latest

# All receipts for one task (all roles in one build):
ikbi receipts --task <task-id>

# Only failed builds:
ikbi receipts --failures

# Limit the result set:
ikbi receipts --limit 50

# Check receipt integrity (seq numbers sequential, no gaps):
ikbi receipts verify
```

### What you see

```
[seq 42]  2026-01-15T10:23:01.000Z  worker.run.summary  success
  agent:  worker-1
  task:   t-abc123
  workspace: ws-def456
  promoted: true
  cost:   $0.0031
  verif:  pass [impact]

[seq 41]  2026-01-15T10:22:58.000Z  worker.role.result  success
  agent:  worker-1
  role:   verifier
  verdict: pass
  checks: test ✓, build ✓
```

## Verifying receipt integrity

```sh
ikbi receipts verify
```

This checks that:
1. Sequence numbers are consecutive with no gaps
2. The log is append-only (no deletions)

It does **not** verify cryptographic signatures — receipts are not signed. Use `verify`
to detect accidental truncation or corruption, not adversarial tampering.

Output:

```
receipts: OK (42 receipts, seq 0..41, no gaps)
```

Or if there's a gap:

```
receipts: gap detected at seq 7 (found seq 8 after seq 5) — log may be corrupt
```

## Receipt fields

| Field | Type | Meaning |
| ----- | ---- | ------- |
| `id` | string | Unique receipt identifier (UUID) |
| `seq` | number | Monotonic sequence number (0-based); stable ordering for troubleshooting |
| `timestamp` | number | Unix milliseconds when the receipt was written |
| `operation` | string | What happened (see operation types below) |
| `outcome.status` | string | `"success"` or `"failure"` |
| `outcome.reason` | string? | Human-readable failure reason (only on failure) |
| `agentId` | string | Identity that performed the operation |
| `requestId` | string? | Correlation ID tying the receipt to an operation context |
| `project` | string? | Repo/workspace this operation belongs to |
| `changes` | array? | What changed (the reversibility hook used by `ikbi undo`) |
| `metadata` | object? | Free-form correlation data — never secrets |
| `corrects` | string? | Receipt ID this corrects (undo records point back to the original) |

## Operation types

| Operation | When written |
| --------- | ------------ |
| `worker.run.summary` | End of a build pipeline (promoted or discarded) |
| `worker.role.result` | End of each role (scout, builder, critic, verifier, integrator) |
| `workspace.promote` | Workspace promoted (merge committed to target branch) |
| `workspace.discard` | Workspace discarded (worktree removed) |
| `workspace.undo` | Undo of a promoted change |
| `model.invoke` | Model API call (role model invocations) |
| `worker.tool_call_stalled` | A builder stream stalled mid tool-call — the partial call was NOT executed (redacted: tool name + partial-arg byte count only) |
| `chat.tool_call_stalled` | A chat (REPL) stream stalled mid tool-call — the partial call was NOT executed |
| `chat.finish_reason_flagged` | A chat round finished with a flagged reason (e.g. `content_filter`, truncation) — output may be incomplete; the finishReason is in `metadata` |

> **Mission Control note:** the three rows above were added in the RC-1 hardening pass.
> They are ordinary append-only receipts (`outcome.status: "partial"`, no `changes`), so any
> reader that tolerates unknown `operation` strings is unaffected; dashboards that enumerate
> operations may want to add these to their legend.

## The `changes` array (reversibility hook)

The `changes` array is how `ikbi undo` knows how to revert a change. Each entry:

| Field | Meaning |
| ----- | ------- |
| `kind` | `"state"` for git ref changes, `"file"` for file mutations |
| `target` | Resource identifier — e.g. `"<repo>#<branch>"` for a git ref |
| `before` | State before the operation (e.g. `{ref: "<sha>"}`) |
| `after` | State after the operation |
| `inverse` | What undo should do (operation + args) |

For a promote, the change records `before.ref` and `after.ref`. `ikbi undo` performs a
CAS (compare-and-swap) reset from `after.ref` back to `before.ref`, refusing if the
branch has moved on.

## Querying by task ID

A build produces multiple receipts: one per role, plus a summary receipt. They all share
the same `requestId` (the task ID):

```sh
ikbi receipts --task t-abc123
```

This shows the full trail for one build in chronological order:
1. `worker.role.result` for scout
2. `worker.role.result` for builder
3. `worker.role.result` for critic
4. `worker.role.result` for verifier
5. `worker.role.result` for integrator
6. `worker.run.summary` (the overall result)
7. `workspace.promote` (if promoted) or `workspace.discard` (if discarded)

## Cost in receipts

The build summary receipt carries `metadata.costUsd` — the total cost of the build in
USD across all model invocations. Use `ikbi cost` to aggregate across builds:

```sh
ikbi cost                  # last 7 days, grouped by task
ikbi cost --days 30        # longer window
ikbi cost --task t-abc123  # one specific task
```

## Retention

Receipts are pruned automatically at CLI startup when the count exceeds
`IKBI_RECEIPT_RETENTION_MAX` (default 1000). Oldest receipts are removed first.
Pruning is non-fatal — a pruning failure does not block the build.

To keep more or fewer receipts:

```sh
# .env:
IKBI_RECEIPT_RETENTION_MAX=5000   # keep last 5000 receipts
```
