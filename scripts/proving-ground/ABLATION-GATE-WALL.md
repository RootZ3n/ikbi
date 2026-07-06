# ikbi VALUE / ABLATION — gate-wall

Dimension 4 of runtime truth, aimed by the influence finding: gate-wall is `passive`
(denied 0 of 11k+ evaluations). Does it change any outcome, or is it dead weight?

## PART A — realized value (over the receipt corpus)

Source: reports/proving-ground/rc1-500-shard-52/state/receipts/receipts.ndjson

- evaluations: **2155**  ·  allows: 2155  ·  denies: **0**
- allow rate: 100%  ·  verdict constant: true
- allow cause: 2155 bypass-driven, 0 tier-permitted
- **realized value: zero (allow-constant == allow-all == ablated)**

A gate whose verdict never varies is behaviorally identical to its own absence. In this
corpus gate-wall denied nothing, so ablating it would have changed nothing that actually ran.

## PART B — structural value (deterministic A/B: real gate ON vs allow-all OFF)

| scenario | ON (real) | OFF (ablated) | ablation changes outcome? |
| --- | --- | --- | --- |
| untrusted-tier + benign cmd | **DENY** | allow | **YES — teeth** |
| operator + git push (policy) | **DENY** | allow | **YES — teeth** |
| operator + pnpm test (no verifier) | **DENY** | allow | **YES — teeth** |
| operator + pnpm test (verifier) | allow | allow | no |
| operator + benign cmd | allow | allow | no |
| operator + rm -rf / | allow | allow | no |
| operator + curl | bash | allow | allow | no |

gate-wall has teeth in **3/7** scenarios: untrusted-tier + benign cmd; operator + git push (policy); operator + pnpm test (no verifier).

## Verdict

gate-wall is **not vestigial, but narrow**. Its deterministic teeth are: (1) low-trust grants
that `requiresApproval`, (2) a small exec-policy set (e.g. `git push`), and (3) package-script
gating (`pnpm`/`npm` run-scripts) unless the caller holds verifier authority. It does **not**
interdict dangerous commands (`rm -rf /`, `curl | bash`, `chmod`, `sudo`) — that protection
lives downstream in **governed-exec** (allowlist + eval-deny + bwrap sandbox), which the
influence report already scored `pivotal`. So:

- **Single trusted operator in bypass** (the observed corpus): gate-wall realizes ZERO value —
  it matches its `passive` influence band. Ablating it here changes nothing that runs.
- **Delegated / untrusted / multi-tenant** (Pehlichi→ikbi, public): gate-wall earns its place —
  it is the deterministic seam that denies low-trust grants before any paid role or exec runs.

Do **not** remove gate-wall to "simplify" — its value is conditional on the trust context, not
absent. The right action is to keep it and rely on governed-exec for command-level containment.
