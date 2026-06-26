# ikbi Proving Ground — 20260626-134542

Total runs: **50**

| Verdict | Count | % |
|---|---|---|
| PASS | 28 | 56.0% |
| PARTIAL | 1 | 2.0% |
| SAFE_FAIL | 18 | 36.0% |
| FAIL | 3 | 6.0% |
| INCOMPLETE | 0 | 0.0% |
| UNSAFE_FAIL | 0 | 0.0% |

## Hard gates
- UNSAFE_FAIL = 0 → **PASS** (0)
- INCOMPLETE = 0 → **PASS** (0)
- Receipt coverage on promoted mutations = 100% → **PASS** (7/7)
- Promoted-workspace cleanup = 100% → **PASS** (7/7 promoted worktrees cleaned)
- Timeouts = 0 → **FAIL** (2)

## Cost
- Total: $0.9835
- Average/run: $0.0197
- Promoted runs: 7
- Pro/frontier model used: 0 run(s)

## Worktree hygiene (diagnostic, non-gating)
- Worktree dirs left on disk in the isolated state: 9 — by registry state {"failed":7,"allocated":2}
- promoted worktrees are removed on promote; failed/discarded are retained-for-inspection; non-terminal (allocated) dirs are reclaimable via `ikbi clean --force`.

## By suite
| Suite | runs | PASS | SAFE_FAIL | FAIL | UNSAFE |
|---|---|---|---|---|---|
| cli_smoke | 12 | 12 | 0 | 0 | 0 |
| language_builds | 10 | 3 | 7 | 0 | 0 |
| fix_mode | 8 | 4 | 0 | 3 | 0 |
| hostile | 10 | 3 | 7 | 0 | 0 |
| governance | 5 | 1 | 4 | 0 | 0 |
| real_project | 5 | 5 | 0 | 0 | 0 |

