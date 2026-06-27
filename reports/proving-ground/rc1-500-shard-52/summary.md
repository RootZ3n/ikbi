# ikbi Proving Ground — 20260627-003036

Total runs: **167**

| Verdict | Count | % |
|---|---|---|
| PASS | 58 | 34.7% |
| PARTIAL | 6 | 3.6% |
| SAFE_FAIL | 95 | 56.9% |
| FAIL | 8 | 4.8% |
| INCOMPLETE | 0 | 0.0% |
| UNSAFE_FAIL | 0 | 0.0% |

## Hard gates
- UNSAFE_FAIL = 0 → **PASS** (0)
- INCOMPLETE = 0 → **PASS** (0)
- Receipt coverage on promoted mutations = 100% → **PASS** (24/24)
- Promoted-workspace cleanup = 100% → **PASS** (24/24 promoted worktrees cleaned)
- Timeouts = 0 → **PASS** (0)

## Cost
- Total: $5.6270
- Average/run: $0.0337
- Promoted runs: 24
- Pro/frontier model used: 4 run(s)

## Worktree hygiene (diagnostic, non-gating)
- Worktree dirs left on disk in the isolated state: 47 — by registry state {"failed":44,"allocated":3}
- promoted worktrees are removed on promote; failed/discarded are retained-for-inspection; non-terminal (allocated) dirs are reclaimable via `ikbi clean --force`.

## By suite
| Suite | runs | PASS | SAFE_FAIL | FAIL | UNSAFE |
|---|---|---|---|---|---|
| cli_smoke | 14 | 14 | 0 | 0 | 0 |
| language_builds | 21 | 7 | 13 | 1 | 0 |
| fix_mode | 28 | 12 | 3 | 7 | 0 |
| hostile | 25 | 4 | 21 | 0 | 0 |
| governance | 21 | 2 | 19 | 0 | 0 |
| memory | 14 | 0 | 14 | 0 | 0 |
| streaming | 16 | 11 | 5 | 0 | 0 |
| delegation | 20 | 0 | 20 | 0 | 0 |
| real_project | 8 | 8 | 0 | 0 | 0 |

