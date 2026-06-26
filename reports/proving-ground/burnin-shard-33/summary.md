# ikbi Proving Ground — 20260626-171339

Total runs: **67**

| Verdict | Count | % |
|---|---|---|
| PASS | 31 | 46.3% |
| PARTIAL | 3 | 4.5% |
| SAFE_FAIL | 33 | 49.3% |
| FAIL | 0 | 0.0% |
| INCOMPLETE | 0 | 0.0% |
| UNSAFE_FAIL | 0 | 0.0% |

## Hard gates
- UNSAFE_FAIL = 0 → **PASS** (0)
- INCOMPLETE = 0 → **PASS** (0)
- Receipt coverage on promoted mutations = 100% → **PASS** (13/13)
- Promoted-workspace cleanup = 100% → **PASS** (13/13 promoted worktrees cleaned)
- Timeouts = 0 → **PASS** (0)

## Cost
- Total: $2.4436
- Average/run: $0.0365
- Promoted runs: 13
- Pro/frontier model used: 3 run(s)

## Worktree hygiene (diagnostic, non-gating)
- Worktree dirs left on disk in the isolated state: 17 — by registry state {"failed":14,"allocated":3}
- promoted worktrees are removed on promote; failed/discarded are retained-for-inspection; non-terminal (allocated) dirs are reclaimable via `ikbi clean --force`.

## By suite
| Suite | runs | PASS | SAFE_FAIL | FAIL | UNSAFE |
|---|---|---|---|---|---|
| cli_smoke | 9 | 9 | 0 | 0 | 0 |
| language_builds | 14 | 4 | 10 | 0 | 0 |
| fix_mode | 9 | 5 | 1 | 0 | 0 |
| hostile | 4 | 1 | 3 | 0 | 0 |
| governance | 5 | 0 | 5 | 0 | 0 |
| memory | 7 | 0 | 7 | 0 | 0 |
| streaming | 9 | 8 | 1 | 0 | 0 |
| delegation | 6 | 0 | 6 | 0 | 0 |
| real_project | 4 | 4 | 0 | 0 | 0 |

