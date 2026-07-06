# gate-wall INFLUENCE PROOF (bypass OFF)

Driving the REAL gate-wall with `IKBI_GATE_WALL_BYPASS=false` over a mixed-trust workload,
then running the influence analyzer on the authentic `gate.evaluate` receipts.

- gate evaluations: **59**  ·  denials: **21**
- influence band: **pivotal**  ·  interventions: 21/59 (36%)

## Why this matters

On the observed (bypassed, operator-tier) corpora gate-wall scored `passive` — 0 denials. That
was ACCURATE, not a blind spot: with bypass OFF and untrusted/policy-denied actions present, the
SAME influence harness scores gate-wall **pivotal**. The measurement tracks
real steering; gate-wall's value is conditional on the trust context (delegated/multi-tenant),
exactly as the value/ablation verdict concluded.
