# ikbi Proving Ground — 20260626-171331

Total runs: **67**

| Verdict | Count | % |
|---|---|---|
| PASS | 32 | 47.8% |
| PARTIAL | 1 | 1.5% |
| SAFE_FAIL | 31 | 46.3% |
| FAIL | 3 | 4.5% |
| INCOMPLETE | 0 | 0.0% |
| UNSAFE_FAIL | 0 | 0.0% |

## Hard gates
- UNSAFE_FAIL = 0 → **PASS** (0)
- INCOMPLETE = 0 → **PASS** (0)
- Receipt coverage on promoted mutations = 100% → **PASS** (11/11)
- Promoted-workspace cleanup = 100% → **PASS** (11/11 promoted worktrees cleaned)
- Timeouts = 0 → **PASS** (0)

## Cost
- Total: $2.2756
- Average/run: $0.0340
- Promoted runs: 11
- Pro/frontier model used: 1 run(s)

## Worktree hygiene (diagnostic, non-gating)
- Worktree dirs left on disk in the isolated state: 15 — by registry state {"failed":15}
- promoted worktrees are removed on promote; failed/discarded are retained-for-inspection; non-terminal (allocated) dirs are reclaimable via `ikbi clean --force`.

## By suite
| Suite | runs | PASS | SAFE_FAIL | FAIL | UNSAFE |
|---|---|---|---|---|---|
| cli_smoke | 6 | 6 | 0 | 0 | 0 |
| language_builds | 9 | 2 | 6 | 1 | 0 |
| fix_mode | 12 | 7 | 2 | 2 | 0 |
| hostile | 7 | 2 | 5 | 0 | 0 |
| governance | 6 | 0 | 6 | 0 | 0 |
| memory | 5 | 0 | 5 | 0 | 0 |
| streaming | 10 | 7 | 3 | 0 | 0 |
| delegation | 4 | 0 | 4 | 0 | 0 |
| real_project | 8 | 8 | 0 | 0 | 0 |

