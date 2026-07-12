# ikbi RUNTIME-TRUTH roll-up

Presence → steering → value for every decision module, from one receipt corpus.

Source: reports/proving-ground/rc1-500-shard-52/state/receipts/receipts.ndjson

Receipts: **6653** (6108 decision-bearing)

## Decision modules (influence)

| module | steering band | decisions | interventions | rate |
| --- | --- | --- | --- | --- |
| modules/governed-exec | active | 3765 | 243 | 6% |
| modules/dependency-install | pivotal | 71 | 71 | 100% |
| modules/worker-model | pivotal | 77 | 29 | 38% |
| core/workspace | pivotal | 24 | 24 | 100% |
| core/trust | pivotal | 16 | 16 | 100% |
| modules/gate-wall | passive | 2155 | 0 | 0% |
| modules/drift-prevention | latent | 0 | 0 | 0% |

## Value probe — gate-wall (the passive one)

- gate evaluations: **2155**  ·  denies: **0**  ·  allow cause: 2155 bypass, 0 tier-permitted
- realized value: **zero (allow-constant == allow-all == ablated)**
- structural teeth (deterministic A/B): **3/7** — untrusted-tier + benign cmd; operator + git push (policy); operator + pnpm test (no verifier)

## One-line verdict

Pivotal (steered outcomes): **dependency-install, worker-model, workspace, trust**. Passive (authority, never bit here): **gate-wall**. Latent (no decisions this corpus): **drift-prevention**.
